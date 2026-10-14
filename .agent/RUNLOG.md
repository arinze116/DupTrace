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
- Native Gemini provider: added createGeminiProvider() + pure toGeminiSchema/toGeminiRequest/
  parseGeminiResponse to agent.js (built-in fetch, generateContent, x-goog-api-key, default
  gemini-2.5-flash, schema-subset conversion, id-preserving functionCall/functionResponse
  translation with role coalescing, sanitized errors, abort timeout); registered MODEL_PROVIDER=
  gemini. .env.example documents 3 providers. _verify_provider.mjs: set small MODEL_TIMEOUT_MS
  before import; added ~27 mocked-fetch/pure Gemini checks (text, function call, tool-result
  follow-up, HTTP 429 sanitized, malformed, non-JSON, timeout, missing key, no key leakage, custom
  model). No new deps. Verification REFUSED by classifier outage; static review + exports/dispatch
  grep done. Not committed.
- Reference-led frontend redesign (web/ only; agent.js/.env.example/_verify_provider.mjs untouched):
  studied 5 reference products via WebFetch (Morrow/KNOT/Clasp returned rich detail; Parallel/Selo
  are client-rendered SPAs that returned only taglines). Extracted + adapted: KNOT claim-vs-evidence
  separation → answer labelled "Conclusion" vs panel "Observed evidence"; Morrow verification/
  rejection framing → stable error-code chip; Clasp honest failure → dedicated partial-result state;
  Parallel/Selo product communication → empty-state eyebrow. Rebuilt index.html (three-pane shell +
  pre-paint theme bootstrap), styles.css (full light/dark token system, trace-spine investigation
  panel, drawers, every component state), app.js (theme system, localStorage multi-investigation
  threads, rail + collapsible inspector with real derived context, responsive drawers w/ scrim +
  Escape + focus, hand-authored inline-SVG icon set via createElementNS). Preserved: streamChat/
  sendChat flow, deriveContext, conversationId threading, follow-ups, textContent XSS-safety,
  renderCheck/investigation/follow-up/loading rendering. api.js + format.js byte-unchanged.
  Verification: node --check + npm test could NOT run — the command-safety classifier (same model as
  the session, in a broader availability outage) intermittently refused all shell commands. Did
  exhaustive static review (els IDs ↔ index.html; _verify_web static contracts preserved: "DupTrace",
  id="composer", app.js ref, "./format.js" import, no secret sentinels in served files; dark-token
  blocks complete + identical; three-pane/drawer CSS; submit→runTurn→ok/partial/error branches).
  Not committed (brief: do not commit/push). Verification handed off to run on classifier recovery.
- Final quality pass (web/ only): per-row evidence classification classifyEvidence()
  → tags observed/correlation/confirmed/No-data/error from REAL fields only
  (causalityConfirmed etc.), ochre node+tag for correlation, deployment never
  auto-labelled cause; "Conclusion" eyebrow gated on real answer text; WCAG-AA
  contrast fix (all functional text --faint→--muted since a faint tier can't be AA
  near white/black; --faint now decorative-only); restraint (selected investigation
  de-blued to --surface-2 + thin accent marker; inspector metrics → divider stat row;
  investigation head transparent; rail 260/inspector 300/measure 47rem); drawer
  open/close/collapse focus management. Self-performed the 4-dimension review
  (correctness/a11y/design/evidence) because the Agent tool — like Bash — is gated by
  the same claude-opus-4-8 availability outage and refused every fan-out dispatch;
  verified via static review: innerHTML absent (comments only), all 22 els ids map to
  index.html, no secrets in client files, _verify_web static contracts intact.
  node --check / npm test / git diff --check still BLOCKED by the outage this session.
  Not committed.
- 2026-10-14 — Markdown rendering for assistant answers. Raw `###`/`**`/lists/tables
  showed literally because renderAnswerInto put content in one `<p>` via textContent.
  No md lib existed; no-build static-ESM + strict no-innerHTML rule → wrote a
  self-contained pure parser web/markdown.js (parseMarkdown/parseInline/sanitizeHref:
  headings, para w/ soft breaks, bold/italic, inline+fenced code, ordered/unordered
  lists, links, pipe tables; TOTAL — never throws on partial/stream fragments) + a DOM
  renderer in app.js (renderMarkdownBlocks/Inline/Table) building nodes via
  textContent/createTextNode ONLY (never innerHTML). Security: link hrefs
  scheme-allowlisted (javascript:/data:/vbscript: → rendered as text), raw HTML stays
  literal text. GitHub rule enforced: table delimiter must match header column count
  (also makes half-typed delimiters degrade to text). styles.css: themed `.answer__md`
  (tokens → both light/dark), tables w/ header bg, borders, zebra, overflow-x scroll.
  New _verify_markdown.mjs (tables, unsafe HTML/links, partial-stream safety) added to
  npm test chain. VERIFICATION BLOCKED: classifier refused all Bash this session —
  node --check / _verify_markdown / npm test / git diff --check NOT run; traced tests
  vs parser by hand. Only web/markdown.js(new), web/app.js, web/styles.css,
  _verify_markdown.mjs(new), package.json changed. Not committed.
