// _verify_provider.mjs — focused runtime tests for model providers.
//
// This harness is part of the npm test suite. It does not call real model APIs.
// It tests pure response/schema translation, the Claude CLI using a stub,
// and Gemini using mocked fetch responses. No real API key is required.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "_stub_claude.mjs");
const TIMEOUT_MS = 8000;
const GEMINI_TIMEOUT_MS = 1000;

// Must be set before importing agent.js — it reads these timeouts once at load.
process.env.MODEL_CLI_TIMEOUT_MS = String(TIMEOUT_MS);
process.env.MODEL_TIMEOUT_MS = String(GEMINI_TIMEOUT_MS);

const {
  parseClaudeAgentResponse,
  createClaudeCliProvider,
  createGeminiProvider,
  toGeminiRequest,
  toGeminiSchema,
  parseGeminiResponse,
} = await import("./agent.js");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

// A stub that stands in for `claude --print --output-format json ...`. It ignores
// its CLI flags, drains stdin, and emits an envelope chosen by STUB_SCENARIO —
// mirroring the CLI's real `{ "result": "<text>" }` shape, where the text is the
// single JSON object our prompt instructs the model to return.
const stubSource = `
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const scenario = process.env.STUB_SCENARIO;
  if (scenario === "exit") {
    process.stderr.write("stub failure detail that must stay server-side");
    process.exit(3);
  }
  if (scenario === "hang") {
    setTimeout(() => process.exit(0), 20000); // longer than TIMEOUT_MS; provider kills us first
    return;
  }
  const inner =
    scenario === "tool_calls"
      ? { type: "tool_calls", toolCalls: [{ id: "call_1", name: "get_service_health", arguments: { service: "payments" } }] }
      : { type: "final", content: "stub final answer" };
  process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify(inner) }));
  process.exit(0);
});
`;

const tools = [
  { name: "get_service_health", description: "Read-only health check.", inputSchema: { type: "object" } },
];
const messages = [{ role: "user", content: "What's wrong with payments?" }];

async function runProvider(scenario) {
  process.env.STUB_SCENARIO = scenario;
  // Invoke the stub through node; shell:true (win32) appends the provider's flags,
  // which the stub ignores.
  process.env.MODEL_CLI_COMMAND = `"${process.execPath}" "${STUB}"`;
  const provider = createClaudeCliProvider();
  const started = Date.now();
  try {
    const value = await provider.complete(messages, tools);
    return { ok: true, value, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error, ms: Date.now() - started };
  }
}

