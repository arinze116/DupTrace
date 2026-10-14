# Project State

## Current Objective
Hackathon submission readiness (Oct 23). Configured Gemini provider (per
`.env.example`): primary `gemini-3.1-flash-lite`, fallback `gemini-3.5-flash-lite`.
MCP init fixed; Gemini tool-call `thought_signature` preserved through follow-ups;
Markdown-rendered answers. Keep provider architecture, API contracts, security, and
tool validation intact. Earlier objectives (timeline integrity, follow-up context,
frontend redesign) remain in effect.

## Completed
- **MCP init root cause FIXED (code):** `.env` was never loaded. Added `env.js`
  (zero-dep loader; real env wins; missing file is a no-op; `DUPTRACE_ENV_FILE`
  override) and imported+called it first in `server.js` and `agent.js`, so
  `DUPTRACE_MCP_URL` (which `agent.js` requires before connecting) is now defined.
- **Gemini fallback (code):** `createGeminiProvider` tries a chain — primary
  `MODEL_NAME`, then `MODEL_FALLBACK_MODELS`. `.env.example` configures primary
  `gemini-3.1-flash-lite`, fallback `gemini-3.5-flash-lite`. (When `MODEL_NAME` is
  empty, the code-level default primary is `gemini-3.5-flash-lite`.) Per-attempt
  timeout; retry only on 404/408/429/5xx/network/timeout/unparseable; 401/403/400/422
  fail fast (no retry); chain-exhausted → `MODEL_PROVIDER_UNAVAILABLE`.
  `provider.timeoutMs` scaled by chain length. `.env` + `.env.example` updated.
- **Gemini tool-calling fix (code):** function-call `thoughtSignature` retained
  (`parseGeminiResponse` → `geminiParts`) and replayed verbatim on the tool-result
  follow-up, resolving the live HTTP 400; synthetic ids not echoed to Gemini.
- **Tests added:** `_verify_env.mjs` (loader); provider fallback + `geminiModelChain`
  tests in `_verify_provider.mjs`; Phase C MCP-init checks in `_verify_web.mjs`;
  `package.json` test chain now includes `_verify_env.mjs`.
- Earlier: reference-led frontend redesign in `web/` (three-pane workspace, theme
  system, evidence classification, honest failure states). Native Gemini provider.

## Verification
- **`npm test`: 188 passed, 0 failed** (user-run, 2026-10-14). **`git diff --check`:
  no whitespace errors.** The suite covers the integrity, env-loader, format,
  markdown, provider (Gemini translation incl. `thought_signature` + fallback chain,
  mocked), and web/API (incl. MCP-init Phase C) checks. Model providers are mocked —
  the suite makes no real API calls.
- Live Gemini API (user-confirmed earlier): `gemini-3.1-flash-lite` 200,
  `gemini-3.5-flash-lite` 200; `gemini-2.5-flash` / `-lite` 404 for this key.

## Not Yet Verified
- A live end-to-end investigation through the running app (real Gemini call + browser
  UI): theme toggle/persistence, streaming, follow-up, and error/partial states. The
  passing suite uses mocked providers, so it does not prove a live request.
- Final staged-diff review + commit (brief: do not commit).

## Next Actions
1. Live end-to-end check with a real key: `npm run agent -- "What's wrong with payments?"`
   and a browser pass of the UI.
2. Commit only after final review and explicit approval.

## Last Updated
2026-10-14 — Recorded the user's `npm test` 188/0 pass and clean `git diff --check`,
and reconciled the configured model summary with `.env.example` (primary
`gemini-3.1-flash-lite`, fallback `gemini-3.5-flash-lite`). Recent code this cycle:
Gemini `thought_signature` preserved through tool-result follow-ups; Markdown
rendering for assistant answers. Docs (README, `.env.example`, LICENSE section,
no-auth security note) updated. The 2026-10-11 snapshot below is archived history.

