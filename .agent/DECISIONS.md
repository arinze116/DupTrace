# Decisions

Important architectural, security, dependency, and product decisions.

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