async function main() {
  writeFileSync(STUB, stubSource);

  try {
    console.log("\nparseClaudeAgentResponse — pure schema handling");

    const fin = parseClaudeAgentResponse(
      JSON.stringify({ result: JSON.stringify({ type: "final", content: "done" }) }),
    );
    check(
      "parses a final response",
      fin.content === "done" && Array.isArray(fin.toolCalls) && fin.toolCalls.length === 0,
    );

    const tc = parseClaudeAgentResponse(
      JSON.stringify({
        result: JSON.stringify({
          type: "tool_calls",
          toolCalls: [{ name: "get_service_health", arguments: { service: "payments" } }],
        }),
      }),
    );
    check(
      "parses tool_calls (and backfills a missing id)",
      tc.toolCalls.length === 1 &&
        tc.toolCalls[0].name === "get_service_health" &&
        tc.toolCalls[0].arguments.service === "payments" &&
        typeof tc.toolCalls[0].id === "string" &&
        tc.toolCalls[0].id.length > 0,
    );

    const fenced = parseClaudeAgentResponse(
      JSON.stringify({ result: '```json\n{"type":"final","content":"fenced"}\n```' }),
    );
    check("tolerates a ```json fenced inner payload", fenced.content === "fenced");

    const viaContent = parseClaudeAgentResponse(
      JSON.stringify({ content: JSON.stringify({ type: "final", content: "c" }) }),
    );
    check("falls back to envelope.content when result is absent", viaContent.content === "c");

    let threwNonJson = false;
    try {
      parseClaudeAgentResponse("not a json envelope at all");
    } catch {
      threwNonJson = true;
    }
    check("throws on a non-JSON envelope (malformed CLI output)", threwNonJson);

    let threwUnknown = false;
    try {
      parseClaudeAgentResponse(JSON.stringify({ result: JSON.stringify({ type: "chat", text: "hi" }) }));
    } catch {
      threwUnknown = true;
    }
    check("throws on an unrecognised agent schema", threwUnknown);

    console.log("\ncreateClaudeCliProvider — process behaviour (stub CLI)");

    check("provider exposes its own timeoutMs", createClaudeCliProvider().timeoutMs === TIMEOUT_MS);

    const okFinal = await runProvider("final");
    check(
      "stub final → resolves with assistant content",
      okFinal.ok && okFinal.value.content === "stub final answer" && okFinal.value.toolCalls.length === 0,
      okFinal.ok ? "" : String(okFinal.error?.code),
    );

    const okTools = await runProvider("tool_calls");
    check(
      "stub tool_calls → resolves with a tool call",
      okTools.ok &&
        okTools.value.toolCalls.length === 1 &&
        okTools.value.toolCalls[0].name === "get_service_health",
      okTools.ok ? "" : String(okTools.error?.code),
    );

    const nonzero = await runProvider("exit");
    check(
      "nonzero CLI exit → rejects as MODEL_PROVIDER_UNAVAILABLE",
      !nonzero.ok && nonzero.error?.code === "MODEL_PROVIDER_UNAVAILABLE",
      nonzero.ok ? "unexpected resolve" : String(nonzero.error?.code),
    );
    check(
      "nonzero CLI exit → error message does not leak stub stderr",
      !nonzero.ok && !String(nonzero.error?.message || "").includes("stub failure detail"),
    );

    const timedOut = await runProvider("hang");
    check(
      "hanging CLI → times out as MODEL_PROVIDER_UNAVAILABLE",
      !timedOut.ok && timedOut.error?.code === "MODEL_PROVIDER_UNAVAILABLE",
      timedOut.ok ? "unexpected resolve" : String(timedOut.error?.code),
    );
    check(
      "timeout fires within budget, before the 20s stub (child terminated)",
      !timedOut.ok && timedOut.ms < 12000,
      `${timedOut.ms}ms`,
    );
  } finally {
    try {
      unlinkSync(STUB);
    } catch {
      /* ignore */
    }
  }

  // =========================================================================
  // Gemini provider — pure translation/parsing + mocked-fetch behaviour.
  // =========================================================================
  console.log("\nparseGeminiResponse / toGeminiRequest / toGeminiSchema — pure");

  const throwsP = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  const geminiTools = [
    {
      name: "get_service_health",
      description: "Read-only health check.",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: {
          service: { type: "string", enum: ["payments", "auth", "checkout", "notifications"] },
        },
        required: ["service"],
      },
    },
  ];

  const schema = toGeminiSchema(geminiTools[0].inputSchema);
  check(
    "schema: object type + required preserved",
    schema.type === "OBJECT" && Array.isArray(schema.required) && schema.required[0] === "service",
  );
  check(
    "schema: unsupported keywords dropped ($schema, additionalProperties)",
    !("$schema" in schema) && !("additionalProperties" in schema),
  );
  check(
    "schema: nested enum/type preserved",
    schema.properties.service.type === "STRING" &&
      schema.properties.service.enum.includes("payments"),
  );

  const req = toGeminiRequest(
    [
      { role: "system", content: "SYS" },
      { role: "user", content: "What's wrong with payments?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_service_health", arguments: { service: "payments" } }] },
      { role: "tool", toolCallId: "c1", name: "get_service_health", result: { structuredContent: { status: "degraded" } } },
      { role: "user", content: "and now?" },
    ],
    geminiTools,
  );
  check("request: system turn → system_instruction", req.system_instruction?.parts?.[0]?.text === "SYS");
  check(
    "request: only the provided MCP tools are declared",
    req.tools?.[0]?.functionDeclarations?.length === geminiTools.length &&
      req.tools[0].functionDeclarations[0].name === "get_service_health",
  );
  check(
    "request: roles translate + function-call ids preserved (coalesced)",
    req.contents.map((c) => c.role).join(",") === "user,model,user" &&
      req.contents[1].parts[0].functionCall.id === "c1" &&
      req.contents[2].parts.some((p) => p.functionResponse?.id === "c1" && p.functionResponse?.name === "get_service_health"),
    req.contents.map((c) => c.role).join(","),
  );

  const textResp = parseGeminiResponse({
    candidates: [{ content: { role: "model", parts: [{ text: "Payments is degraded." }] }, finishReason: "STOP" }],
  });
  check("parse: plain text response", textResp.content === "Payments is degraded." && textResp.toolCalls.length === 0);

  const fcResp = parseGeminiResponse({
    candidates: [{ content: { parts: [{ functionCall: { name: "get_service_health", args: { service: "payments" } } }] } }],
  });
  check(
    "parse: function call → tool call with stable fallback id",
    fcResp.toolCalls.length === 1 &&
      fcResp.toolCalls[0].name === "get_service_health" &&
      fcResp.toolCalls[0].arguments.service === "payments" &&
      fcResp.toolCalls[0].id === "gemini-tool-1",
  );
  check(
    "parse: a provided function-call id is preserved",
    parseGeminiResponse({ candidates: [{ content: { parts: [{ functionCall: { id: "srv-9", name: "x", args: {} } }] } }] })
      .toolCalls[0].id === "srv-9",
  );
  check("parse: no candidates throws", throwsP(() => parseGeminiResponse({ candidates: [] })));
  check(
    "parse: function call without a name throws",
    throwsP(() => parseGeminiResponse({ candidates: [{ content: { parts: [{ functionCall: { args: {} } }] } }] })),
  );

  // -----------------------------------------------------------------------
  // thought_signature preservation — regression for the live HTTP 400
  // "Function call is missing a thought_signature in functionCall parts."
  // Gemini 3.x attaches a signed thoughtSignature to each functionCall part; it
  // MUST be echoed back verbatim on the follow-up request. Reconstructing the
  // call from {name,args,id} alone drops it. These checks use a realistic
  // response carrying thoughtSignature and assert the follow-up REQUEST keeps it.
  // -----------------------------------------------------------------------
  console.log("\nparseGeminiResponse / toGeminiRequest — thought_signature preservation");

  const tsPayload = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text: "Checking payments health." },
            {
              functionCall: { name: "get_service_health", args: { service: "payments" } },
              thoughtSignature: "Cj0BZ3Rob3VnaHRfc2lnbmF0dXJlX1RFU1Q=",
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  };
  const tsParsed = parseGeminiResponse(tsPayload);
  check(
    "thought_sig: neutral tool call still extracted (contract intact)",
    tsParsed.toolCalls.length === 1 && tsParsed.toolCalls[0].name === "get_service_health" && tsParsed.toolCalls[0].arguments.service === "payments",
  );
  check(
    "thought_sig: original signed model parts retained on the message",
    Array.isArray(tsParsed.geminiParts) &&
      tsParsed.geminiParts.some((p) => p.thoughtSignature === "Cj0BZ3Rob3VnaHRfc2lnbmF0dXJlX1RFU1Q="),
  );

  const tsFollow = toGeminiRequest(
    [
      { role: "system", content: "SYS" },
      { role: "user", content: "What's wrong with payments?" },
      tsParsed, // assistant turn carrying geminiParts
      { role: "tool", toolCallId: tsParsed.toolCalls[0].id, name: "get_service_health", result: { structuredContent: { status: "degraded" } } },
    ],
    geminiTools,
  );
  const tsModelTurn = tsFollow.contents.find((c) => c.role === "model");
  const tsFcPart = tsModelTurn?.parts?.find((p) => p.functionCall);
  check(
    "thought_sig: follow-up REQUEST replays functionCall WITH its thoughtSignature",
    !!tsFcPart && tsFcPart.thoughtSignature === "Cj0BZ3Rob3VnaHRfc2lnbmF0dXJlX1RFU1Q=" && tsFcPart.functionCall.name === "get_service_health",
  );
  check(
    "thought_sig: follow-up preserves the model's text part too (verbatim replay)",
    !!tsModelTurn && tsModelTurn.parts.some((p) => p.text === "Checking payments health."),
  );
  const tsFnResp = tsFollow.contents.find((c) => c.role === "user" && c.parts.some((p) => p.functionResponse));
  check(
    "thought_sig: tool result present and associated by name",
    !!tsFnResp && tsFnResp.parts.some((p) => p.functionResponse?.name === "get_service_health"),
  );
  check(
    "thought_sig: a synthetic gemini id is NOT echoed back on functionResponse",
    !!tsFnResp && !tsFnResp.parts.some((p) => /^gemini-tool-\d+$/.test(p.functionResponse?.id || "")),
  );

  // Multiple parallel function calls, each with its own signature → order + each
  // signature preserved, and results associated in the same order.
  const multiPayload = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { functionCall: { name: "get_service_health", args: { service: "payments" } }, thoughtSignature: "SIG_ONE" },
            { functionCall: { name: "list_active_incidents", args: { service: "payments" } }, thoughtSignature: "SIG_TWO" },
          ],
        },
        finishReason: "STOP",
      },
    ],
  };
  const multiParsed = parseGeminiResponse(multiPayload);
  const multiFollow = toGeminiRequest(
    [
      { role: "user", content: "go" },
      multiParsed,
      { role: "tool", toolCallId: multiParsed.toolCalls[0].id, name: "get_service_health", result: { ok: 1 } },
      { role: "tool", toolCallId: multiParsed.toolCalls[1].id, name: "list_active_incidents", result: { ok: 2 } },
    ],
    geminiTools,
  );
  const mModel = multiFollow.contents.find((c) => c.role === "model");
  check(
    "thought_sig(multi): both signed calls replayed in order with their signatures",
    mModel?.parts?.length === 2 &&
      mModel.parts[0].functionCall?.name === "get_service_health" && mModel.parts[0].thoughtSignature === "SIG_ONE" &&
      mModel.parts[1].functionCall?.name === "list_active_incidents" && mModel.parts[1].thoughtSignature === "SIG_TWO",
  );
  const mUser = multiFollow.contents.find((c) => c.role === "user" && c.parts.some((p) => p.functionResponse));
  check(
    "thought_sig(multi): both tool results present in matching order",
    mUser?.parts?.length === 2 &&
      mUser.parts[0].functionResponse?.name === "get_service_health" &&
      mUser.parts[1].functionResponse?.name === "list_active_incidents",
  );

  console.log("\ncreateGeminiProvider — mocked fetch (no real API, no key)");

  const realFetch = global.fetch;
  const realConsoleError = console.error;
  const FAKE_KEY = "AIza-TEST-gemini-key-DO-NOT-LEAK";
  const errLines = [];
  console.error = (...args) => errLines.push(args.join(" "));
  process.env.MODEL_API_KEY = FAKE_KEY;
  process.env.MODEL_NAME = "";

  try {
    // 1) success text + request shape + auth header
    let captured = null;
    global.fetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { role: "model", parts: [{ text: "Payments is degraded." }] }, finishReason: "STOP" }] };
        },
      };
    };
    const okText = await createGeminiProvider().complete(
      [{ role: "system", content: "SYS" }, { role: "user", content: "What's wrong with payments?" }],
      geminiTools,
    );
    check("default model → gemini-3.5-flash-lite in the URL", typeof captured?.url === "string" && captured.url.includes("gemini-3.5-flash-lite:generateContent"));
    check("auth via x-goog-api-key header", captured?.opts?.headers?.["x-goog-api-key"] === FAKE_KEY);
    check("request body never contains the API key", !String(captured?.opts?.body || "").includes(FAKE_KEY));
    check("success → assistant text, no tool calls", okText.content === "Payments is degraded." && okText.toolCalls.length === 0);

    // custom model honoured
    process.env.MODEL_NAME = "gemini-2.5-pro";
    let captured2 = null;
    global.fetch = async (url) => {
      captured2 = { url };
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ text: "x" }] } }] }; } };
    };
    await createGeminiProvider().complete([{ role: "user", content: "go" }], geminiTools);
    check("custom MODEL_NAME honoured in the URL", captured2.url.includes("gemini-2.5-pro:generateContent"));
    process.env.MODEL_NAME = "";

    // 2) function call
    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() { return { candidates: [{ content: { parts: [{ functionCall: { name: "get_service_health", args: { service: "payments" } } }] } }] }; },
    });
    const okFc = await createGeminiProvider().complete([{ role: "user", content: "go" }], geminiTools);
    check("function-call response → neutral tool call", okFc.toolCalls.length === 1 && okFc.toolCalls[0].name === "get_service_health" && okFc.toolCalls[0].arguments.service === "payments");

    // 3) tool-result follow-up (prior step translated) → final text
    let capturedFollow = null;
    global.fetch = async (url, opts) => {
      capturedFollow = JSON.parse(opts.body);
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ text: "Done." }] } }] }; } };
    };
    const follow = await createGeminiProvider().complete(
      [
        { role: "system", content: "SYS" },
        { role: "user", content: "What's wrong with payments?" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_service_health", arguments: { service: "payments" } }] },
        { role: "tool", toolCallId: "c1", name: "get_service_health", result: { structuredContent: { status: "degraded" } } },
      ],
      geminiTools,
    );
    check("tool-result follow-up → final text", follow.content === "Done." && follow.toolCalls.length === 0);
    check(
      "follow-up request carries the prior functionCall + functionResponse",
      capturedFollow.contents.some((c) => c.role === "model" && c.parts.some((p) => p.functionCall?.name === "get_service_health")) &&
        capturedFollow.contents.some((c) => c.role === "user" && c.parts.some((p) => p.functionResponse?.name === "get_service_health")),
    );

    // 4) HTTP error (quota) — sanitized, status enum only
    global.fetch = async () => ({
      ok: false,
      status: 429,
      async json() { return { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota exceeded for project 12345" } }; },
    });
    let httpErr = null;
    try { await createGeminiProvider().complete([{ role: "user", content: "go" }], geminiTools); } catch (e) { httpErr = e; }
    check("HTTP 429 → MODEL_PROVIDER_UNAVAILABLE", httpErr?.code === "MODEL_PROVIDER_UNAVAILABLE");
    check("HTTP error surfaces status enum, not the raw message", !!httpErr && httpErr.message.includes("429") && !/quota/i.test(httpErr.message));

    // 5) malformed responses
    global.fetch = async () => ({ ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ functionCall: { args: {} } }] } }] }; } });
    let malErr = null;
    try { await createGeminiProvider().complete([{ role: "user", content: "go" }], geminiTools); } catch (e) { malErr = e; }
    check("malformed function call → MODEL_PROVIDER_UNAVAILABLE", malErr?.code === "MODEL_PROVIDER_UNAVAILABLE");

    global.fetch = async () => ({ ok: true, status: 200, async json() { throw new Error("not json"); } });
    let njErr = null;
    try { await createGeminiProvider().complete([{ role: "user", content: "go" }], geminiTools); } catch (e) { njErr = e; }
    check("non-JSON response body → MODEL_PROVIDER_UNAVAILABLE", njErr?.code === "MODEL_PROVIDER_UNAVAILABLE");

    // 6) timeout (fetch rejects on abort) — fires near the small budget
    // Fallback disabled here so the single-attempt timing is unambiguous.
    const savedFallbacks = process.env.MODEL_FALLBACK_MODELS;
    process.env.MODEL_FALLBACK_MODELS = "";
    global.fetch = (url, opts) =>
      new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
      });
    const started = Date.now();
    let toErr = null;
    try { await createGeminiProvider().complete([{ role: "user", content: "go" }], geminiTools); } catch (e) { toErr = e; }
    check("timeout → MODEL_PROVIDER_UNAVAILABLE", toErr?.code === "MODEL_PROVIDER_UNAVAILABLE");
    check("timeout fires near the MODEL_TIMEOUT_MS budget (child aborted)", Date.now() - started < 3000, `${Date.now() - started}ms`);
    if (savedFallbacks === undefined) delete process.env.MODEL_FALLBACK_MODELS;
    else process.env.MODEL_FALLBACK_MODELS = savedFallbacks;

    // 7) missing key
    delete process.env.MODEL_API_KEY;
    let keyErr = null;
    try { createGeminiProvider(); } catch (e) { keyErr = e; }
    check("missing MODEL_API_KEY → MODEL_PROVIDER_UNAVAILABLE", keyErr?.code === "MODEL_PROVIDER_UNAVAILABLE");
    process.env.MODEL_API_KEY = FAKE_KEY;

    // ---------------------------------------------------------------------
    // 8) model fallback chain
    // ---------------------------------------------------------------------
    console.log("\ncreateGeminiProvider — model fallback (mocked fetch)");

    const { geminiModelChain } = await import("./agent.js");

    process.env.MODEL_NAME = "gemini-3.5-flash-lite";
    process.env.MODEL_FALLBACK_MODELS = "gemini-3.1-flash-lite";
    check(
      "geminiModelChain: primary + fallback, de-duplicated, in order",
      JSON.stringify(geminiModelChain()) === JSON.stringify(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]),
      geminiModelChain().join(","),
    );
    check(
      "geminiModelChain: empty fallbacks → primary only",
      (() => { process.env.MODEL_FALLBACK_MODELS = ""; return geminiModelChain().length === 1; })(),
    );
    process.env.MODEL_FALLBACK_MODELS = "gemini-3.1-flash-lite";

    const urlsTried = [];
    // Respond 200 for any non-primary model, and `status` for the primary.
    const mkResponse = (status) => (url) => {
      urlsTried.push(url);
      const isPrimary = url.includes("gemini-3.5-flash-lite");
      if (isPrimary && status !== 200) {
        return Promise.resolve({ ok: false, status, async json() { return { error: { status: "ERR" } }; } });
      }
      return Promise.resolve({ ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ text: "ok" }] } }] }; } });
    };

    // 8a) primary 404 → falls back to the second model, which succeeds.
    urlsTried.length = 0;
    global.fetch = mkResponse(404);
    let fbErr = null;
    let fbResult = null;
    try { fbResult = await createGeminiProvider().complete([{ role: "user", content: "go" }], geminiTools); } catch (e) { fbErr = e; }
    check(
      "primary 404 → fallback model succeeds",
      fbResult?.content === "ok" && urlsTried.some((u) => u.includes("gemini-3.5-flash-lite")) && urlsTried.some((u) => u.includes("gemini-3.1-flash-lite")),
      fbErr ? String(fbErr.code) : `${urlsTried.length} attempt(s)`,
    );

    // 8b) primary 429 (transient) → falls back.
    urlsTried.length = 0;
    global.fetch = (url) => {
      urlsTried.push(url);
      if (url.includes("gemini-3.5-flash-lite")) {
        return Promise.resolve({ ok: false, status: 429, async json() { return { error: { status: "RESOURCE_EXHAUSTED" } }; } });
      }
      return Promise.resolve({ ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ text: "fallback ok" }] } }] }; } });
    };
    let fb429 = null;
    try { fb429 = await createGeminiProvider().complete([{ role: "user", content: "go" }], geminiTools); } catch (e) { fb429 = e; }
    check("primary 429 → fallback model succeeds", fb429?.content === "fallback ok", fb429 instanceof Error ? fb429.code : "resolved");

    // 8c) primary 403 (permanent) → NOT retried; a bad key is not fixed by trying
    // another model, so exactly one attempt is made.
    urlsTried.length = 0;
    global.fetch = mkResponse(403);
    let fb403 = null;
    try { await createGeminiProvider().complete([{ role: "user", content: "go" }], geminiTools); } catch (e) { fb403 = e; }
    check(
      "primary 403 (auth) → no fallback attempt (permanent error not retried)",
      fb403?.code === "MODEL_PROVIDER_UNAVAILABLE" && urlsTried.length === 1,
      `${urlsTried.length} attempt(s)`,
    );

    // 8d) ALL models fail → MODEL_PROVIDER_UNAVAILABLE, both attempted.
    urlsTried.length = 0;
    global.fetch = (url) => {
      urlsTried.push(url);
      return Promise.resolve({ ok: false, status: 503, async json() { return { error: { status: "UNAVAILABLE" } }; } });
    };
    let allErr = null;
    try { await createGeminiProvider().complete([{ role: "user", content: "go" }], geminiTools); } catch (e) { allErr = e; }
    check(
      "all models fail → MODEL_PROVIDER_UNAVAILABLE after trying the whole chain",
      allErr?.code === "MODEL_PROVIDER_UNAVAILABLE" && urlsTried.length === 2,
      `${urlsTried.length} attempt(s)`,
    );

    // restore
    process.env.MODEL_NAME = "";
    delete process.env.MODEL_FALLBACK_MODELS;
  } finally {
    global.fetch = realFetch;
    console.error = realConsoleError;
  }

  check("gemini never logged the API key in any diagnostic", !errLines.join("\n").includes(FAKE_KEY));

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log("\n" + "─".repeat(60));
  console.log(
    `${failed === 0 ? "ALL PROVIDER CHECKS PASSED" : "PROVIDER CHECKS FAILED"} — ${passed} passed, ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nHARNESS ERROR:", err?.stack || err);
  process.exit(1);
});
