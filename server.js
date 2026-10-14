import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import express from "express";
import { hasValidSession, isAuthorizedMcpRequest, verifyAccessPassword, createSessionCookie } from "./auth.js";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { loadEnvFile } from "./env.js";
import { runAgent } from "./agent.js";
import { assertTimelineIntegrity } from "./fixture_integrity.js";
import { sanitizeChatContext } from "./chat_context.js";

// Load .env before any configuration is read (see env.js). Import is hoisted, but
// this call runs before the config reads below. Real env vars always win.
// DUPTRACE_ENV_FILE overrides the file path (deployments and tests).
loadEnvFile(
  process.env.DUPTRACE_ENV_FILE || fileURLToPath(new URL("./.env", import.meta.url)),
);

const supportedServices = [
  "payments",
  "auth",
  "checkout",
  "notifications",
];

const parseHostList = (value) =>
  value
    ?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);

const parseOriginHostList = (value) =>
  value
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin.includes("://") ? origin : `https://${origin}`)
          .hostname;
      } catch {
        throw new Error(`MCP_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
      }
    });

const isVercel = process.env.VERCEL === "1";
const bindHost = process.env.MCP_BIND_HOST || (isVercel ? "0.0.0.0" : "127.0.0.1");
const port = Number(process.env.PORT || 3000);
const publicUrl = process.env.MCP_PUBLIC_URL?.trim().replace(/\/+$/, "");
const authMode = process.env.MCP_AUTH_MODE || "none";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
let publicHost;

if (!["none", "oauth"].includes(authMode)) {
  throw new Error('MCP_AUTH_MODE must be "none" or "oauth"');
}

if (authMode === "oauth") {
  throw new Error(
    "MCP_AUTH_MODE=oauth is not configured; do not expose DupTrace publicly until the documented OAuth verifier is wired"
  );
}

if (!isVercel && (!loopbackHosts.has(bindHost) || publicUrl)) {
  throw new Error(
    "Unauthenticated DupTrace MCP is limited to loopback development; configure the documented OAuth boundary before public exposure"
  );
}

if (isVercel && authMode !== "none") {
  throw new Error("Vercel deployment uses the built-in password session boundary; MCP_AUTH_MODE must remain none.");
}

if (publicUrl) {
  let parsedPublicUrl;

  try {
    parsedPublicUrl = new URL(publicUrl);
  } catch {
    throw new Error("MCP_PUBLIC_URL must be a valid http or https URL");
  }

  if (!['http:', 'https:'].includes(parsedPublicUrl.protocol)) {
    throw new Error("MCP_PUBLIC_URL must use http or https");
  }

  if (parsedPublicUrl.pathname !== "") {
    throw new Error("MCP_PUBLIC_URL must be a base URL without a path");
  }

  publicHost = parsedPublicUrl.hostname;
}

const configuredAllowedHosts = parseHostList(process.env.MCP_ALLOWED_HOSTS);
const vercelHosts = isVercel
  ? [process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean)
  : [];
const allowedHosts =
  configuredAllowedHosts ??
  (isVercel
    ? [...new Set([...vercelHosts, "localhost", "127.0.0.1", "[::1]"])]
    : publicHost ? [publicHost] : ["localhost", "127.0.0.1", "[::1]"]);
const allowedOrigins = parseOriginHostList(process.env.MCP_ALLOWED_ORIGINS);

const serviceHealthSnapshots = {
  payments: {
    service: "payments",
    status: "degraded",
    availability: 99.21,
    errorRate: 18.4,
    latency: {
      p50: 180,
      p95: 920,
      p99: 1840,
    },
    window: "15m",
    comparisonWindow: "previous_15m",
    signals: [
      "5xx error rate increased 8.7x",
      "p95 latency increased 3.1x",
    ],
  },
  auth: {
    service: "auth",
    status: "healthy",
    availability: 99.99,
    errorRate: 0.03,
    latency: {
      p50: 42,
      p95: 118,
      p99: 206,
    },
    window: "15m",
    comparisonWindow: "previous_15m",
    signals: ["No notable changes from the previous window"],
  },
  checkout: {
    service: "checkout",
    status: "healthy",
    availability: 99.95,
    errorRate: 0.12,
    latency: {
      p50: 86,
      p95: 245,
      p99: 438,
    },
    window: "15m",
    comparisonWindow: "previous_15m",
    signals: [
      "5xx error rate decreased 1.4x",
      "p95 latency remained stable",
    ],
  },
  notifications: {
    service: "notifications",
    status: "degraded",
    availability: 98.72,
    errorRate: 4.6,
    latency: {
      p50: 136,
      p95: 684,
      p99: 1210,
    },
    window: "15m",
    comparisonWindow: "previous_15m",
    signals: [
      "5xx error rate increased 4.2x",
      "p95 latency increased 2.4x",
    ],
  },
};

const serviceSchema = z.enum(supportedServices, {
  error: `Unsupported service. Supported services: ${supportedServices.join(
    ", "
  )}`,
});

const serviceHealthSchema = z.object({
  service: serviceSchema,
  status: z.enum(["healthy", "degraded"]),
  availability: z.number().min(0).max(100),
  errorRate: z.number().nonnegative(),
  latency: z.object({
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    p99: z.number().nonnegative(),
  }),
  window: z.literal("15m"),
  comparisonWindow: z.literal("previous_15m"),
  signals: z.array(z.string()),
});

const incidentSeveritySchema = z.enum(["SEV-1", "SEV-2", "SEV-3", "SEV-4"]);
const incidentStatusSchema = z.enum([
  "investigating",
  "mitigated",
  "resolved",
]);
const timestampSchema = z.string().datetime({ offset: false });
const deploymentIdSchema = z.string().regex(/^DEP-[0-9]{4}-[0-9]{4}$/);
const eventIdSchema = z.string().regex(/^EVT-[0-9]{4}-[0-9]{4}$/);
const evidenceIdSchema = z.string().regex(/^EVD-[0-9]{4}-[0-9]{4}$/);

const timelineEntrySchema = z
  .object({
    id: z.string().regex(/^TL-[0-9]{4}-[0-9]{3}-[A-Z]$/),
    timestamp: timestampSchema,
    type: z.enum([
      "detection",
      "observation",
      "deployment",
      "investigation",
      "mitigation",
      "status_change",
    ]),
    summary: z.string(),
    source: z.enum(["health", "operator", "deployment", "event"]),
    deploymentId: deploymentIdSchema.nullable(),
    eventId: eventIdSchema.nullable(),
  })
  .strict();

const findingSchema = z
  .object({
    id: z.string().regex(/^FND-[0-9]{4}-[0-9]{3}$/),
    statement: z.string(),
    confidence: z.enum(["low", "medium", "high"]),
    evidenceRefs: z.array(evidenceIdSchema),
  })
  .strict();

const suspectedCauseSchema = z
  .object({
    summary: z.string(),
    confidence: z.enum(["low", "medium", "high"]),
    deploymentId: deploymentIdSchema.nullable(),
    rationale: z.string(),
    evidenceRefs: z.array(evidenceIdSchema),
  })
  .strict();

const completeIncidentSchema = z
  .object({
    id: z.string().regex(/^INC-[0-9]{4}-[0-9]{3}$/),
    service: serviceSchema,
    title: z.string(),
    severity: incidentSeveritySchema,
    status: incidentStatusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    description: z.string(),
    timeline: z.array(timelineEntrySchema),
    findings: z.array(findingSchema),
    suspectedCause: suspectedCauseSchema.nullable(),
    relatedDeploymentIds: z.array(deploymentIdSchema),
    relatedEventIds: z.array(eventIdSchema),
  })
  .strict();

const incidentSummarySchema = z
  .object({
    id: z.string().regex(/^INC-[0-9]{4}-[0-9]{3}$/),
    service: serviceSchema,
    title: z.string(),
    severity: incidentSeveritySchema,
    status: z.enum(["investigating", "mitigated"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const listActiveIncidentsInputSchema = z
  .object({
    service: serviceSchema.optional(),
  })
  .strict();

const listActiveIncidentsResponseSchema = z
  .object({
    incidents: z.array(incidentSummarySchema),
    count: z.number().int().nonnegative(),
    filter: z
      .object({
        service: serviceSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const getIncidentInputSchema = z
  .object({
    id: z.string().regex(/^INC-[0-9]{4}-[0-9]{3}$/),
  })
  .strict();

const getIncidentResponseSchema = completeIncidentSchema;

const deploymentStatusSchema = z.enum([
  "completed",
  "failed",
  "rolled_back",
]);

const deploymentSchema = z
  .object({
    id: deploymentIdSchema,
    service: serviceSchema,
    version: z.string(),
    environment: z.literal("production"),
    status: deploymentStatusSchema,
    deployedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    deployedBy: z.string(),
    changeSummary: z.string(),
    commitSha: z.string(),
    rollbackAvailable: z.boolean(),
  })
  .strict();

const deploymentSummarySchema = z
  .object({
    id: deploymentIdSchema,
    service: serviceSchema,
    version: z.string(),
    environment: z.literal("production"),
    status: deploymentStatusSchema,
    deployedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
  })
  .strict();

const listRecentDeploymentsInputSchema = z
  .object({
    service: serviceSchema.optional(),
  })
  .strict();

const listRecentDeploymentsOutputSchema = z
  .object({
    deployments: z.array(deploymentSummarySchema),
    count: z.number().int().nonnegative(),
    filter: z
      .object({
        service: serviceSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const getDeploymentInputSchema = z
  .object({
    id: deploymentIdSchema,
  })
  .strict();

const getDeploymentOutputSchema = deploymentSchema;

const eventTypeSchema = z.enum(["alert", "deployment", "health", "operator"]);
const eventSeveritySchema = z.enum([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);
const eventSourceSchema = z.enum([
  "health",
  "deployment",
  "operator",
  "system",
]);

const eventSchema = z
  .object({
    id: eventIdSchema,
    service: serviceSchema,
    type: eventTypeSchema,
    severity: eventSeveritySchema,
    occurredAt: timestampSchema,
    source: eventSourceSchema,
    summary: z.string(),
    details: z.string(),
    deploymentId: deploymentIdSchema.nullable(),
  })
  .strict();

const eventSummarySchema = z
  .object({
    id: eventIdSchema,
    service: serviceSchema,
    type: eventTypeSchema,
    severity: eventSeveritySchema,
    occurredAt: timestampSchema,
    source: eventSourceSchema,
    summary: z.string(),
    deploymentId: deploymentIdSchema.nullable(),
  })
  .strict();

const listServiceEventsInputSchema = z
  .object({
    service: serviceSchema,
  })
  .strict();

const listServiceEventsOutputSchema = z
  .object({
    events: z.array(eventSummarySchema),
    count: z.number().int().nonnegative(),
    filter: z
      .object({
        service: serviceSchema,
      })
      .strict(),
  })
  .strict();

const getEventInputSchema = z
  .object({
    id: eventIdSchema,
  })
  .strict();

const getEventOutputSchema = eventSchema;

const evidenceSourceTypeSchema = z.enum([
  "health",
  "incident",
  "deployment",
  "event",
]);
const evidenceRelationshipSchema = z.enum([
  "supports_incident",
  "temporally_adjacent",
  "supports_hypothesis",
  "contradicts_hypothesis",
  "context",
]);
const evidenceStrengthSchema = z.enum(["low", "medium", "high"]);

const evidenceSchema = z
  .object({
    id: evidenceIdSchema,
    incidentId: z.string().regex(/^INC-[0-9]{4}-[0-9]{3}$/),
    sourceType: evidenceSourceTypeSchema,
    sourceId: z.string().min(1),
    observedAt: timestampSchema,
    observation: z.string(),
    relationship: evidenceRelationshipSchema,
    strength: evidenceStrengthSchema,
  })
  .strict();

const getIncidentEvidenceInputSchema = z
  .object({
    incidentId: z.string().regex(/^INC-[0-9]{4}-[0-9]{3}$/),
  })
  .strict();

const getIncidentEvidenceOutputSchema = z
  .object({
    incidentId: z.string().regex(/^INC-[0-9]{4}-[0-9]{3}$/),
    evidence: z.array(evidenceSchema),
    count: z.number().int().nonnegative(),
  })
  .strict();

const correlationCandidateSchema = z
  .object({
    deploymentId: deploymentIdSchema,
    confidence: z.enum(["low", "medium", "high"]),
    relationship: z.literal("temporally_adjacent"),
    evidenceIds: z.array(evidenceIdSchema),
    summary: z.string(),
    reasoning: z.array(z.string()),
  })
  .strict();

const correlateIncidentInputSchema = z
  .object({
    incidentId: z.string().regex(/^INC-[0-9]{4}-[0-9]{3}$/),
  })
  .strict();

const correlateIncidentOutputSchema = z
  .object({
    incidentId: z.string().regex(/^INC-[0-9]{4}-[0-9]{3}$/),
    status: incidentStatusSchema,
    service: serviceSchema,
    candidates: z.array(correlationCandidateSchema),
  })
  .strict();

const investigationIdSchema = z.string().regex(/^INV-[0-9]{4}-[0-9]{4}$/);
const investigationStatusSchema = z.enum([
  "investigating",
  "paused",
  "completed",
]);
const investigationStageNameSchema = z.enum([
  "incident",
  "health",
  "deployments",
  "events",
  "evidence",
  "correlation",
  "explanation",
]);
const investigationStageStatusSchema = z.enum([
  "pending",
  "complete",
  "not_applicable",
]);

const investigationStageSchema = z
  .object({
    name: investigationStageNameSchema,
    status: investigationStageStatusSchema,
    completedAt: timestampSchema.nullable(),
  })
  .strict();

const investigationCheckedSchema = z
  .object({
    health: z.boolean(),
    deployments: z.boolean(),
    events: z.boolean(),
    evidence: z.boolean(),
    correlation: z.boolean(),
  })
  .strict();

const investigationSchema = z
  .object({
    id: investigationIdSchema,
    incidentId: z.string().regex(/^INC-[0-9]{4}-[0-9]{3}$/),
    status: investigationStatusSchema,
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    checked: investigationCheckedSchema,
    stages: z.array(investigationStageSchema),
    evidenceIds: z.array(evidenceIdSchema),
    candidateDeploymentIds: z.array(deploymentIdSchema),
    findingIds: z.array(z.string().regex(/^FND-[0-9]{4}-[0-9]{3}$/)),
    nextStep: z.string(),
    summary: z.string(),
  })
  .strict();

const getInvestigationInputSchema = z
  .object({
    id: investigationIdSchema,
  })
  .strict();

const getInvestigationOutputSchema = investigationSchema;

const investigationHypothesisSchema = z
  .object({
    deploymentId: deploymentIdSchema,
    confidence: z.enum(["low", "medium", "high"]),
    relationship: z.literal("temporally_adjacent"),
    causalityConfirmed: z.boolean(),
  })
  .strict();

const investigationEvidenceSummarySchema = z
  .object({
    id: evidenceIdSchema,
    observation: z.string(),
    strength: evidenceStrengthSchema,
  })
  .strict();

const explanationSchema = z
  .object({
    whatIsHappening: z.string(),
    evidence: z.array(investigationEvidenceSummarySchema),
    leadingHypothesis: investigationHypothesisSchema.nullable(),
    confidence: z.enum(["low", "medium", "high"]).nullable(),
    causalityConfirmed: z.boolean(),
    unknowns: z.array(z.string()),
    nextStep: z.string(),
  })
  .strict();

const investigationSummarySchema = z
  .object({
    investigationId: investigationIdSchema,
    incidentId: z.string().regex(/^INC-[0-9]{4}-[0-9]{3}$/),
    service: serviceSchema,
    status: investigationStatusSchema,
    severity: incidentSeveritySchema,
    summary: z.string(),
    leadingHypothesis: investigationHypothesisSchema.nullable(),
    candidateDeploymentIds: z.array(deploymentIdSchema),
    confidence: z.enum(["low", "medium", "high"]).nullable(),
    keyEvidenceIds: z.array(evidenceIdSchema),
    nextStep: z.string(),
    uncertainty: z.string(),
  })
  .strict();

const summarizeInvestigationInputSchema = getInvestigationInputSchema;
const summarizeInvestigationOutputSchema = investigationSummarySchema;

const investigateIncidentInputSchema = z
  .object({
    incidentId: z.string().regex(/^INC-[0-9]{4}-[0-9]{3}$/),
  })
  .strict();

const investigateIncidentOutputSchema = z
  .object({
    incident: completeIncidentSchema,
    health: serviceHealthSchema,
    investigation: investigationSchema,
    evidence: z.array(evidenceSchema),
    correlation: correlateIncidentOutputSchema,
    explanation: explanationSchema,
  })
  .strict();

const incidents = [
  {
    id: "INC-2026-001",
    service: "payments",
    title: "Elevated payment authorization failures",
    severity: "SEV-2",
    status: "investigating",
    createdAt: "2026-09-19T10:45:00Z",
    updatedAt: "2026-09-19T11:05:00Z",
    description:
      "Payment authorization failures and latency are elevated in the latest health window, affecting the payment path while investigation continues.",
    timeline: [
      {
        id: "TL-2026-001-A",
        timestamp: "2026-09-19T10:45:00Z",
        type: "detection",
        summary:
          "5xx error rate crossed the alert threshold and payment latency increased.",
        source: "health",
        deploymentId: null,
        eventId: "EVT-2026-0901",
      },
      {
        id: "TL-2026-001-B",
        timestamp: "2026-09-19T10:44:00Z",
        type: "deployment",
        summary:
          "A recent payments deployment was identified as a candidate for correlation.",
        source: "deployment",
        deploymentId: "DEP-2026-0142",
        eventId: "EVT-2026-0902",
      },
      {
        id: "TL-2026-001-C",
        timestamp: "2026-09-19T11:05:00Z",
        type: "investigation",
        summary:
          "The deployment remains a medium-confidence hypothesis pending event correlation.",
        source: "operator",
        deploymentId: "DEP-2026-0142",
        eventId: "EVT-2026-0903",
      },
    ],
    findings: [
      {
        id: "FND-2026-001",
        statement:
          "Payment error rate and p95 latency increased in the same 15-minute health window.",
        confidence: "high",
        evidenceRefs: ["EVD-2026-0001", "EVD-2026-0004"],
      },
      {
        id: "FND-2026-002",
        statement:
          "The candidate deployment is temporally adjacent to the observed regression, but causality is not confirmed.",
        confidence: "medium",
        evidenceRefs: [
          "EVD-2026-0002",
          "EVD-2026-0003",
          "EVD-2026-0005",
        ],
      },
    ],
    suspectedCause: {
      summary:
        "A recent payments deployment is the leading candidate for the authorization failure regression.",
      confidence: "medium",
      deploymentId: "DEP-2026-0142",
        rationale:
          "The deployment is temporally adjacent to the elevated 5xx rate and p95 latency; event correlation is required before calling it causal.",
      evidenceRefs: [
        "EVD-2026-0001",
        "EVD-2026-0002",
        "EVD-2026-0003",
        "EVD-2026-0005",
      ],
    },
    relatedDeploymentIds: ["DEP-2026-0142"],
    relatedEventIds: [
      "EVT-2026-0901",
      "EVT-2026-0902",
      "EVT-2026-0903",
    ],
  },
  {
    id: "INC-2026-002",
    service: "notifications",
    title: "Notification delivery delays",
    severity: "SEV-3",
    status: "mitigated",
    createdAt: "2026-09-19T10:20:00Z",
    updatedAt: "2026-09-19T11:00:00Z",
    description:
      "Notification delivery latency increased and a subset of messages was delayed; impact is currently contained.",
    timeline: [
      {
        id: "TL-2026-002-A",
        timestamp: "2026-09-19T10:20:00Z",
        type: "detection",
        summary:
          "Notification 5xx rate and p95 latency increased in the latest health window.",
        source: "health",
        deploymentId: null,
        eventId: "EVT-2026-0910",
      },
      {
        id: "TL-2026-002-B",
        timestamp: "2026-09-19T11:00:00Z",
        type: "mitigation",
        summary:
          "Queue pressure was reduced and delivery delays are currently contained.",
        source: "operator",
        deploymentId: null,
        eventId: "EVT-2026-0911",
      },
    ],
    findings: [
      {
        id: "FND-2026-003",
        statement:
          "Notification error rate and p95 latency are degraded, but the issue is currently contained.",
        confidence: "high",
        evidenceRefs: [],
      },
    ],
    suspectedCause: null,
    relatedDeploymentIds: [],
    relatedEventIds: ["EVT-2026-0910", "EVT-2026-0911"],
  },
];

const deployments = [
  {
    id: "DEP-2026-0142",
    service: "payments",
    version: "payments-api@2026.09.19.3",
    environment: "production",
    status: "completed",
    deployedAt: "2026-09-19T10:42:00Z",
    completedAt: "2026-09-19T10:44:00Z",
    deployedBy: "release-bot",
    changeSummary: "Updated payment authorization retry handling",
    commitSha: "a1b2c3d4e5f6",
    rollbackAvailable: true,
  },
  {
    id: "DEP-2026-0141",
    service: "payments",
    version: "payments-api@2026.09.19.2",
    environment: "production",
    status: "completed",
    deployedAt: "2026-09-19T08:30:00Z",
    completedAt: "2026-09-19T08:32:00Z",
    deployedBy: "release-bot",
    changeSummary: "Updated payment metrics instrumentation",
    commitSha: "9f8e7d6c5b4a",
    rollbackAvailable: true,
  },
  {
    id: "DEP-2026-0140",
    service: "auth",
    version: "auth-api@2026.09.19.5",
    environment: "production",
    status: "completed",
    deployedAt: "2026-09-19T09:15:00Z",
    completedAt: "2026-09-19T09:17:00Z",
    deployedBy: "release-bot",
    changeSummary: "Updated token validation caching",
    commitSha: "112233445566",
    rollbackAvailable: true,
  },
  {
    id: "DEP-2026-0139",
    service: "checkout",
    version: "checkout-api@2026.09.19.4",
    environment: "production",
    status: "completed",
    deployedAt: "2026-09-19T09:40:00Z",
    completedAt: "2026-09-19T09:42:00Z",
    deployedBy: "release-bot",
    changeSummary: "Optimized cart validation path",
    commitSha: "778899aabbcc",
    rollbackAvailable: true,
  },
  {
    id: "DEP-2026-0138",
    service: "notifications",
    version: "notifications-worker@2026.09.19.2",
    environment: "production",
    status: "completed",
    deployedAt: "2026-09-19T09:55:00Z",
    completedAt: "2026-09-19T09:57:00Z",
    deployedBy: "release-bot",
    changeSummary: "Adjusted notification batching thresholds",
    commitSha: "ddeeff001122",
    rollbackAvailable: true,
  },
];

const events = [
  {
    id: "EVT-2026-0901",
    service: "payments",
    type: "alert",
    severity: "high",
    occurredAt: "2026-09-19T10:45:00Z",
    source: "health",
    summary: "Payment 5xx error rate crossed the alert threshold",
    details:
      "Payment 5xx error rate reached 18.4% and p95 latency reached 920ms during the latest 15m health window.",
    deploymentId: null,
  },
  {
    id: "EVT-2026-0902",
    service: "payments",
    type: "deployment",
    severity: "info",
    occurredAt: "2026-09-19T10:44:00Z",
    source: "deployment",
    summary: "Payments deployment completed",
    details:
      "Deployment DEP-2026-0142 completed successfully in production.",
    deploymentId: "DEP-2026-0142",
  },
  {
    id: "EVT-2026-0903",
    service: "payments",
    type: "operator",
    severity: "medium",
    occurredAt: "2026-09-19T11:05:00Z",
    source: "operator",
    summary: "Deployment remains under investigation",
    details:
      "DEP-2026-0142 remains a candidate deployment while additional event correlation is pending.",
    deploymentId: "DEP-2026-0142",
  },
  {
    id: "EVT-2026-0910",
    service: "notifications",
    type: "alert",
    severity: "medium",
    occurredAt: "2026-09-19T10:20:00Z",
    source: "health",
    summary: "Notification delivery latency crossed the alert threshold",
    details:
      "Notification error rate and p95 latency increased during the latest health window.",
    deploymentId: null,
  },
  {
    id: "EVT-2026-0911",
    service: "notifications",
    type: "operator",
    severity: "info",
    occurredAt: "2026-09-19T11:00:00Z",
    source: "operator",
    summary: "Notification degradation contained",
    details:
      "Notification delivery delays were contained and the incident was moved to mitigated status.",
    deploymentId: null,
  },
  {
    id: "EVT-2026-0898",
    service: "payments",
    type: "deployment",
    severity: "info",
    occurredAt: "2026-09-19T08:32:00Z",
    source: "deployment",
    summary: "Payments deployment completed",
    details:
      "Deployment DEP-2026-0141 completed successfully in production.",
    deploymentId: "DEP-2026-0141",
  },
  {
    id: "EVT-2026-0899",
    service: "payments",
    type: "health",
    severity: "info",
    occurredAt: "2026-09-19T10:30:00Z",
    source: "health",
    summary:
      "Payment service health remained within expected range before alert",
    details:
      "No alert-level payment degradation was recorded before the 10:45 detection event in the deterministic event dataset.",
    deploymentId: null,
  },
  {
    id: "EVT-2026-0905",
    service: "auth",
    type: "deployment",
    severity: "info",
    occurredAt: "2026-09-19T09:17:00Z",
    source: "deployment",
    summary: "Auth deployment completed",
    details: "Deployment DEP-2026-0140 completed successfully in production.",
    deploymentId: "DEP-2026-0140",
  },
  {
    id: "EVT-2026-0906",
    service: "checkout",
    type: "deployment",
    severity: "info",
    occurredAt: "2026-09-19T09:42:00Z",
    source: "deployment",
    summary: "Checkout deployment completed",
    details: "Deployment DEP-2026-0139 completed successfully in production.",
    deploymentId: "DEP-2026-0139",
  },
  {
    id: "EVT-2026-0907",
    service: "notifications",
    type: "deployment",
    severity: "info",
    occurredAt: "2026-09-19T09:57:00Z",
    source: "deployment",
    summary: "Notifications deployment completed",
    details:
      "Deployment DEP-2026-0138 completed successfully in production.",
    deploymentId: "DEP-2026-0138",
  },
];

const healthEvidenceSourceIds = new Set([
  "payments-health-2026-09-19-15m",
  "notifications-health-2026-09-19-15m",
  "auth-health-2026-09-19-15m",
  "checkout-health-2026-09-19-15m",
]);

const evidence = [
  {
    id: "EVD-2026-0001",
    incidentId: "INC-2026-001",
    sourceType: "health",
    sourceId: "payments-health-2026-09-19-15m",
    observedAt: "2026-09-19T10:45:00Z",
    observation:
      "Payment 5xx error rate reached 18.4% and p95 latency reached 920ms during the latest 15m health window.",
    relationship: "supports_incident",
    strength: "high",
  },
  {
    id: "EVD-2026-0002",
    incidentId: "INC-2026-001",
    sourceType: "deployment",
    sourceId: "DEP-2026-0142",
    observedAt: "2026-09-19T10:44:00Z",
    observation:
      "Deployment DEP-2026-0142 completed successfully in production one minute before the recorded payment health alert.",
    relationship: "temporally_adjacent",
    strength: "medium",
  },
  {
    id: "EVD-2026-0003",
    incidentId: "INC-2026-001",
    sourceType: "event",
    sourceId: "EVT-2026-0902",
    observedAt: "2026-09-19T10:44:00Z",
    observation:
      "EVT-2026-0902 records successful completion of DEP-2026-0142 in production.",
    relationship: "temporally_adjacent",
    strength: "medium",
  },
  {
    id: "EVD-2026-0004",
    incidentId: "INC-2026-001",
    sourceType: "event",
    sourceId: "EVT-2026-0901",
    observedAt: "2026-09-19T10:45:00Z",
    observation:
      "EVT-2026-0901 records that the payment 5xx error rate crossed the alert threshold.",
    relationship: "supports_incident",
    strength: "high",
  },
  {
    id: "EVD-2026-0005",
    incidentId: "INC-2026-001",
    sourceType: "event",
    sourceId: "EVT-2026-0903",
    observedAt: "2026-09-19T11:05:00Z",
    observation:
      "EVT-2026-0903 records that DEP-2026-0142 remained under investigation while additional event correlation was pending.",
    relationship: "supports_hypothesis",
    strength: "medium",
  },
  {
    id: "EVD-2026-0006",
    incidentId: "INC-2026-001",
    sourceType: "deployment",
    sourceId: "DEP-2026-0141",
    observedAt: "2026-09-19T08:32:00Z",
    observation:
      "Deployment DEP-2026-0141 completed at 08:32 UTC, substantially earlier than the 10:45 payment health alert.",
    relationship: "context",
    strength: "low",
  },
  {
    id: "EVD-2026-0010",
    incidentId: "INC-2026-002",
    sourceType: "event",
    sourceId: "EVT-2026-0910",
    observedAt: "2026-09-19T10:20:00Z",
    observation:
      "EVT-2026-0910 records increased notification delivery latency and an alert condition.",
    relationship: "supports_incident",
    strength: "high",
  },
  {
    id: "EVD-2026-0011",
    incidentId: "INC-2026-002",
    sourceType: "event",
    sourceId: "EVT-2026-0911",
    observedAt: "2026-09-19T11:00:00Z",
    observation:
      "EVT-2026-0911 records that notification delivery delays were contained and the incident moved to mitigated status.",
    relationship: "supports_incident",
    strength: "high",
  },
];

const assertEvidenceFixtureIntegrity = () => {
  for (const record of evidence) {
    const incident = incidents.find(
      (candidate) => candidate.id === record.incidentId
    );

    if (!incident) {
      throw new Error(`Evidence ${record.id} references an unknown incident`);
    }

    if (record.sourceType === "health") {
      if (!healthEvidenceSourceIds.has(record.sourceId)) {
        throw new Error(`Evidence ${record.id} references an unknown health source`);
      }

      continue;
    }

    if (record.sourceType === "incident") {
      if (!incidents.some((candidate) => candidate.id === record.sourceId)) {
        throw new Error(`Evidence ${record.id} references an unknown incident source`);
      }

      continue;
    }

    if (record.sourceType === "deployment") {
      const deployment = deployments.find(
        (candidate) => candidate.id === record.sourceId
      );

      if (!deployment || deployment.service !== incident.service) {
        throw new Error(`Evidence ${record.id} references an invalid deployment`);
      }

      if (record.observedAt !== deployment.completedAt) {
        throw new Error(`Evidence ${record.id} has an invalid deployment timestamp`);
      }

      continue;
    }

    const event = events.find((candidate) => candidate.id === record.sourceId);

    if (!event || event.service !== incident.service) {
      throw new Error(`Evidence ${record.id} references an invalid event`);
    }

    if (record.observedAt !== event.occurredAt) {
      throw new Error(`Evidence ${record.id} has an invalid event timestamp`);
    }
  }

  for (const incident of incidents) {
    for (const finding of incident.findings) {
      for (const evidenceId of finding.evidenceRefs) {
        if (!evidence.some((record) => record.id === evidenceId)) {
          throw new Error(`Finding ${finding.id} references unknown evidence`);
        }
      }
    }

    for (const evidenceId of incident.suspectedCause?.evidenceRefs ?? []) {
      if (!evidence.some((record) => record.id === evidenceId)) {
        throw new Error(
          `Incident ${incident.id} suspected cause references unknown evidence`
        );
      }
    }
  }

  // Timeline entries that cite an event must reference a real event and carry
  // that event's exact occurredAt (catches drift like TL-2026-001-B vs EVT-2026-0902).
  assertTimelineIntegrity(incidents, events);
};

assertEvidenceFixtureIntegrity();

const investigationFixtures = [
  {
    id: "INV-2026-0001",
    incidentId: "INC-2026-001",
    status: "investigating",
    whatIsHappening:
      "Payment authorization failures and latency are elevated in the latest health window.",
    nextStep:
      "Review DEP-2026-0142 and its related payment operational events for a direct failure signal.",
    summary:
      "Payment authorization failures and latency are elevated; DEP-2026-0142 is the leading deployment hypothesis.",
    keyEvidenceIds: ["EVD-2026-0001", "EVD-2026-0002", "EVD-2026-0005"],
  },
  {
    id: "INV-2026-0002",
    incidentId: "INC-2026-002",
    status: "completed",
    whatIsHappening:
      "Notification delivery latency increased and a subset of messages was delayed; impact is currently contained.",
    nextStep:
      "Review notification delivery events for a direct failure signal before forming a cause hypothesis.",
    summary:
      "Notification delivery delays are mitigated; no deployment meets the deterministic correlation criteria.",
    keyEvidenceIds: ["EVD-2026-0010", "EVD-2026-0011"],
  },
];

const getIncidentData = (incidentId) =>
  incidents.find((incident) => incident.id === incidentId);

const getIncidentEvidenceData = (incidentId) =>
  evidence
    .filter((record) => record.incidentId === incidentId)
    .sort((left, right) => {
      const timeDifference = left.observedAt.localeCompare(right.observedAt);
      return timeDifference || left.id.localeCompare(right.id);
    });

const correlateIncidentData = (incident) => {
  const health = serviceHealthSnapshots[incident.service];
  const detection = incident.timeline.find((entry) => entry.type === "detection");
  const detectionTime = detection ? Date.parse(detection.timestamp) : Number.NaN;
  const serviceEvents = events.filter((event) => event.service === incident.service);
  const incidentEvidence = getIncidentEvidenceData(incident.id);
  const candidateDeployments = deployments
    .filter((deployment) => {
      if (
        deployment.service !== incident.service ||
        deployment.completedAt === null ||
        Number.isNaN(detectionTime)
      ) {
        return false;
      }

      const differenceInMinutes =
        Math.abs(Date.parse(deployment.completedAt) - detectionTime) / (60 * 1000);

      return differenceInMinutes <= 15;
    })
    .sort((left, right) => {
      const leftDifference = Math.abs(
        Date.parse(left.completedAt) - detectionTime
      );
      const rightDifference = Math.abs(
        Date.parse(right.completedAt) - detectionTime
      );

      if (leftDifference !== rightDifference) return leftDifference - rightDifference;

      return left.id.localeCompare(right.id);
    });

  const candidates = candidateDeployments.map((deployment) => {
    const candidateEvidenceIds = incidentEvidence
      .filter((record) => {
        if (
          record.sourceType === "health" &&
          record.relationship === "supports_incident"
        ) {
          return true;
        }

        if (
          record.sourceType === "deployment" &&
          record.sourceId === deployment.id
        ) {
          return true;
        }

        if (record.sourceType !== "event") return false;

        const event = serviceEvents.find(
          (candidate) => candidate.id === record.sourceId
        );

        return (
          event?.deploymentId === deployment.id ||
          record.relationship === "supports_hypothesis"
        );
      })
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((record) => record.id);

    const completedAt = deployment.completedAt;
    const detectionTimestamp = detection?.timestamp;

    return {
      deploymentId: deployment.id,
      confidence: "medium",
      relationship: "temporally_adjacent",
      evidenceIds: candidateEvidenceIds,
      summary:
        `${deployment.id} is temporally adjacent to the ${incident.service} degradation and remains the leading deployment hypothesis; causality is not confirmed.`,
      reasoning: [
        `The incident affects the ${incident.service} service.`,
        `${deployment.id} is a ${deployment.service} deployment.`,
        `${deployment.id} completed at ${completedAt.slice(11, 16)} UTC.`,
        `The ${incident.service} health alert was recorded at ${detectionTimestamp.slice(11, 16)} UTC.`,
        `The deployment is therefore temporally adjacent to the observed degradation.`,
        health.status === "degraded"
          ? `The ${incident.service} health snapshot is degraded in the latest deterministic window.`
          : `The ${incident.service} health snapshot is ${health.status} in the latest deterministic window.`,
        "Available evidence does not establish causality.",
      ],
    };
  });

  return {
    incidentId: incident.id,
    status: incident.status,
    service: incident.service,
    candidates,
  };
};

const buildInvestigation = (fixture, incident, correlation, incidentEvidence) => {
  const detection = incident.timeline.find((entry) => entry.type === "detection");
  const stageNames = [
    "incident",
    "health",
    "deployments",
    "events",
    "evidence",
    "correlation",
    "explanation",
  ];

  return {
    id: fixture.id,
    incidentId: incident.id,
    status: fixture.status,
    startedAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    checked: {
      health: true,
      deployments: true,
      events: true,
      evidence: true,
      correlation: true,
    },
    stages: stageNames.map((name) => ({
      name,
      status: "complete",
      completedAt:
        name === "incident"
          ? incident.createdAt
          : name === "health"
            ? detection.timestamp
            : incident.updatedAt,
    })),
    evidenceIds: incidentEvidence
      .map((record) => record.id)
      .sort((left, right) => left.localeCompare(right)),
    candidateDeploymentIds: correlation.candidates.map(
      (candidate) => candidate.deploymentId
    ),
    findingIds: incident.findings.map((finding) => finding.id),
    nextStep: fixture.nextStep,
    summary: fixture.summary,
  };
};

const buildExplanation = (fixture, incident, correlation, incidentEvidence) => {
  const candidate = correlation.candidates[0];
  const leadingHypothesis = candidate
    ? {
        deploymentId: candidate.deploymentId,
        confidence: candidate.confidence,
        relationship: candidate.relationship,
        causalityConfirmed: false,
      }
    : null;

  return {
    whatIsHappening: fixture.whatIsHappening,
    evidence: fixture.keyEvidenceIds.map((id) => {
      const record = incidentEvidence.find((item) => item.id === id);
      return {
        id: record.id,
        observation: record.observation,
        strength: record.strength,
      };
    }),
    leadingHypothesis,
    confidence: leadingHypothesis?.confidence ?? null,
    causalityConfirmed: false,
    unknowns: leadingHypothesis
      ? [
          `The available evidence does not establish that ${candidate.deploymentId} caused the degradation.`,
          "No direct causal signal is currently represented in the deterministic dataset.",
        ]
      : [
          "No deployment candidate satisfies the deterministic 15-minute correlation window.",
          "The deterministic dataset does not establish a cause for the notification degradation.",
        ],
    nextStep: fixture.nextStep,
  };
};

const buildInvestigationWorkflow = (fixture) => {
  const incident = getIncidentData(fixture.incidentId);
  const health = serviceHealthSnapshots[incident.service];
  const incidentEvidence = getIncidentEvidenceData(incident.id);
  const correlation = correlateIncidentData(incident);
  const investigation = buildInvestigation(
    fixture,
    incident,
    correlation,
    incidentEvidence
  );
  const explanation = buildExplanation(
    fixture,
    incident,
    correlation,
    incidentEvidence
  );

  return {
    incident,
    health,
    investigation,
    evidence: incidentEvidence,
    correlation,
    explanation,
  };
};

const activeIncidentStatuses = new Set(["investigating", "mitigated"]);
const severityRank = {
  "SEV-1": 1,
  "SEV-2": 2,
  "SEV-3": 3,
  "SEV-4": 4,
};

const apiChatRequestSchema = z
  .object({
    message: z.string().trim().min(1),
    conversationId: z.string().trim().min(1).nullable().optional(),
    // Optional explicit prior-turn context. Lenient inner object (unknown subkeys
    // stripped, not rejected) + validated against real fixtures by sanitizeChatContext.
    // Requests that omit it are unchanged — full backward compatibility.
    context: z
      .object({
        activeIncidentId: z.string().trim().min(1).nullable().optional(),
        service: z.string().trim().min(1).nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .strict();

const app = createMcpExpressApp({
  host: bindHost,
  allowedHosts,
  ...(allowedOrigins ? { allowedOrigins } : {}),
});

// Serve the G2-D1 conversational web UI (static assets) from the same loopback
// origin as /api/chat, so the browser's same-origin fetch clears the host and
// origin validation createMcpExpressApp already applied. No new dependency:
// express ships with the MCP express app. static handles only GET/HEAD, so it
// falls through to the POST /api/chat and /mcp handlers below.
const webRoot = fileURLToPath(new URL("./web", import.meta.url));
app.get("/", (req, res) => {
  if (isVercel && !hasValidSession(req)) return res.redirect(302, "/login.html");
  return res.sendFile(fileURLToPath(new URL("./web/index.html", import.meta.url)));
});
app.use(express.static(webRoot, { index: false }));

const handler = createMcpHandler(() => {
  const server = new McpServer({
    name: "amazon-alexa-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "get_service_health",
    {
      description:
        "Read-only health check for a supported service. Returns deterministic availability, error rate, latency percentiles, comparison window, and health signals for the latest 15-minute window. Requires a service name.",
      inputSchema: z.object({
        service: serviceSchema.describe("Service to inspect"),
      }),
      outputSchema: serviceHealthSchema,
    },
    async ({ service }) => {
      const health = serviceHealthSnapshots[service];

      return {
        structuredContent: health,
        content: [
          {
            type: "text",
            text: JSON.stringify(health),
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_active_incidents",
    {
      description:
        "Read-only incident discovery. Returns deterministic summaries of active investigating or mitigated incidents, optionally filtered by service. Omit the service to inspect all services.",
      inputSchema: listActiveIncidentsInputSchema,
      outputSchema: listActiveIncidentsResponseSchema,
    },
    async ({ service }) => {
      const activeIncidents = incidents
        .filter(
          (incident) =>
            activeIncidentStatuses.has(incident.status) &&
            (service === undefined || incident.service === service)
        )
        .sort((left, right) => {
          const severityDifference =
            severityRank[left.severity] - severityRank[right.severity];

          if (severityDifference !== 0) return severityDifference;

          const createdAtDifference = right.createdAt.localeCompare(
            left.createdAt
          );

          if (createdAtDifference !== 0) return createdAtDifference;

          return left.id.localeCompare(right.id);
        })
        .map(({ id, service, title, severity, status, createdAt, updatedAt }) => ({
          id,
          service,
          title,
          severity,
          status,
          createdAt,
          updatedAt,
        }));

      const result = {
        incidents: activeIncidents,
        count: activeIncidents.length,
        filter: {
          service: service ?? null,
        },
      };

      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_incident",
    {
      description:
        "Read-only incident lookup. Returns the complete deterministic incident timeline, findings, suspected cause, and canonical deployment/event references for a stable incident ID.",
      inputSchema: getIncidentInputSchema,
      outputSchema: getIncidentResponseSchema,
    },
    async ({ id }) => {
      const incident = incidents.find((candidate) => candidate.id === id);

      if (!incident) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Incident not found: ${id}`,
            },
          ],
        };
      }

      return {
        structuredContent: incident,
        content: [
          {
            type: "text",
            text: JSON.stringify(incident),
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_recent_deployments",
    {
      description:
        "Read-only deployment discovery. Returns deterministic recent deployment summaries, optionally filtered by service, for reviewing changes near an incident.",
      inputSchema: listRecentDeploymentsInputSchema,
      outputSchema: listRecentDeploymentsOutputSchema,
    },
    async ({ service }) => {
      const deploymentSummaries = deployments
        .filter(
          (deployment) =>
            service === undefined || deployment.service === service
        )
        .sort((left, right) => {
          const deployedAtDifference = right.deployedAt.localeCompare(
            left.deployedAt
          );

          if (deployedAtDifference !== 0) return deployedAtDifference;

          return left.id.localeCompare(right.id);
        })
        .map(
          ({
            id,
            service,
            version,
            environment,
            status,
            deployedAt,
            completedAt,
          }) => ({
            id,
            service,
            version,
            environment,
            status,
            deployedAt,
            completedAt,
          })
        );

      const result = {
        deployments: deploymentSummaries,
        count: deploymentSummaries.length,
        filter: {
          service: service ?? null,
        },
      };

      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_deployment",
    {
      description:
        "Read-only deployment lookup. Returns the complete canonical deployment record for a stable deployment ID, including version, timing, change summary, commit, and rollback metadata.",
      inputSchema: getDeploymentInputSchema,
      outputSchema: getDeploymentOutputSchema,
    },
    async ({ id }) => {
      const deployment = deployments.find(
        (candidate) => candidate.id === id
      );

      if (!deployment) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Deployment not found: ${id}`,
            },
          ],
        };
      }

      return {
        structuredContent: deployment,
        content: [
          {
            type: "text",
            text: JSON.stringify(deployment),
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_service_events",
    {
      description:
        "Read-only operational event lookup. Returns deterministic event summaries for the required service, ordered newest first, including deployment references where present.",
      inputSchema: listServiceEventsInputSchema,
      outputSchema: listServiceEventsOutputSchema,
    },
    async ({ service }) => {
      const eventSummaries = events
        .filter((event) => event.service === service)
        .sort((left, right) => {
          const occurredAtDifference = right.occurredAt.localeCompare(
            left.occurredAt
          );

          if (occurredAtDifference !== 0) return occurredAtDifference;

          return left.id.localeCompare(right.id);
        })
        .map(
          ({
            id,
            service,
            type,
            severity,
            occurredAt,
            source,
            summary,
            deploymentId,
          }) => ({
            id,
            service,
            type,
            severity,
            occurredAt,
            source,
            summary,
            deploymentId,
          })
        );

      const result = {
        events: eventSummaries,
        count: eventSummaries.length,
        filter: {
          service,
        },
      };

      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_event",
    {
      description:
        "Read-only event lookup. Returns the complete canonical operational event and its optional deployment reference for a stable event ID.",
      inputSchema: getEventInputSchema,
      outputSchema: getEventOutputSchema,
    },
    async ({ id }) => {
      const event = events.find((candidate) => candidate.id === id);

      if (!event) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Event not found: ${id}`,
            },
          ],
        };
      }

      return {
        structuredContent: event,
        content: [
          {
            type: "text",
            text: JSON.stringify(event),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_incident_evidence",
    {
      description:
        "Read-only evidence lookup. Returns the chronologically ordered deterministic evidence chain for an incident, preserving source IDs, observation times, relationships, and evidence strength.",
      inputSchema: getIncidentEvidenceInputSchema,
      outputSchema: getIncidentEvidenceOutputSchema,
    },
    async ({ incidentId }) => {
      const incident = incidents.find(
        (candidate) => candidate.id === incidentId
      );

      if (!incident) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Incident not found: ${incidentId}`,
            },
          ],
        };
      }

      const incidentEvidence = getIncidentEvidenceData(incidentId);

      const result = {
        incidentId,
        evidence: incidentEvidence,
        count: incidentEvidence.length,
      };

      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  server.registerTool(
    "correlate_incident",
    {
      description:
        "Read-only deterministic correlation. Evaluates same-service deployments within the configured 15-minute window around incident detection and returns evidence-backed hypotheses without claiming causality.",
      inputSchema: correlateIncidentInputSchema,
      outputSchema: correlateIncidentOutputSchema,
    },
    async ({ incidentId }) => {
      const incident = incidents.find(
        (candidate) => candidate.id === incidentId
      );

      if (!incident) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Incident not found: ${incidentId}`,
            },
          ],
        };
      }

      const result = correlateIncidentData(incident);

      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_investigation",
    {
      description:
        "Read-only investigation state lookup. Returns completed workflow stages, evidence IDs, candidate deployments, findings, next step, and deterministic investigation status for an investigation ID.",
      inputSchema: getInvestigationInputSchema,
      outputSchema: getInvestigationOutputSchema,
    },
    async ({ id }) => {
      const fixture = investigationFixtures.find(
        (candidate) => candidate.id === id
      );

      if (!fixture) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Investigation not found: ${id}`,
            },
          ],
        };
      }

      const { investigation } = buildInvestigationWorkflow(fixture);

      return {
        structuredContent: investigation,
        content: [
          {
            type: "text",
            text: JSON.stringify(investigation),
          },
        ],
      };
    }
  );

  server.registerTool(
    "summarize_investigation",
    {
      description:
        "Read-only investigation summary for agent consumption. Returns the incident condition, leading deployment hypothesis if one exists, confidence, key evidence IDs, uncertainty, and next investigation step.",
      inputSchema: summarizeInvestigationInputSchema,
      outputSchema: summarizeInvestigationOutputSchema,
    },
    async ({ id }) => {
      const fixture = investigationFixtures.find(
        (candidate) => candidate.id === id
      );

      if (!fixture) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Investigation not found: ${id}`,
            },
          ],
        };
      }

      const workflow = buildInvestigationWorkflow(fixture);
      const candidate = workflow.correlation.candidates[0];
      const summary = {
        investigationId: workflow.investigation.id,
        incidentId: workflow.incident.id,
        service: workflow.incident.service,
        status: workflow.investigation.status,
        severity: workflow.incident.severity,
        summary: workflow.explanation.whatIsHappening,
        leadingHypothesis: candidate
          ? {
              deploymentId: candidate.deploymentId,
              confidence: candidate.confidence,
              relationship: candidate.relationship,
              causalityConfirmed: false,
            }
          : null,
        candidateDeploymentIds: workflow.investigation.candidateDeploymentIds,
        confidence: candidate?.confidence ?? null,
        keyEvidenceIds: fixture.keyEvidenceIds,
        nextStep: workflow.investigation.nextStep,
        uncertainty: workflow.explanation.unknowns[0],
      };

      return {
        structuredContent: summary,
        content: [
          {
            type: "text",
            text: JSON.stringify(summary),
          },
        ],
      };
    }
  );

  server.registerTool(
    "investigate_incident",
    {
      description:
        "Runs a complete deterministic, read-only investigation workflow for an incident. Returns incident, health, evidence, correlation, investigation state, and structured explanation; it performs no remediation and does not claim causality.",
      inputSchema: investigateIncidentInputSchema,
      outputSchema: investigateIncidentOutputSchema,
    },
    async ({ incidentId }) => {
      const fixture = investigationFixtures.find(
        (candidate) => candidate.incidentId === incidentId
      );

      if (!fixture) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Incident not found: ${incidentId}`,
            },
          ],
        };
      }

      const workflow = buildInvestigationWorkflow(fixture);

      return {
        structuredContent: workflow,
        content: [
          {
            type: "text",
            text: JSON.stringify(workflow),
          },
        ],
      };
    }
  );

  return server;
});

const nodeHandler = toNodeHandler(handler);

// Shared, fixed error redaction for both chat transports. The agent's raw
// error.message can carry provider URLs or an upstream HTTP body, so the client
// only ever receives a stable code and a canned, safe message — never
// error.message itself. Both /api/chat and /api/chat/stream map through this.
const loginFailures = new Map();
app.post("/api/login", (req, res) => {
  if (!isVercel) return res.status(404).json({ ok: false });
  const now = Date.now();
  const key = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const state = loginFailures.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (state.resetAt <= now) { state.count = 0; state.resetAt = now + 15 * 60 * 1000; }
  if (state.count >= 10) return res.status(429).json({ ok: false, error: "Too many attempts. Try again later." });
  if (!verifyAccessPassword(req.body?.password)) {
    state.count += 1; loginFailures.set(key, state);
    return res.status(401).json({ ok: false, error: "Incorrect password." });
  }
  loginFailures.delete(key);
  try { res.setHeader("Set-Cookie", createSessionCookie()); }
  catch { return res.status(503).json({ ok: false, error: "Hosted access is not configured yet." }); }
  return res.status(200).json({ ok: true });
});

const requireSession = (req, res, next) => {
  if (!isVercel || hasValidSession(req)) return next();
  return res.status(401).json({ ok: false, error: { code: "AUTH_REQUIRED", message: "Sign in to use DupTrace." } });
};
app.use("/api/chat", requireSession);
app.use("/api/chat/stream", requireSession);

const chatErrorInfo = (error) => {
  const code = error?.code || "AGENT_ERROR";
  const status =
    code === "MODEL_PROVIDER_UNAVAILABLE" || code === "MCP_UNAVAILABLE"
      ? 503
      : 500;
  const messageByCode = {
    MODEL_PROVIDER_UNAVAILABLE: "The configured model provider is unavailable.",
    MCP_UNAVAILABLE: "DupTrace MCP is unavailable.",
    AGENT_ERROR: "The agent request could not be completed.",
  };

  return {
    code,
    status,
    message: messageByCode[code] || messageByCode.AGENT_ERROR,
  };
};

app.post("/api/chat", async (req, res) => {
  const parsedRequest = apiChatRequestSchema.safeParse(req.body);

  if (!parsedRequest.success) {
    res.status(400).json({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Request must include a non-empty string message.",
      },
      toolActivity: [],
    });
    return;
  }

  const { message, conversationId = null, context = null } = parsedRequest.data;
  const activeContext = sanitizeChatContext(context, {
    incidentIds: incidents.map((incident) => incident.id),
    services: supportedServices,
  });

  try {
    const result = await runAgent({ message, conversationId, context: activeContext });

    res.status(200).json({
      ok: true,
      conversationId,
      message: {
        role: "assistant",
        content: result.response,
      },
      toolActivity: result.activity,
    });
  } catch (error) {
    const { code, status, message } = chatErrorInfo(error);

    res.status(status).json({
      ok: false,
      conversationId,
      error: { code, message },
      toolActivity: error.toolActivity || [],
    });
  }
});

// Streaming variant of /api/chat — same request contract, same security. It is
// mounted on the same app, so the host/origin guard createMcpExpressApp installed
// and the JSON body parser both apply here too. Rather than buffering the whole
// investigation, it emits Server-Sent Events as real progress occurs:
//   start    once, carrying the conversationId          → UI shows "investigating"
//   activity once per REAL MCP tool result, as produced  → UI appends a check row
//   answer   the final authoritative content + full toolActivity (parity with JSON)
//   done     clean end of stream
//   error    sanitized failure (code only), if the agent throws after headers flush
// EventSource cannot POST a body, so the browser reads this via fetch(): POST +
// JSON in, SSE frames out. The JSON /api/chat path above is left byte-for-byte.
app.post("/api/chat/stream", async (req, res) => {
  const parsedRequest = apiChatRequestSchema.safeParse(req.body);

  if (!parsedRequest.success) {
    // Reject malformed input exactly like /api/chat, before opening the stream.
    res.status(400).json({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Request must include a non-empty string message.",
      },
      toolActivity: [],
    });
    return;
  }

  const { message, conversationId = null, context = null } = parsedRequest.data;
  const activeContext = sanitizeChatContext(context, {
    incidentIds: incidents.map((incident) => incident.id),
    services: supportedServices,
  });

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  // Defeat proxy response buffering so each event flushes as it is written.
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();

  // Write one SSE frame. Guarded so a disconnect or an already-finished response
  // can never throw ("write after end" / ERR_STREAM_DESTROYED) and crash the handler.
  const send = (event) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Abort only on a genuine client disconnect — the RESPONSE stream closing before
  // we have finished writing it. (req's 'close' fires when the request BODY has been
  // fully read, which happens early — mid-investigation — so keying the abort off
  // req set this flag before the tool loop and silently dropped every activity event.)
  let aborted = false;
  res.on("close", () => {
    if (!res.writableEnded) aborted = true;
  });

  send({ type: "start", conversationId });

  try {
    const result = await runAgent({
      message,
      conversationId,
      context: activeContext,
      onEvent: (event) => {
        if (aborted || event?.type !== "activity") return;
        send({ type: "activity", activity: event.activity });
      },
    });

    send({
      type: "answer",
      conversationId,
      message: { role: "assistant", content: result.response },
      toolActivity: result.activity,
    });
    send({ type: "done" });
  } catch (error) {
    // Headers are already sent, so there is no HTTP status to set; the failure
    // travels in-band as a sanitized event (stable code, canned message — never
    // error.message), and the client maps the code to the same copy as the JSON path.
    const { code, message: safeMessage } = chatErrorInfo(error);
    send({
      type: "error",
      conversationId,
      error: { code, message: safeMessage },
      toolActivity: error.toolActivity || [],
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.all("/mcp", (req, res) => {
  if (isVercel && !isAuthorizedMcpRequest(req)) {
    res.status(401).json({ error: { code: "MCP_UNAUTHORIZED", message: "Unauthorized." } });
    return;
  }
  void nodeHandler(req, res, req.body);
});

const displayHost = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
const endpoint = publicUrl
  ? `${publicUrl}/mcp`
  : `http://${displayHost}:${port}/mcp`;

if (!isVercel) {
  app.listen(port, bindHost, () => {
    console.log(`MCP server listening on ${endpoint}`);
  });
}

export default app;
