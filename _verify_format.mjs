// _verify_format.mjs — focused tests for the investigation-trace formatters.
//
// TEMPORARY verification tool (delete after use; never committed). It imports the
// REAL web/format.js (pure, DOM-free) and checks that it reformats actual
// DupTrace tool results readably WITHOUT inventing fields. Fixtures below use the
// real shapes from server.js (service health, incident evidence, correlation
// candidates, explain summaries). Node built-ins only; no DOM, no dependencies.
//
// Expected final line when healthy:  ALL FORMAT CHECKS PASSED — <N> passed, 0 failed

import {
  humanizeTool,
  labelFor,
  formatTimestamp,
  readableScalar,
  previewOf,
  structuredFacts,
  contextValues,
  resultIsEmpty,
  truncate,
  deriveContext,
} from "./web/format.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

// --- real-shaped fixtures (copied from server.js output schemas) ------------
const healthResult = {
  structuredContent: {
    service: "payments",
    status: "degraded",
    availability: 99.21,
    errorRate: 18.4,
    latency: { p50: 180, p95: 920, p99: 1840 },
    window: "15m",
    comparisonWindow: "previous_15m",
    signals: ["5xx error rate increased 8.7x", "p95 latency increased 3.1x"],
  },
  content: [{ type: "text", text: "{}" }],
};

const evidenceResult = {
  structuredContent: {
    incidentId: "INC-2026-001",
    count: 2,
    evidence: [
      {
        id: "EVD-2026-0001",
        incidentId: "INC-2026-001",
        sourceType: "deployment",
        sourceId: "DEP-2026-0142",
        observedAt: "2026-09-19T10:45:00Z",
        observation: "A payments deployment completed immediately before the regression.",
        relationship: "temporally_adjacent",
        strength: "medium",
      },
      {
        id: "EVD-2026-0004",
        incidentId: "INC-2026-001",
        sourceType: "event",
        sourceId: "EVT-2026-0903",
        observedAt: "2026-09-19T11:05:00Z",
        observation: "Auth failures clustered after the deployment.",
        relationship: "supports_hypothesis",
        strength: "medium",
      },
    ],
  },
};

const explainResult = {
  structuredContent: {
    whatIsHappening: "Payments is degraded.",
    leadingHypothesis: {
      deploymentId: "DEP-2026-0142",
      confidence: "medium",
      relationship: "temporally_adjacent",
      causalityConfirmed: false,
    },
    confidence: "medium",
    causalityConfirmed: false,
    unknowns: ["No direct causal signal in the dataset."],
    nextStep: "Correlate recent events.",
  },
};

console.log("\nTool labels + key labels");

check(
  "humanizeTool drops the leading verb and title-cases",
  humanizeTool("get_service_health") === "Service health",
  humanizeTool("get_service_health"),
);
check("humanizeTool handles correlate_incident", humanizeTool("correlate_incident") === "Correlate incident");
check("humanizeTool falls back safely on empty input", humanizeTool("") === "Tool");

check("labelFor maps known keys", labelFor("causalityConfirmed") === "Causality confirmed");
check("labelFor uppercases ID", labelFor("incidentId") === "Incident");
check("labelFor splits unknown camelCase", labelFor("someNewField") === "Some new field", labelFor("someNewField"));

console.log("\nTimestamps + scalar readability");

check(
  "formatTimestamp renders a stable UTC string",
  formatTimestamp("2026-09-19T10:45:00Z") === "2026-09-19 10:45 UTC",
  formatTimestamp("2026-09-19T10:45:00Z"),
);
check("formatTimestamp passes through a non-timestamp", formatTimestamp("not-a-date") === "not-a-date");
check(
  "readableScalar formats a *At key as a timestamp",
  readableScalar("observedAt", "2026-09-19T10:45:00Z") === "2026-09-19 10:45 UTC",
);
check("readableScalar formats booleans as yes/no", readableScalar("causalityConfirmed", false) === "no");
check("readableScalar leaves a plain string verbatim", readableScalar("status", "degraded") === "degraded");

console.log("\nPreview (collections read as counts, not dumped JSON)");

const healthPreview = previewOf(healthResult);
check(
  "health preview shows service + status + error rate, no raw JSON",
  healthPreview.includes("Service: payments") &&
    healthPreview.includes("Status: degraded") &&
    healthPreview.includes("Error rate: 18.4") &&
    !healthPreview.includes("{"),
  healthPreview,
);
check(
  "health preview summarizes the signals array as a count",
  healthPreview.includes("2 signals"),
  healthPreview,
);

