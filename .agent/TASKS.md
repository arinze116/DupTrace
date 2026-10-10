# Tasks

## Active
- None.

## Completed
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
- Runtime verification (node --check ×7, `_verify_integrity`, `_verify_format`, `_verify_provider`,
  `_verify_web`, `git diff --check`, `npm ls`) + live browser test — classifier outage prevents
  shell execution this session (permission granted, but the classifier service is down). Hand-off.
