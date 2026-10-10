// format.js — pure, DOM-free formatters for the investigation trace.
//
// No framework, no DOM, no dependencies. Every function only REFORMATS values
// that are actually present in a tool result or the tool names itself — it never
// invents IDs, timestamps, confidence, evidence, or tool activity. Kept separate
// from app.js so the data-integrity rules are unit-testable in plain Node.

export const RESULT_PREVIEW_LIMIT = 180;
export const RAW_RESULT_LIMIT = 4000;
export const ARG_VALUE_LIMIT = 60;

// Verbs that add no meaning to a human label once the object is shown.
const DROP_LEADING_VERBS = new Set(["get", "list", "fetch", "read", "show"]);

// Keys whose values are worth surfacing as compact context, when present.
const CONTEXT_ARG_KEYS = [
  "service",
  "incidentId",
  "incident_id",
  "deploymentId",
  "deployment_id",
  "eventId",
  "event_id",
  "id",
];

const TIMESTAMP_KEY_RE = /(at|time|timestamp)$/i;

// Curated labels for keys the DupTrace tools actually return. Unknown keys fall
// back to camelCase/snake_case splitting — so a new field still reads sensibly.
const READABLE_LABELS = {
  id: "ID",
  incidentId: "Incident",
  deploymentId: "Deployment",
  sourceId: "Source ID",
  sourceType: "Source",
  observedAt: "Observed",
  occurredAt: "Occurred",
  deployedAt: "Deployed",
  createdAt: "Created",
  updatedAt: "Updated",
  completedAt: "Completed",
  startedAt: "Started",
  timestamp: "Time",
  relationship: "Relationship",
  strength: "Strength",
  confidence: "Confidence",
  causalityConfirmed: "Causality confirmed",
  severity: "Severity",
  status: "Status",
  service: "Service",
  availability: "Availability",
  errorRate: "Error rate",
  window: "Window",
  nextStep: "Next step",
  count: "Count",
  summary: "Summary",
  observation: "Observation",
  title: "Title",
  reasoning: "Reasoning",
  signals: "Signals",
};

/** @param {string} text @param {number} limit */
export function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** @param {unknown} value @returns {string} */
export function formatScalar(value) {
  if (value == null) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "…";
  }
}