const evidencePreview = previewOf(evidenceResult);
check(
  "evidence preview leads with a count and the first real observation",
  evidencePreview.includes("2 evidence") &&
    evidencePreview.includes("payments deployment completed"),
  evidencePreview,
);

check("preview of an empty result is empty (no block)", previewOf({ structuredContent: {} }) === "");
check("preview of null is empty", previewOf(null) === "");

console.log("\nStructured facts + the causality guardrail");

const healthFacts = structuredFacts(healthResult.structuredContent);
const factMap = Object.fromEntries(healthFacts.facts);
check("facts compress the latency object into one readable line", factMap.latency === "p50 180 / p95 920 / p99 1840", factMap.latency);
check("facts render availability verbatim", factMap.availability === "99.21");
check("facts summarize arrays by count", factMap.signals === "2 items", factMap.signals);

const explainFacts = structuredFacts(explainResult.structuredContent);
check("facts preserve the confidence value", Object.fromEntries(explainFacts.facts).confidence === "medium");
check(
  "causalityConfirmed:false becomes an explicit caveat, not a fact",
  explainFacts.notes.some((n) => /not confirmed/i.test(n)) &&
    !("causalityConfirmed" in Object.fromEntries(explainFacts.facts)),
  explainFacts.notes.join(" | "),
);
check("facts section is empty (no fabrication) for a null structured payload", structuredFacts(null).facts.length === 0);

console.log("\nEmpty-result + context + truncation edge cases");

check("resultIsEmpty: null result", resultIsEmpty(null) === true);
check("resultIsEmpty: empty structuredContent", resultIsEmpty({ structuredContent: {} }) === true);
check("resultIsEmpty: real structuredContent", resultIsEmpty(healthResult) === false);
check(
  "resultIsEmpty: only an isError flag carries no content",
  resultIsEmpty({ isError: true, structuredContent: {} }) === true,
);

const ctx = contextValues({
  arguments: { service: "payments" },
  result: { structuredContent: { incidentId: "INC-2026-001" } },
});
check(
  "contextValues surfaces the real argument and result ID",
  ctx.includes("payments") && ctx.includes("INC-2026-001"),
  ctx.join(","),
);
check("contextValues never invents a value", contextValues({ arguments: {} }).length === 0);

check("truncate clips with an ellipsis", truncate("abcdef", 3) === "abc…");
check("truncate leaves short text intact", truncate("ab", 3) === "ab");

console.log("\nderiveContext (follow-up context from VERIFIED tool results only)");

const derivedBoth = deriveContext([
  { tool: "get_service_health", arguments: { service: "payments" }, result: healthResult },
  {
    tool: "investigate_incident",
    arguments: { incidentId: "INC-2026-001" },
    result: { structuredContent: { incidentId: "INC-2026-001", service: "payments" } },
  },
]);
check(
  "derives incident + service from structured results",
  derivedBoth &&
    derivedBoth.activeIncidentId === "INC-2026-001" &&
    derivedBoth.service === "payments",
  JSON.stringify(derivedBoth),
);

const derivedArgs = deriveContext([
  { tool: "get_incident_evidence", arguments: { incidentId: "INC-2026-001" }, result: { structuredContent: {} } },
]);
check(
  "falls back to the tool-call arguments when the result omits the id",
  derivedArgs && derivedArgs.activeIncidentId === "INC-2026-001",
  JSON.stringify(derivedArgs),
);

const derivedServiceOnly = deriveContext([
  { tool: "get_service_health", arguments: { service: "payments" }, result: healthResult },
]);
check(
  "service-only activity yields service with a null incident id (mock-provider shape)",
  derivedServiceOnly &&
    derivedServiceOnly.service === "payments" &&
    derivedServiceOnly.activeIncidentId === null,
  JSON.stringify(derivedServiceOnly),
);

check("no tool activity → null (nothing to carry)", deriveContext([]) === null);
check(
  "a bad id shape in the data is never derived",
  deriveContext([{ tool: "x", result: { structuredContent: { incidentId: "nope" } } }]) === null,
);

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log("\n" + "─".repeat(60));
console.log(
  `${failed === 0 ? "ALL FORMAT CHECKS PASSED" : "FORMAT CHECKS FAILED"} — ${passed} passed, ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
