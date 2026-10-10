// api.js — the single boundary between the browser UI and the DupTrace server.
//
// The browser talks ONLY to POST /api/chat on the same origin. It never calls
// MCP directly, never holds a model API key, and never sees MCP configuration.
// runAgent() on the server owns the agent loop and the MCP client; this module
// just carries a request across and normalises whatever comes back into a small
// discriminated union the UI can render without guessing.

/** @typedef {{ activeIncidentId: (string|null), service: (string|null) }} ChatContext */
/** @typedef {{ message: string, conversationId: (string|null), context?: (ChatContext|null) }} ChatRequest */
/** @typedef {{ role: "assistant", content: string }} AssistantMessage */
/**
 * One tool invocation the server performed while investigating. Shape-agnostic:
 * the UI must not assume any DupTrace-specific field beyond what is listed here.
 * @typedef {{
 *   step?: number,
 *   tool: string,
 *   arguments?: Record<string, unknown>,
 *   isError?: boolean,
 *   result?: unknown
 * }} ToolActivity
 */
/**
 * @typedef {{
 *   ok: true,
 *   conversationId: (string|null),
 *   message: AssistantMessage,
 *   toolActivity: ToolActivity[]
 * }} ChatResponse
 */
/**
 * A failure the UI can present safely. `kind` distinguishes a transport failure
 * (never reached the server) from an HTTP-level error (server answered non-2xx
 * or ok:false). `code`/`status` steer the user-facing wording in app.js.
 * @typedef {{
 *   ok: false,
 *   kind: ("http"|"network"),
 *   status?: number,
 *   code?: string,
 *   message: string
 * }} APIError
 */
/** @typedef {ChatResponse | APIError} ChatResult */

const ENDPOINT = "/api/chat";

/**
 * Send one turn to DupTrace and return a normalised result.
 *
 * Never throws: a network failure, a non-JSON body, or an error envelope all
 * resolve to an APIError. The UI can therefore branch on `result.ok` alone.
 *
 * @param {ChatRequest} request
 * @returns {Promise<ChatResult>}
 */
export async function sendChat({ message, conversationId = null, context = null }) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ message, conversationId, ...(context ? { context } : {}) }),
    });
  } catch {
    // DNS failure, connection refused, offline — the request never landed.
    return {
      ok: false,
      kind: "network",
      message: "Unable to reach DupTrace.",
    };
  }

  // The server sends JSON for both success and its error envelope, but a proxy
  // or crash could still return something else. Parse defensively.
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body — handled by the fall-through below */
  }

  if (res.ok && body && body.ok === true) {
    return {
      ok: true,
      conversationId: body.conversationId ?? null,
      message: body.message ?? { role: "assistant", content: "" },
      toolActivity: Array.isArray(body.toolActivity) ? body.toolActivity : [],
    };
  }

  // Error envelope from the server is { ok:false, error:{ code, message } }.
  // We surface the server's code so the UI can map it, but we do not blindly
  // trust its message to be user-appropriate — app.js decides the final text.
  const code = body?.error?.code;
  const safeMessage =
    typeof body?.error?.message === "string" ? body.error.message : "";
  return {
    ok: false,
    kind: "http",
    status: res.status,
    code,
    message: safeMessage,
  };
}

/**
 * One streamed event from POST /api/chat/stream, discriminated by `type`.
 * @typedef {(
 *   { type: "start", conversationId: (string|null) } |
 *   { type: "activity", activity: ToolActivity } |
 *   { type: "answer", conversationId: (string|null), message: AssistantMessage, toolActivity: ToolActivity[] } |
 *   { type: "done" } |
 *   { type: "error", conversationId?: (string|null), error?: { code?: string, message?: string }, toolActivity?: ToolActivity[] }
 * )} StreamEvent
 */

const STREAM_ENDPOINT = "/api/chat/stream";