/** @param {unknown} value @returns {string} */
export function stringifySafe(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Human label derived from the real tool name. Drops a leading fetch-style verb
 * and title-cases the rest. Generic: no per-tool hard-coding, no fake sequence.
 * @param {string} name
 * @returns {string}
 */
export function humanizeTool(name) {
  const parts = String(name || "")
    .split(/[_\s]+/)
    .filter(Boolean);
  if (parts.length === 0) return "Tool";
  if (parts.length > 1 && DROP_LEADING_VERBS.has(parts[0].toLowerCase())) {
    parts.shift();
  }
  const phrase = parts.join(" ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** Human label for a data key, using the curated map then camelCase splitting. */
export function labelFor(key) {
  const name = String(key);
  const known = READABLE_LABELS[name];
  if (known) return known;
  // Unknown key → sentence case: split snake_case and camelCase, lower the words,
  // capitalize only the first. Known IDs/acronyms are served by the map above.
  const spaced = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Format an ISO timestamp as a stable, readable UTC string (or pass through). */
export function formatTimestamp(value) {
  const text = String(value);
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return text;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Render one scalar value readably, given its key (timestamps, booleans…). */
export function readableScalar(key, value) {
  if (value == null) return "";
  if (typeof value === "string") {
    if (TIMESTAMP_KEY_RE.test(key) && !Number.isNaN(Date.parse(value))) {
      return formatTimestamp(value);
    }
    return value;
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  return "";
}

/** A short identifying label for one item inside a collection, from its OWN data. */
export function itemLabel(item) {
  if (!item || typeof item !== "object") return "";
  for (const key of ["observation", "title", "summary", "reasoning", "id", "name"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length && typeof value[0] === "string") {
      return value[0].trim();
    }
  }
  return "";
}

/**
 * Best-effort one-line preview of a tool result without assuming any specific
 * schema: structured content first, then the first text block.
 * @param {unknown} result
 * @returns {string}
 */
export function previewOf(result) {
  if (result == null || typeof result !== "object") return "";
  const r = /** @type {Record<string, any>} */ (result);
  const structured = r.structuredContent;

  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const parts = [];

    // Lead with any collection (incidents, evidence, candidates, events…) — a
    // count plus the first item's own label reads far better than dumped JSON.
    for (const [key, value] of Object.entries(structured)) {
      if (Array.isArray(value)) {
        const first = value.find((item) => item && typeof item === "object");
        const lead = first ? itemLabel(first) : "";
        parts.push(
          `${value.length} ${labelFor(key).toLowerCase()}${lead ? ` — ${truncate(lead, 60)}` : ""}`,
        );
      }
    }

    // Then the most meaningful scalar fields (IDs, status, confidence, times…).
    for (const [key, value] of Object.entries(structured)) {
      if (parts.length >= 5) break;
      if (Array.isArray(value) || (value && typeof value === "object")) continue;
      if (value == null) continue;
      const text = readableScalar(key, value);
      if (text) parts.push(`${labelFor(key)}: ${truncate(text, 60)}`);
    }

    if (parts.length > 0) return parts.slice(0, 5).join(" · ");
  }

  // Cope with a plain array / scalar structured payload.
  if (Array.isArray(structured)) {
    return `${structured.length} ${structured.length === 1 ? "item" : "items"}`;
  }
  if (typeof structured === "string" && structured.trim()) {
    return truncate(structured, RESULT_PREVIEW_LIMIT);
  }

  if (Array.isArray(r.content)) {
    const firstText = r.content.find(
      (c) => c && typeof c === "object" && typeof c.text === "string",
    );
    if (firstText) return truncate(firstText.text, RESULT_PREVIEW_LIMIT);
  }

  return "";
}

/**
 * Readable key/value facts from a structured payload: top-level scalars, IDs,
 * statuses, confidences and timestamps, plus a compact form for numeric objects
 * (e.g. latency → "p50 180 / p95 920 / p99 1840"). Collections are summarized by
 * count. Returns only what exists — never a placeholder for a missing field.
 * @param {unknown} structured
 * @returns {{ facts: Array<[string,string]>, notes: string[] }}
 */
export function structuredFacts(structured) {
  const facts = [];
  const notes = [];
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    return { facts, notes };
  }

  for (const [key, value] of Object.entries(structured)) {
    // Causality status is surfaced ONLY as a caveat note below, never as an
    // ordinary fact: a "Causality confirmed: no" row would read as a settled
    // data point and risk implying causation is proven/disproven as fact.
    if (key === "causalityConfirmed") continue;
    if (Array.isArray(value)) {
      facts.push([key, `${value.length} ${value.length === 1 ? "item" : "items"}`]);
      continue;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length && entries.every(([, v]) => typeof v === "number")) {
        facts.push([key, entries.map(([k, v]) => `${k} ${v}`).join(" / ")]);
      }
      continue;
    }
    if (value == null) continue;
    const text = readableScalar(key, value);
    if (text) facts.push([key, text]);
  }

  // Keep confirmed observations explicitly separate from hypotheses: the dataset
  // carries this flag; when it is false, say so rather than implying causation.
  if (structured.causalityConfirmed === false) {
    notes.push("Causality not confirmed by the available evidence.");
  }

  return { facts, notes };
}

/** Compact context chips from a tool entry's real arguments/result (IDs, services). */
export function contextValues(entry) {
  const values = [];
  const seen = new Set();
  const push = (raw) => {
    if (raw == null) return;
    const text = truncate(formatScalar(raw), ARG_VALUE_LIMIT).trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    values.push(text);
  };

  const args = entry.arguments;
  if (args && typeof args === "object") {
    for (const key of CONTEXT_ARG_KEYS) {
      if (key in args) push(/** @type {any} */ (args)[key]);
    }
    // Fall back to any remaining primitive args so context stays generic.
    if (values.length === 0) {
      for (const v of Object.values(args)) {
        if (typeof v !== "object") push(v);
      }
    }
  }

  // Surface ID-like tokens (e.g. INC-2026-001, DEP-2026-0142) from the result's
  // structured content, if any are present. Purely additive, still real data.
  const structured = /** @type {any} */ (entry.result)?.structuredContent;
  if (structured && typeof structured === "object") {
    for (const v of Object.values(structured)) {
      if (typeof v === "string" && /^[A-Z][A-Z0-9]+-[A-Za-z0-9-]+$/.test(v)) push(v);
    }
  }

  return values.slice(0, 3);
}

/** True when a tool result carries nothing worth expanding. */
export function resultIsEmpty(result) {
  if (result == null) return true;
  if (typeof result !== "object") return false;
  const r = /** @type {Record<string, any>} */ (result);
  const hasStructured =
    r.structuredContent &&
    typeof r.structuredContent === "object" &&
    Object.keys(r.structuredContent).length > 0;
  const hasContent = Array.isArray(r.content) && r.content.length > 0;
  const hasOther = Object.keys(r).some(
    (k) => k !== "structuredContent" && k !== "content" && k !== "isError",
  );
  return !hasStructured && !hasContent && !hasOther;
}

const INCIDENT_ID_RE = /^INC-[0-9]{4}-[0-9]{3}$/;

/**
 * Derive compact follow-up context from a completed turn's REAL tool activity —
 * verified structured results (and the tool-call arguments that produced them),
 * never the assistant's natural-language answer. Returns the last incident id and
 * service seen across the turn (consistent within a single-incident investigation),
 * or null when neither is present. The server re-validates before trusting it.
 * @param {import("./api.js").ToolActivity[]} toolActivity
 * @returns {{ activeIncidentId: (string|null), service: (string|null) } | null}
 */
export function deriveContext(toolActivity) {
  let activeIncidentId = null;
  let service = null;

  for (const entry of Array.isArray(toolActivity) ? toolActivity : []) {
    const structured = /** @type {any} */ (entry?.result)?.structuredContent;
    const args = entry?.arguments;

    const idCandidate =
      (structured && typeof structured.incidentId === "string" && structured.incidentId) ||
      (args && typeof args === "object" && typeof args.incidentId === "string" && args.incidentId) ||
      "";
    if (INCIDENT_ID_RE.test(idCandidate)) activeIncidentId = idCandidate;

    const serviceCandidate =
      (structured && typeof structured.service === "string" && structured.service) ||
      (args && typeof args === "object" && typeof args.service === "string" && args.service) ||
      "";
    if (serviceCandidate) service = serviceCandidate;
  }

  if (!activeIncidentId && !service) return null;
  return { activeIncidentId, service };
}
