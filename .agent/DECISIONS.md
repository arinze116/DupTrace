# Decisions

Important architectural, security, dependency, and product decisions.

## 2026-10-14 — Gemini thought_signature preserved through tool-call follow-up

- **Root cause of the live HTTP 400 `INVALID_ARGUMENT` ("Function call is missing a
  thought_signature in functionCall parts").** `parseGeminiResponse` returned only
  the neutral `{id,name,arguments}` for each tool call and discarded the raw response
  parts, including the signed `thoughtSignature` Gemini 3.x attaches to every
  `functionCall` part. `toGeminiRequest` then RECONSTRUCTED the functionCall from
  `{name,args,id}`, so the follow-up request (model turn + functionResponse) carried
  no signature → Gemini rejects it. Mocked tests never included a signature, so
  152 checks passed while the live call failed.
- **Fix: retain + replay the original parts (not reconstruct).** `parseGeminiResponse`
  now also returns `geminiParts` = the model's original `candidate.content.parts`.
  `toGeminiRequest` replays those verbatim as the `model` turn when present, so the
  `thoughtSignature` (and text/order) survive exactly as Gemini sent them. The neutral
  `toolCalls` contract is unchanged; `geminiParts` is Gemini-internal — never
  serialized to the client, never read by the openai-compatible/claude-cli providers.
- **Synthetic ids are never echoed to Gemini.** When Gemini omits a functionCall id we
  still mint `gemini-tool-N` for the neutral layer (OpenAI tool_call_id + agent-loop
  mapping), but both the replay/reconstruction and the functionResponse now suppress
  ids matching `^gemini-tool-\d+$`, keeping call/response symmetric with Gemini's
  own single-call convention (a real model-supplied id is still echoed on both sides).
- **Not done (per constraints):** no fabricated signatures, no disabling tools, no
  suppressing the 400, no provider rewrite. Multiple parallel calls preserve per-call
  signatures and result ordering (regression-tested).
- **Model order (deadline brief):** `.env` primary `gemini-3.1-flash-lite`, fallback
  `gemini-3.5-flash-lite` — a practical swap, not a claimed fix; the signature fix is
  what actually resolves the 400 (3.1 is also a thinking model with the same rule).

## 2026-10-12 — Gemini model fallback + MCP init root cause (.env never loaded)

- **Root cause of the MCP initialization/tool-discovery failure: `.env` was never
  loaded.** The entry points (`tsx server.js`, `node agent.js`) run the file
  directly; nothing called dotenv / `--env-file` / `process.loadEnvFile`. `agent.js`
  requires `DUPTRACE_MCP_URL` (`getRequiredEnvironment`) BEFORE it connects, so with
  `.env` inert that variable was `undefined` and `createDupTraceClient` threw
  `MCP_UNAVAILABLE` before any connect or `tools/list`. Not a tool-discovery bug and
  not fixed by changing the model. The `_verify_web.mjs` harness only passed because
  it exports `DUPTRACE_MCP_URL` explicitly to the child.
- **Fix: a zero-dependency `.env` loader (`env.js`), imported first by server.js and
  agent.js.** Real environment variables ALWAYS win (`process.env[key] === undefined`
  is the only write condition), so shell overrides and the test harnesses stay
  authoritative. A missing file is a silent no-op. `DUPTRACE_ENV_FILE` overrides the
  path (deployments/tests). No new dependency; `import` hoisting is fine because the
  top-level `loadEnvFile(...)` call runs before the config constants below it.
- **Model fallback chain.** Primary = `MODEL_NAME`; then `MODEL_FALLBACK_MODELS`
  (comma-separated, default `gemini-3.1-flash-lite`). Verified-live IDs only:
  `gemini-3.5-flash-lite` (primary) → `gemini-3.1-flash-lite` (fallback). The old
  in-code default `gemini-2.5-flash` was wrong for this key (404) and is replaced.
- **Retry policy is deliberate.** Only transient/unavailable outcomes advance the
  chain: 404, 408, 429, 5xx, network failure, timeout, non-JSON/unparseable body.
  401/403 (bad key) and 400/422 (bad request) are PERMANENT — thrown immediately
  without a second attempt, so an auth/config problem is never masked by a fallback.
- **Per-attempt timeout, chain-aware outer bound.** Each model attempt gets its own
  `AbortController` bounded by `MODEL_TIMEOUT_MS`; `provider.timeoutMs` is
  `MODEL_TIMEOUT_MS × chain length` so `runAgent`'s outer `withTimeout` doesn't abort
  mid-fallback. Key still travels only in `x-goog-api-key`, never logged.
- **Tests:** new `_verify_env.mjs` (loader: file-only var loads, real env wins,
  missing file no-op; + the real repo `.env` exposes `DUPTRACE_MCP_URL`). Provider
  tests gain `geminiModelChain` unit checks + fallback behaviour (404/429 fall back;
  403 does NOT retry — 1 attempt; all-fail → `MODEL_PROVIDER_UNAVAILABLE` — 2
  attempts). `_verify_web.mjs` gains Phase C: server spawned pointing at a temp `.env`
  (no exported `DUPTRACE_MCP_URL`) connects MCP (error is `MODEL_PROVIDER_*`, not
  `MCP_*`), with a negative control (no `.env`, no var → `MCP_UNAVAILABLE`).

## 2026-10-11 — Final frontend quality pass (reference-led)

- **Reference study drove concrete, not cosmetic, changes.** Studied 5 live products;
  Morrow/KNOT/Clasp (server-rendered) gave usable patterns. Adopted KNOT's claim-vs-
  evidence separation, Morrow's verification/rejection framing, Clasp's honest
  structured-failure framing.
- **Defensible evidence classification (`classifyEvidence`).** Each evidence row is
  tagged from REAL returned fields only — never timing/inference: `error` (isError),
  `empty`/"No data" (no result or resultIsEmpty), `correlation` (structuredContent
  .causalityConfirmed === false → ochre tag + ochre spine node), `confirmed`
  (causalityConfirmed === true), `observed` (default, no tag — the "Observed
  evidence" header frames it). A deployment is NEVER auto-labelled the cause of an
  incident; correlation stays visibly distinct from causation. Answer is labelled
  "Conclusion" only when backed by evidence AND non-empty.
- **Contrast discipline (WCAG AA).** A "faint" text tier cannot be AA on near-white/
  near-black (AA caps the lightest gray near #767676), so ALL functional text moved
  from `--faint` to `--muted` (AA in both themes); `--faint` now only paints
  decorative dots, the offline ring, and the placeholder. Two honest text tiers
  (fg / muted) instead of an inaccessible three.
- **Restraint fixes.** Selected investigation uses a neutral `--surface-2` fill + a
  thin accent left-bar + accent dot + weight (no oversized blue highlight); inspector
  "Evidence gathered" became a divider-separated stat row (not bordered tiles);
  investigation panel head is transparent (removed the panel-in-panel two-tone); rail
  260 / inspector 300 / measure 47rem rebalanced to give evidence more room.
- **Honest failure states.** Dedicated partial-result state (evidence preserved, "no
  conclusion reached", retry) distinct from a full error; both show a stable
  machine-readable code chip (e.g. MODEL_PROVIDER_UNAVAILABLE / INVALID_REQUEST /
  NETWORK) — never server internals or stack traces.
- **Drawer focus management.** Opening a drawer moves focus into it; closing (button/
  Escape/scrim) returns focus to the trigger; collapsing the docked inspector moves
  focus off the now-hidden close button back to the toggle.

## 2026-10-11 — Frontend redesign: three-pane investigation workspace + theme system

- **Scope fence.** Only `web/index.html`, `web/styles.css`, `web/app.js` change.
  `web/api.js` (the browser↔server transport contract) and `web/format.js` (pure,
  unit-tested data-integrity formatters) are left byte-for-byte intact so
  `_verify_format.mjs` and the `_verify_web.mjs` static-asset/contract checks keep
  passing. `agent.js`, `.env.example`, `_verify_provider.mjs` are another session's
  uncommitted Gemini work and are NOT touched.
- **Three-pane layout, not a dashboard.** Compact left rail (brand + "New
  investigation" + recent list + theme toggle), center investigation (topbar +
  scrolling conversation + composer, held to a ~46rem reading measure), right
  collapsible inspector. Deliberately avoids the generic four-stat-card dashboard,
  neon/terminal security clichés, glassmorphism, and gradient CTAs.
- **Signature motif = the "trace spine".** Investigation steps are linked by a thin
  vertical spine with node markers (a signal-trace metaphor specific to DupTrace).
  It is structural neutral line-work, never a decorative gradient/chart.
- **Disciplined 3-accent color system on a neutral spine.** Blue is reserved for
  interactive/selected emphasis (primary send, selected investigation, focus,
  links); red only for a genuine error state; ochre only for an uncertainty caveat.
  State is never color-only — always paired with text and/or shape (icons, labels).
- **Genuine theme system.** `data-theme` on `<html>`; complete light + dark token
  sets. A tiny inline head script sets the attribute before first paint (no FOUC)
  from `localStorage("duptrace.theme")`, falling back to `prefers-color-scheme`.
  CSS also carries a `@media (prefers-color-scheme: dark)` fallback guarded by
  `:root:not([data-theme="light"])` so system dark works with JS disabled while an
  explicit light choice still wins. Toggle persists the choice; when no explicit
  choice is stored, a live `matchMedia` listener follows the OS.
- **Multi-investigation state, honestly scoped.** Each investigation == one
  conversation thread `{ id, title, conversationId, context, turns[] }`. "New
  investigation" starts a fresh thread (resets conversationId + context). Threads
  (the user's own questions + the server's returned answers/activity) persist to
  `localStorage("duptrace.investigations.v1")` so the "Recent" list is real across
  reloads. This stores only data the browser already received and rendered; model
  API keys/provider URLs never reach the client, so nothing secret is persisted.
  Switching threads is blocked while a turn is in flight (composer already guards
  this) to avoid cross-thread races; errors are rendered but not persisted.
- **Inspector shows only real, derived context.** Active incident / service from the
  validated `deriveContext` output; checks run / successful / errored and the
  distinct tools used, computed from the thread's actual toolActivity; a standing
  methodological note that DupTrace reports correlation/evidence and does not assert
  causation; plus any real `causalityConfirmed:false` caveats surfaced from the data;
  and the conversationId as provenance. It never fabricates findings.
- **Rendering stays XSS-safe.** All dynamic text still reaches the DOM via
  `textContent`; the new icon set is built with `createElementNS` (no `innerHTML`),
  preserving the "never innerHTML" invariant. The browser still talks only to
  `/api/chat` and `/api/chat/stream`.
- **No new dependencies, no build step.** Still vanilla ES modules + CSS. Icons are a
  single hand-authored inline-SVG stroke family (no emoji, no icon-font dependency).

## 2026-10-11 — Native Gemini provider

- **No SDK; built-in fetch + REST `generateContent`.** Keeps the zero-extra-dependency posture and
  matches the openai-compatible provider's shape (`{name, timeoutMs, complete}`).
- **Auth via `x-goog-api-key` header, never the URL/query.** Key is never logged; request bodies,
  prompts, and raw provider error messages are never logged — failures surface only HTTP status +
  Google status enum (e.g. RESOURCE_EXHAUSTED). All failure paths throw `MODEL_PROVIDER_UNAVAILABLE`.
- **Gemini base URL is fixed, NOT read from `MODEL_BASE_URL`.** That env commonly holds the
  openai-compatible URL; reusing it would silently misroute Gemini. Model defaults to
  `gemini-2.5-flash` only when `MODEL_NAME` is empty.
- **Message translation is a pure, exported function** (`toGeminiRequest`) with a schema converter
  (`toGeminiSchema`) and response parser (`parseGeminiResponse`), so they're unit-testable with a
  mocked fetch and without a key. Decisions inside: system turns → `system_instruction`; tool calls
  → `functionCall` parts and tool results → `functionResponse` parts with ids preserved; adjacent
  same-role turns are coalesced (Gemini wants one content per role turn — handles injected context +
  user, and parallel function responses); JSON Schema is whitelisted into Gemini's OpenAPI subset
  (drops `$schema`/`additionalProperties`/`$ref`/`const`/`oneOf`… which otherwise 400 the request);
  function-call ids are preserved when present, else a stable `gemini-tool-N` fallback.
- **Only the discovered MCP tools are declared** — no tools beyond the read-only list are ever exposed.
- Investigation loop, evidence/causality guardrails, and the other two providers are untouched.

## 2026-10-10 — Timeline integrity + explicit follow-up context

- **Timeline source of truth = 10:44.** `deployment.completedAt` and `EVT-2026-0902.occurredAt` both
  say 10:44; the lone outlier was `TL-2026-001-B.timestamp` (10:50) which also *links* that 10:44
  event. Fixed the one fixture value, not the answer (the answer was already correct).
- **New pure modules instead of exporting from server.js.** `fixture_integrity.js` and
  `chat_context.js` hold the testable logic. Importing `server.js` in a test would run `app.listen`
  and hang/port-bind; rather than risk an `app.listen` guard that could break `npm start` (tsx) or
  the spawn harness, the rules live in dependency-free modules that server.js and agent.js import.
  Mirrors the existing `format.js` / `parseClaudeAgentResponse` precedent.
- **Context is explicit + validated + labelled, never trusted raw.** Client derives
  `{activeIncidentId, service}` from VERIFIED structured tool results (not prose); server re-validates
  against real fixtures (`incidents` ids + `supportedServices`) and drops anything inconsistent; the
  agent injects it as a clearly-labelled prior-turn **user** message (user role, so the claude-cli
  `buildCliPrompt` transcript — which filters only `system` — still includes it) that says it is not
  evidence, that tools must still run, and that the current request overrides it.
- **conversationId left as-is (not repurposed), per constraint.** A separate `context` field carries
  the hint. Schema change is additive/optional → omitting context is fully backward-compatible.
- **Discovery preserved when context absent/invalid:** `buildContextMessage(null)` → no injection →
  messages identical to before.

## 2026-10-09 — Trace/evidence presentation

- **Extract pure formatters into `web/format.js`.** The data-integrity rules (labels, previews,
  facts, IDs, timestamps) were DOM-coupled inside app.js, so they could not be tested in Node
  without a DOM library (a forbidden dependency). Moved them to a pure module; app.js imports
  them. Single source of truth, mechanically behaviour-preserving, and directly unit-testable.
- **Preview collections as counts, not JSON.** `previewOf` dumped array fields (`incidents`,
  `evidence`, `candidates`) as truncated JSON — the core readability defect. Now: "N evidence —
  <first real observation>" plus humanized scalars.
- **Humanize timestamps/booleans/confidence; add a facts list.** `structuredFacts` renders a
  compact `<dl>` of the REAL returned fields, compresses numeric objects (latency →
  "p50 180 / p95 920 / p99 1840"), and summarizes arrays by count.
- **Keep confirmed vs hypothesis distinct.** When the dataset carries `causalityConfirmed: false`,
  show an explicit caveat note rather than implying causation; never invent a confidence.
- **No empty raw block.** `resultIsEmpty` suppresses the Raw `<details>` when a result has no
  structured content/content/other keys.
- **Counts + activity already correct** (verified, not changed): the count is `activity.length`
  (dynamic, not hardcoded to 2) and activity is strictly per-turn (no stale/cross-response rows).

## 2026-10-09 — claude-cli provider fix

- **Provider-specific timeout.** The uniform 60s `MODEL_TIMEOUT_MS` is wrong for the claude-cli
  provider (CLI turns take ~80s+). Added `MODEL_CLI_TIMEOUT_MS` (default 180s), exposed as
  `provider.timeoutMs`, and made runAgent's outer `withTimeout` honour it. openai keeps 60s. Chosen
  over globally raising the timeout (which would over-loosen the fast hosted path).
- **Timeout must terminate the child.** `withTimeout` only loses a Promise race and holds no child
  handle, so a timed-out CLI ran on as an orphan. The provider now owns an internal timer that
  SIGTERM→(2s)→SIGKILLs the child and rejects with a coded error, independent of the outer race.
- **Explicit JSON-schema prompt.** The CLI was never told to emit `{type:"tool_calls"|"final"}`;
  the `responseFormat` blob was inert and the model returned prose that failed parsing. Rewrote the
  stdin prompt to state the contract with examples + tool catalog + transcript, keeping the DupTrace
  rules in `--system-prompt` (that arg is proven to pass the Windows shell; the complex content goes
  via stdin to avoid shell-quoting risk). Orchestration preserved: Claude proposes tool_calls → server
  runs MCP → results fed back next turn.
- **`parseClaudeAgentResponse` extracted + exported** purely for unit-testability; no behaviour change
  to the parse itself. `createClaudeCliProvider` exported so stub-CLI tests can exercise it without MCP.
- **Sanitized diagnostics.** Server logs category + exit code + timeout + a whitespace-collapsed,
  clipped stderr line; never stdout, prompts, request bodies, or credentials. Client errors stay
  generic via the existing server.js redaction.

- **Event-level SSE, not token streaming.** The model provider returns each completion in one
  blocking call (openai path `await response.json()`; claude-cli buffers a subprocess) — it does not
  stream tokens. Real, honest progress is therefore the tool activity as it happens plus the final
  answer. A client-side typewriter would be fake (brief forbids artificial delays); token streaming
  would require rewriting the provider call path (brief forbids rewriting the engine). User chose
  event-level.
- **Separate `/api/chat/stream` endpoint, not content-negotiation on `/api/chat`.** Keeps the
  verified JSON contract byte-identical (existing 21 harness checks stay green), inherits the same
  app-level host/origin guard + body parser, and leaves `sendChat` as a live fallback. EventSource
  can't POST a body, so the browser consumes the stream via `fetch().body.getReader()`.
- **`onEvent` on `runAgent` is optional + side-effect-only.** Emitted at the existing `activity.push`
  seam; the returned result is identical with or without it, so `/api/chat` and the CLI are unchanged.
- **In-band sanitized error events.** After headers flush there is no HTTP status to set, so a
  mid-stream failure travels as an `error` event carrying only the stable code + canned message
  (shared `chatErrorInfo`), never `error.message`. Status codes stay meaningful on the pre-stream
  (400/403) path.
- **Out of scope (deliberate):** `AbortSignal` threading into `runAgent` for true upstream
  cancellation; token-level `answer_delta` events (protocol leaves room to add them later without a
  contract change).