## Archived snapshot — 2026-10-11 frontend redesign (historical; superseded above)
- Frontend redesign (web/index.html, web/styles.css, web/app.js) — NOT committed:
  - Three-pane shell: compact left rail (recent investigations + New + theme toggle),
    center conversation+composer (priority, ~46rem measure), right collapsible
    inspector. Responsive: inspector→drawer <1120px, rail→drawer <760px, scrim +
    Escape + focus handling.
  - Genuine theme system: `data-theme` on <html>, full light+dark token sets, inline
    pre-paint bootstrap (no FOUC), localStorage persistence, system-pref fallback via
    guarded `@media (prefers-color-scheme)`, live OS-change listener when unset.
  - Multi-investigation threads persisted to localStorage (recent list real across
    reloads); switching blocked while a turn is in flight; errors/partials ephemeral.
  - Inspector shows only REAL derived context: incident/service (validated
    deriveContext), check counts, distinct tools, conversationId provenance, standing
    correlation≠causation note + any real causalityConfirmed:false caveat.
  - Reference-led refinements (Morrow/KNOT/Clasp): answer labelled "Conclusion" vs
    panel "Observed evidence" (claim/evidence boundary); stable error-code chip;
    dedicated partial-result state; empty-state positioning eyebrow.
  - Final quality pass: per-row evidence classification (observed/correlation/
    confirmed/No-data/error) from REAL fields only — deployment never auto-labelled
    cause; WCAG-AA contrast (functional text --faint→--muted; --faint now decorative
    only); restraint (selected state de-blued to neutral surface + thin accent marker;
    inspector metrics → divider stat row; panel head two-tone removed; panel widths
    rebalanced); drawer open/close focus management.
  - XSS-safe throughout (textContent + createElementNS icons; no innerHTML). Browser
    still talks only to /api/chat and /api/chat/stream. No new deps.
  - api.js (transport contract) and format.js (pure tested formatters) UNCHANGED.
- Native Gemini provider (`MODEL_PROVIDER=gemini`): createGeminiProvider() via built-in
  fetch + generateContent; x-goog-api-key auth; default model gemini-2.5-flash;
  message→contents translation; JSON Schema → Gemini subset; sanitized errors; no SDK.
  (agent.js, .env.example, _verify_provider.mjs — another session's work, untouched here.)

### Verification (2026-10-11, historical)
- Frontend redesign: NOT YET RUN this session — the command-safety classifier (powered
  by the same model that is in a broader availability outage) is intermittently refusing
  all Bash/PowerShell, so `node --check` and `npm test` could not complete. Exhaustive
  static review done: all els IDs exist in index.html; _verify_web static-asset contracts
  preserved (DupTrace text, id="composer", app.js ref, format.js import, no secret
  sentinels); dark-token blocks complete; streaming/fallback/contract code preserved.
- Prior suites (last recorded, user-run): integrity 17/0, formatting 35/0, provider 13/0,
  web 37/0; `npm audit` 0 vulns.

### Not Yet Verified (2026-10-11, historical)
- `npm test` with the redesigned frontend (expected all-pass; frontend changes don't
  touch server-side paths the web harness exercises, only the static assets it checks).
- Live browser pass: theme toggle + persistence + system-pref, responsive drawers,
  keyboard/focus, streaming/follow-up/error/partial states, contrast.
- Final staged-diff review; commit + push (awaiting approval).

### Next Actions (2026-10-11, historical)
1. When the classifier recovers: `node --check web/app.js` then `npm test`; fix any
   failure and re-run.
2. Live browser verification of theme/persistence/responsive/a11y/states.
3. Review the staged diff for secrets/unrelated files.
4. Commit only after final review and explicit approval (brief: do not commit/push).

### Last Updated (2026-10-11, historical)
2026-10-11 — Reference-led frontend redesign implemented in web/ (not committed).
Verification pending on classifier recovery.
