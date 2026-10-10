// _verify_integrity.mjs — focused tests for the new server-side validation.
//
// TEMPORARY verification tool (delete after use; never committed). It imports the
// REAL pure modules — fixture_integrity.js (timeline rule) and chat_context.js
// (follow-up context validation + injection) — and exercises them with synthetic
// inputs. No server, no DOM, no dependencies (importing server.js would start the
// HTTP listener, which is why these rules live in their own modules).
//
// Expected final line when healthy:  ALL INTEGRITY CHECKS PASSED — <N> passed, 0 failed

import { assertTimelineIntegrity } from "./fixture_integrity.js";
import { sanitizeChatContext, buildContextMessage } from "./chat_context.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}
function throwsWith(fn, re) {
  try {
    fn();
    return false;
  } catch (error) {
    return re.test(String(error && error.message));
  }
}

console.log("\nassertTimelineIntegrity (timeline ↔ event consistency)");

const events = [
  { id: "EVT-0902", occurredAt: "2026-09-19T10:44:00Z" },
  { id: "EVT-0901", occurredAt: "2026-09-19T10:45:00Z" },
];

const validIncidents = [
  {
    id: "INC-A",
    timeline: [
      { id: "TL-A1", eventId: "EVT-0901", timestamp: "2026-09-19T10:45:00Z" },
      { id: "TL-A2", eventId: "EVT-0902", timestamp: "2026-09-19T10:44:00Z" },
      { id: "TL-A3", eventId: null, timestamp: "2026-09-19T11:00:00Z" }, // no event → skipped
    ],
  },
];
let validOk = true;
try {
  assertTimelineIntegrity(validIncidents, events);
} catch {
  validOk = false;
}
check("valid timeline references pass (and null eventId is skipped)", validOk);

check(
  "a mismatched timestamp throws",
  throwsWith(
    () =>
      assertTimelineIntegrity(
        [{ id: "INC-B", timeline: [{ id: "TL-B1", eventId: "EVT-0902", timestamp: "2026-09-19T10:50:00Z" }] }],
        events,
      ),
    /does not match/i,
  ),
);

check(
  "a missing event reference throws",
  throwsWith(
    () =>
      assertTimelineIntegrity(
        [{ id: "INC-C", timeline: [{ id: "TL-C1", eventId: "EVT-NOPE", timestamp: "2026-09-19T10:44:00Z" }] }],
        events,
      ),
    /unknown event/i,
  ),
);

console.log("\nsanitizeChatContext (accept only fixture-consistent values)");

const fixtures = { incidentIds: ["INC-2026-001", "INC-2026-002"], services: ["payments", "auth"] };

const full = sanitizeChatContext({ activeIncidentId: "INC-2026-001", service: "payments" }, fixtures);
check(
  "valid full context is accepted",
  full && full.activeIncidentId === "INC-2026-001" && full.service === "payments",
  JSON.stringify(full),
);

const unknownId = sanitizeChatContext({ activeIncidentId: "INC-2026-999", service: "payments" }, fixtures);
check(
  "unknown incident id (valid shape, not in fixtures) is dropped",
  unknownId && unknownId.activeIncidentId === null && unknownId.service === "payments",
  JSON.stringify(unknownId),
);

const badShape = sanitizeChatContext({ activeIncidentId: "DROP TABLE", service: "payments" }, fixtures);
check(
  "malformed incident id is dropped",
  badShape && badShape.activeIncidentId === null && badShape.service === "payments",
  JSON.stringify(badShape),
);

const badService = sanitizeChatContext({ activeIncidentId: "INC-2026-001", service: "billing" }, fixtures);
check(
  "unsupported service is dropped",
  badService && badService.activeIncidentId === "INC-2026-001" && badService.service === null,
  JSON.stringify(badService),
);

check("empty object → null", sanitizeChatContext({}, fixtures) === null);
check("null → null", sanitizeChatContext(null, fixtures) === null);
check("non-object → null", sanitizeChatContext("INC-2026-001", fixtures) === null);
check(
  "both fields invalid → null (nothing to trust)",
  sanitizeChatContext({ activeIncidentId: "x", service: "y" }, fixtures) === null,
);

console.log("\nbuildContextMessage (labelled, non-evidence, tool-preserving)");

const msg = buildContextMessage({ activeIncidentId: "INC-2026-001", service: "payments" });
check(
  "builds a labelled user-role message naming the incident + service",
  msg &&
    msg.role === "user" &&
    msg.content.includes("INC-2026-001") &&
    msg.content.includes("payments"),
  msg ? msg.content : "null",
);
check(
  "message states it is not evidence and the current request wins",
  msg && /not evidence/i.test(msg.content) && /current request/i.test(msg.content),
);
check(
  "message tells the agent to still call tools (get_incident_evidence)",
  msg && /get_incident_evidence/.test(msg.content),
);
const svcOnly = buildContextMessage({ activeIncidentId: null, service: "payments" });
check("service-only context still builds a message", svcOnly && svcOnly.content.includes("payments"));
check("null context → no message", buildContextMessage(null) === null);
check(
  "all-null context → no message",
  buildContextMessage({ activeIncidentId: null, service: null }) === null,
);

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log("\n" + "─".repeat(60));
console.log(
  `${failed === 0 ? "ALL INTEGRITY CHECKS PASSED" : "INTEGRITY CHECKS FAILED"} — ${passed} passed, ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