/**
 * Send one turn and consume the server's SSE progress stream.
 *
 * Invokes `onEvent` for each real event as it arrives (start, activity, answer,
 * done, error) so the UI can render progressively, and resolves to the SAME
 * normalised ChatResult as sendChat() once the stream ends — so a caller gets
 * both the live events and one authoritative final result. Never throws: a
 * transport failure, a pre-stream HTTP error, or a cut connection all resolve to
 * an APIError, exactly like sendChat().
 *
 * @param {ChatRequest & { onEvent?: (event: StreamEvent) => void, signal?: AbortSignal }} request
 * @returns {Promise<ChatResult>}
 */
export async function streamChat({ message, conversationId = null, onEvent, signal, context = null }) {
  let res;
  try {
    res = await fetch(STREAM_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ message, conversationId, ...(context ? { context } : {}) }),
      signal,
    });
  } catch {
    // Never landed (offline, refused, aborted before response).
    return { ok: false, kind: "network", message: "Unable to reach DupTrace." };
  }

  // A pre-stream rejection (400 validation, 403 origin) arrives as a normal JSON
  // envelope, never as SSE. Mirror sendChat()'s HTTP-error branch exactly.
  const contentType = res.headers.get("content-type") || "";
  if (!res.ok || !contentType.includes("text/event-stream") || !res.body) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body — fall through to a generic HTTP error */
    }
    return {
      ok: false,
      kind: "http",
      status: res.status,
      code: body?.error?.code,
      message: typeof body?.error?.message === "string" ? body.error.message : "",
    };
  }

  // Consume the SSE stream: decode, split on blank-line frame boundaries, parse
  // each `data:` payload. Accumulate the authoritative final state so the
  // resolved result equals what sendChat() would have returned for the same turn.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let resultConversationId = conversationId ?? null;
  let answer = /** @type {AssistantMessage} */ ({ role: "assistant", content: "" });
  let toolActivity = /** @type {ToolActivity[]} */ ([]);
  let failure = /** @type {APIError|null} */ (null);
  let sawDone = false;

  const dispatch = (event) => {
    if (!event || typeof event.type !== "string") return;
    switch (event.type) {
      case "start":
        resultConversationId = event.conversationId ?? resultConversationId;
        break;
      case "answer":
        resultConversationId = event.conversationId ?? resultConversationId;
        if (event.message) answer = event.message;
        if (Array.isArray(event.toolActivity)) toolActivity = event.toolActivity;
        break;
      case "done":
        sawDone = true;
        break;
      case "error":
        failure = {
          ok: false,
          kind: "http",
          status: res.status,
          code: event.error?.code,
          message:
            typeof event.error?.message === "string" ? event.error.message : "",
        };
        break;
      default:
        break;
    }
    try {
      onEvent?.(event);
    } catch {
      /* a render-callback error must not abort stream consumption */
    }
  };

  const drainFrame = (frame) => {
    // One SSE frame may hold multiple `data:` lines; concatenate them per spec.
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return;
    let event = null;
    try {
      event = JSON.parse(data);
    } catch {
      return; // malformed frame — skip it rather than tear down the stream
    }
    dispatch(event);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        drainFrame(frame);
      }
    }
    // Flush any trailing frame that lacked a terminating blank line.
    buffer += decoder.decode();
    if (buffer.trim()) drainFrame(buffer);
  } catch {
    // Mid-stream transport failure (connection dropped / aborted). If no in-band
    // error was recorded, surface it as a network failure.
    if (!failure) {
      return { ok: false, kind: "network", message: "Unable to reach DupTrace." };
    }
  }

  if (failure) return failure;

  if (!sawDone) {
    // Ended without a clean `done` and without an error event — the connection
    // was cut mid-investigation.
    return { ok: false, kind: "network", message: "Unable to reach DupTrace." };
  }

  return {
    ok: true,
    conversationId: resultConversationId,
    message: answer,
    toolActivity,
  };
}
