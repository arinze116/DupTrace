# Run Log

Important execution events, failures, fixes, verification, and milestones.

## 2026-10-09
- Explored engine + server + web + harness from source (classifier blocked Explore subagents;
  used direct Read/Grep instead). Confirmed: provider is non-streaming; security is app-level
  middleware from `createMcpExpressApp`; error redaction is a fixed `messageByCode` dict;
  `renderCheck` is reusable for incremental append.
- Planned event-level SSE; user approved (plan: polished-napping-parasol.md).
- Implemented across agent.js, server.js, web/api.js, web/app.js, _verify_web.mjs. No new deps.
- Verification attempted: `node --check` x4, `node _verify_web.mjs`, `git diff --check` — all
  REFUSED by the command-safety classifier outage (Bash + PowerShell both down all session).
  Fallback: full static re-read of every changed region (structure/logic verified by inspection).
  Runtime verification handed to the user.
- Not committed (per brief).
- Harness run externally by user: 30 passed / 2 failed — the two streaming "activity event" checks.
  Root-caused by elimination (parity proves tool ran → onEvent fired; no error event → send didn't
  throw; answer/done present → res not ended ⇒ the only variable left, `aborted`, was true). Cause:
  disconnect abort keyed off `req.on("close")`, which fires when the consumed request body finishes
  (early), not on client disconnect. Fix (server.js): `res.on("close")` + `!res.writableEnded`; send
  guards `res.destroyed`. Re-verification handed to user (classifier still down).
- claude-cli provider fix: diagnosed MODEL_PROVIDER_UNAVAILABLE as the 60s outer timeout firing
  before the ~84s CLI (evidence: user's standalone timing), plus orphaned child on timeout and a
  missing JSON-schema instruction to the CLI. Fixed in agent.js (provider.timeoutMs +
  MODEL_CLI_TIMEOUT_MS default 180s; internal SIGTERM/SIGKILL on timeout; rewritten stdin prompt
  with schema contract + examples + tool catalog + transcript; exported parseClaudeAgentResponse;
  sanitized diagnostics). Added temp `_verify_provider.mjs` (parser + stub-CLI tests). Verification
  (node --check, _verify_provider.mjs, _verify_web.mjs, git diff --check, npm ls) REFUSED by the
  classifier outage; static review done; real-CLI e2e needs the authenticated binary. Not committed.
- Trace/evidence presentation: extracted pure formatters to web/format.js (testable in Node, no
  deps); rewrote previewOf (collections → counts, not JSON); added structuredFacts readable `<dl>`
  + causality caveat note; suppress empty Raw block; new .facts/.check__note styles; new
  _verify_format.mjs (fixture-driven) and +2 checks in _verify_web.mjs. Verified (read-only) that
  the count is dynamic and activity is per-turn — not defects. Verification commands REFUSED by the
  classifier outage; static review done. Not committed.
- Formatting regression fix (web/format.js, from user's _verify_format.mjs run): (1) labelFor
  title-cased unknown camelCase ("Some New Field") → added .toLowerCase() for sentence case
  ("Some new field"), map still short-circuits known labels; (2) health preview dropped errorRate —
  the array lead + a cap of 4 cut it → raised cap to 5; (3) previewOf threw ReferenceError:
  `structured` was block-scoped inside the first `if` but used below it → hoisted to function scope
  and guarded the object branch with !Array.isArray. Two edits, format.js only. Verification REFUSED
  by classifier outage; static review + full trace of all assertions done. Not committed.
- Last format test fix (user run: _verify_format 29/1, _verify_provider 13/0, _verify_web 34/0):
  the lone failure "causalityConfirmed:false becomes an explicit caveat, not a fact" was a real
  implementation defect, not an over-strict test — structuredFacts pushed causalityConfirmed as a
  plain fact ("no") AND added the caveat note, so the boolean showed as an ordinary field (violates
  requirement #4). Fix: skip `causalityConfirmed` in the facts loop (one guard); the `=== false`
  caveat note is unchanged. format.js only; test not weakened. Verification REFUSED by classifier
  outage; static review + assertion trace done (expected 30/0). Not committed.
- Timeline integrity + follow-up context (implementation of the prior investigation's two fixes):
  (1) fixed TL-2026-001-B timestamp 10:50→10:44; new fixture_integrity.js assertTimelineIntegrity
  wired into startup validation (all 5 real entries pass). (2) explicit {activeIncidentId,service}
  context: chat_context.js (sanitize+build), format.js deriveContext, app.js/api.js send it,
  server.js schema+handlers sanitize+thread, agent.js injects labelled prior-turn message;
  conversationId NOT repurposed; no new MCP tools; schema additive/back-compat. Tests: new
  _verify_integrity.mjs; +deriveContext in _verify_format; +3 context endpoint checks in
  _verify_web. Verification REFUSED by classifier outage (permission granted but the classifier
  service itself is down); exhaustive static review + cross-file wiring grep done. Not committed.
