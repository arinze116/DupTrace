# Tasks

## Active
- None. Frontend redesign is complete (see Completed). Remaining before submission:
  a live in-browser pass of the UI — NOT yet performed (no evidence of browser
  verification).

## Completed
- Frontend redesign (G3) — COMPLETE: three-pane investigation workspace (compact left
  rail with recent investigations + nav + theme toggle, center conversation+composer,
  right collapsible inspector with real derived context/provenance/uncertainty);
  genuine light/dark theme system (accessible toggle, localStorage persistence,
  system-pref fallback); responsive rail+inspector drawers; evidence classification;
  Markdown-rendered answers. Scope kept to web/ (api.js + format.js unchanged);
  streaming, tool-call rendering, follow-up context, XSS-safe textContent rendering,
  and all /api contracts preserved. Acceptance criteria met; automated suite green
  (`npm test` 188/0, 2026-10-14, incl. _verify_web static-asset/contract checks).
  NOTE: a live in-browser pass (visual theme toggle, responsive layout, keyboard/a11y)
  was NOT performed — no evidence of browser verification.
- G2-D3 streaming: agent `onEvent` hook, `/api/chat/stream` SSE route + shared redaction helper,
  `streamChat` client, progressive UI render with one-shot fallback, harness streaming checks.
- G2-D3 bugfix: activity events (`req.on("close")` → `res.on("close")`).
- claude-cli provider fix: provider-specific timeout + child termination, JSON-schema prompt,
  pure `parseClaudeAgentResponse`, sanitized logging, `_verify_provider.mjs` tests.
- Trace/evidence presentation: `web/format.js` pure formatters, readable preview + facts list,
  causality caveat, empty-raw suppression, styles, `_verify_format.mjs` + harness checks.
- Timeline integrity: TL-2026-001-B 10:50→10:44 + `fixture_integrity.js` startup validation + tests.
- Explicit follow-up context: `chat_context.js` (sanitize/build), `deriveContext`, client/server/agent
  threading, `_verify_integrity.mjs` + harness context checks. conversationId not repurposed.
- Project continuity initialized (STATE/DECISIONS/TASKS/RUNLOG).

## Blocked
- None. The runtime verification previously blocked by the classifier outage has since
  run (user-run, 2026-10-14): `npm test` 188 passed / 0 failed and `git diff --check`
  clean. The only outstanding check is a live in-browser UI pass.
