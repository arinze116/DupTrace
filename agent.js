import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { fileURLToPath } from "node:url";
import { buildContextMessage } from "./chat_context.js";
import { loadEnvFile } from "./env.js";

// Load .env before any configuration is read (see env.js). Import is hoisted, but
// this top-level call runs before the config constants below. Variables already in
// process.env win, so shell overrides and the test harnesses stay authoritative.
// DUPTRACE_ENV_FILE overrides the file path (useful for deployments and tests).
loadEnvFile(
  process.env.DUPTRACE_ENV_FILE || fileURLToPath(new URL("./.env", import.meta.url)),
);

const defaultMaxAgentSteps = 12;
const defaultMcpTimeoutMs = 10000;
const defaultModelTimeoutMs = 60000;
// The claude-cli provider shells out to the interactive Claude CLI, which is far
// slower than a hosted API call â€” tens of seconds per turn is normal â€” so it gets
// its own, larger default budget, still overridable via MODEL_CLI_TIMEOUT_MS.
const defaultCliTimeoutMs = 180000;
const expectedToolNames = [
  "get_service_health",
  "list_active_incidents",
  "get_incident",
  "list_recent_deployments",
  "get_deployment",
  "list_service_events",
  "get_event",
  "get_incident_evidence",
  "correlate_incident",
  "get_investigation",
  "summarize_investigation",
  "investigate_incident",
];

const systemPrompt = `You are the DupTrace operations investigation agent.

Use DupTrace MCP tools to investigate service health, incidents, deployments, events, evidence, and correlations.

Treat MCP results as the authoritative source of operational facts.

Do not invent operational facts.

Distinguish temporal correlation from causation.

Never claim a deployment caused an incident unless the available evidence explicitly establishes causality.

When evidence is insufficient, say so.

Do not perform remediation actions.

Use the smallest reasonable set of tools needed to answer the user's request.`;

const getRequiredEnvironment = (name) => {
  const value = process.env[name]?.trim();

  if (!value) throw new Error(`${name} is required`);

  return value;
};

const createAgentError = (code, message, cause) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
};

// Server-side diagnostics must never carry credentials, full prompts, request
// bodies, or raw subprocess output. Collapse whitespace and clip to one short line.
const sanitizeDiagnostic = (value, limit = 200) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}â€¦` : text;
};

const maxAgentSteps = Number(
  process.env.MAX_AGENT_STEPS || defaultMaxAgentSteps
);
const mcpTimeoutMs = Number(
  process.env.MCP_CLIENT_TIMEOUT_MS || defaultMcpTimeoutMs
);
const modelTimeoutMs = Number(
  process.env.MODEL_TIMEOUT_MS || defaultModelTimeoutMs
);
const cliTimeoutMs = Number(
  process.env.MODEL_CLI_TIMEOUT_MS || defaultCliTimeoutMs
);

if (!Number.isInteger(maxAgentSteps) || maxAgentSteps < 1) {
  throw new Error("MAX_AGENT_STEPS must be a positive integer");
}

if (!Number.isInteger(mcpTimeoutMs) || mcpTimeoutMs < 1) {
  throw new Error("MCP_CLIENT_TIMEOUT_MS must be a positive integer");
}

if (!Number.isInteger(modelTimeoutMs) || modelTimeoutMs < 1) {
  throw new Error("MODEL_TIMEOUT_MS must be a positive integer");
}

if (!Number.isInteger(cliTimeoutMs) || cliTimeoutMs < 1) {
  throw new Error("MODEL_CLI_TIMEOUT_MS must be a positive integer");
}

const withTimeout = (promise, timeoutMs, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const createDupTraceClient = async () => {
  let mcpUrl;

  try {
    mcpUrl = process.env.DUPTRACE_MCP_URL?.trim() || (process.env.VERCEL === "1" && (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL) ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}/mcp` : getRequiredEnvironment("DUPTRACE_MCP_URL"));
  } catch (error) {
    throw createAgentError("MCP_UNAVAILABLE", error.message, error);
  }

  const client = new Client(
    {
      name: "duptrace-agent",
      version: "0.1.0",
    },
    {
      versionNegotiation: { mode: "auto" },
    }
  );
  const internalToken = process.env.DUPTRACE_INTERNAL_MCP_TOKEN?.trim();
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    ...(process.env.VERCEL === "1" && internalToken
      ? { requestInit: { headers: { "x-duptrace-internal-token": internalToken } } }
      : {}),
  });

  try {
    await withTimeout(client.connect(transport), mcpTimeoutMs, "MCP initialize");
    const toolsResult = await withTimeout(
      client.listTools(),
      mcpTimeoutMs,
      "MCP tools/list"
    );
    const discoveredToolNames = toolsResult.tools.map((tool) => tool.name);
    const missingTools = expectedToolNames.filter(
      (name) => !discoveredToolNames.includes(name)
    );

    if (
      toolsResult.tools.length !== expectedToolNames.length ||
      missingTools.length
    ) {
      throw new Error(
        `Expected ${expectedToolNames.length} DupTrace tools, discovered ${toolsResult.tools.length}. Missing: ${missingTools.join(", ") || "none"}`
      );
    }

    return { client, tools: toolsResult.tools };
  } catch (error) {
    await client.close().catch(() => {});
    throw createAgentError(
      "MCP_UNAVAILABLE",
      `DupTrace MCP connection failed: ${error.message}`,
      error
    );
  }
};

const parseToolArguments = (value) => {
  if (value === undefined || value === null) return {};
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Model returned invalid tool arguments: ${error.message}`);
  }
};

export const createOpenAiCompatibleProvider = () => {
  let apiKey;
  let model;

  try {
    apiKey = getRequiredEnvironment("MODEL_API_KEY");
    model = getRequiredEnvironment("MODEL_NAME");
  } catch (error) {
    throw createAgentError("MODEL_PROVIDER_UNAVAILABLE", error.message, error);
  }
  const baseUrl = (
    process.env.MODEL_BASE_URL || "https://api.openai.com/v1"
  ).replace(/\/+$/, "");

  const toProviderMessage = (message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.arguments || {}),
                },
              })),
            }
          : {}),
      };
    }

    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: JSON.stringify(message.result),
      };
    }

    return message;
  };

  return {
    name: "openai-compatible",
    timeoutMs: modelTimeoutMs,
    async complete(messages, tools) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), modelTimeoutMs);

      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages: messages.map(toProviderMessage),
            tools: tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
            tool_choice: "auto",
          }),
        });

        if (!response.ok) {
          throw new Error(
            `Model provider returned HTTP ${response.status}: ${await response.text()}`
          );
        }

        const payload = await response.json();
        const message = payload.choices?.[0]?.message;

        if (!message) throw new Error("Model provider returned no message");

        return {
          role: "assistant",
          content: message.content || "",
          toolCalls: (message.tool_calls || []).map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: parseToolArguments(toolCall.function.arguments),
          })),
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
};

const parseClaudeJson = (value) => {
  const text = typeof value === "string" ? value.trim() : value;
  if (text && typeof text === "object") return text;

  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch (error) {
    throw new Error(`Claude provider returned invalid agent JSON: ${error.message}`);
  }
};

// Turn the CLI's `--output-format json` envelope into the provider-neutral
// assistant message runAgent expects. Pure and exported so the schema handling
// can be unit-tested without spawning the CLI. Throws on a malformed envelope or
// an unrecognised agent schema (callers map that to MODEL_PROVIDER_UNAVAILABLE).
export const parseClaudeAgentResponse = (stdout) => {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Claude provider returned a non-JSON envelope: ${error.message}`);
  }

  const agentResult = parseClaudeJson(envelope.result ?? envelope.content);

  if (agentResult && agentResult.type === "tool_calls") {
    return {
      role: "assistant",
      content: "",
      toolCalls: (agentResult.toolCalls || []).map((toolCall, index) => ({
        id: toolCall.id || `claude-tool-${index + 1}`,
        name: toolCall.name,
        arguments: parseToolArguments(toolCall.arguments),
      })),
    };
  }

  if (agentResult && agentResult.type === "final") {
    return {
      role: "assistant",
      content: agentResult.content || "",
      toolCalls: [],
    };
  }

  throw new Error('Claude provider response missing JSON type "tool_calls" or "final"');
};

// The CLI runs with its own tools disabled (--tools=), so Claude must PROPOSE
// tool calls as JSON, the server executes the real MCP calls, and the results are
// fed back on the next turn. The stdin prompt has to state that contract
// explicitly with concrete examples â€” the DupTrace rules in --system-prompt do
// not â€” and carry the running transcript so prior tool results inform reasoning.
const buildCliPrompt = (messages, tools) => {
  const toolCatalog = tools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  arguments JSON schema: ${JSON.stringify(tool.inputSchema)}`
    )
    .join("\n");

  const transcript = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "user") return `USER: ${message.content}`;
      if (message.role === "assistant") {
        return message.toolCalls?.length
          ? `ASSISTANT (tool calls): ${JSON.stringify(message.toolCalls)}`
          : `ASSISTANT: ${message.content || ""}`;
      }
      if (message.role === "tool") {
        return `TOOL RESULT (${message.name}): ${JSON.stringify(message.result)}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  return [
    "You are driving an automated investigation loop. Reply with EXACTLY ONE JSON",
    "object and nothing else â€” no prose, no Markdown, no code fences.",
    "",
    "To gather evidence, request one or more tools:",
    '{"type":"tool_calls","toolCalls":[{"id":"call_1","name":"get_service_health","arguments":{"service":"payments"}}]}',
    "",
    "When the evidence already gathered is enough to answer the user, reply:",
    '{"type":"final","content":"Payments is degraded: elevated 5xx error rate and higher p95 latency."}',
    "",
    "Only use these tools; each call's arguments must match that tool's JSON schema:",
    toolCatalog,
    "",
    "Conversation so far:",
    transcript,
    "",
    "Reply with the next single JSON object now.",
  ].join("\n");
};

export const createClaudeCliProvider = () => ({
  name: "claude-cli",
  timeoutMs: cliTimeoutMs,
  async complete(messages, tools) {
    const { spawn } = await import("node:child_process");
    const prompt = buildCliPrompt(messages, tools);
    const command = process.env.MODEL_CLI_COMMAND?.trim() || "claude";
    const args = [
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--tools=",
      "--system-prompt",
      systemPrompt,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };

      // Own the timeout here so a slow run is actually TERMINATED. runAgent's outer
      // withTimeout can only lose a Promise race â€” it has no handle to this child,
      // so without this the CLI would keep running as an orphan after we gave up.
      const timer = setTimeout(() => {
        console.error(`[claude-cli] timed out after ${cliTimeoutMs}ms; terminating child`);
        try {
          child.kill("SIGTERM");
        } catch {
          /* already exited */
        }
        // Escalate if it ignores SIGTERM; unref so this timer never keeps Node alive.
        const killTimer = setTimeout(() => {
          try {
            if (!child.killed) child.kill("SIGKILL");
          } catch {
            /* already exited */
          }
        }, 2000);
        killTimer.unref?.();
        settle(
          reject,
          createAgentError(
            "MODEL_PROVIDER_UNAVAILABLE",
            `Claude CLI timed out after ${cliTimeoutMs}ms`
          )
        );
      }, cliTimeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        console.error(`[claude-cli] failed to start: ${sanitizeDiagnostic(error.message)}`);
        settle(
          reject,
          createAgentError(
            "MODEL_PROVIDER_UNAVAILABLE",
            `Claude provider could not start: ${error.message}`,
            error
          )
        );
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          // stderr is sanitized for the server log and never sent to the client.
          console.error(
            `[claude-cli] exited with code ${code}; stderr: ${sanitizeDiagnostic(stderr)}`
          );
          settle(
            reject,
            createAgentError(
              "MODEL_PROVIDER_UNAVAILABLE",
              `Claude provider exited with code ${code}`
            )
          );
          return;
        }

        try {
          settle(resolve, parseClaudeAgentResponse(stdout));
        } catch (error) {
          console.error(
            `[claude-cli] response parse failed: ${sanitizeDiagnostic(error.message)}`
          );
          settle(
            reject,
            createAgentError(
              "MODEL_PROVIDER_UNAVAILABLE",
              `Claude provider response error: ${error.message}`,
              error
            )
          );
        }
      });

      child.stdin.end(prompt);
    });
  },
});

// ---------------------------------------------------------------------------
// Gemini â€” Google's native generateContent REST API (no SDK dependency).
// ---------------------------------------------------------------------------

// Gemini function `parameters` use an OpenAPI-3.0 Schema SUBSET, not full JSON
// Schema. Unknown keywords ($schema, additionalProperties, $ref, const,
// oneOf/anyOf/allOf, â€¦) make generateContent reject the request, so we translate
// the MCP tools' JSON Schema into that subset by whitelisting supported fields
// and recursing â€” anything unsupported is dropped rather than forwarded.
const GEMINI_TYPES = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
};
const GEMINI_SAFE_FORMATS = new Set([
  "enum",
  "date-time",
  "int32",
  "int64",
  "float",
  "double",
]);

export const toGeminiSchema = (schema) => {
  if (!schema || typeof schema !== "object") return undefined;

  let rawType = schema.type;
  let nullable = schema.nullable === true;
  if (Array.isArray(rawType)) {
    if (rawType.includes("null")) nullable = true;
    rawType = rawType.find((entry) => entry !== "null");
  }
  const geminiType = rawType ? GEMINI_TYPES[String(rawType).toLowerCase()] : undefined;

  const out = {};
  if (geminiType) out.type = geminiType;
  if (typeof schema.description === "string") out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.map((value) => String(value));
  if (nullable) out.nullable = true;
  if (typeof schema.format === "string" && GEMINI_SAFE_FORMATS.has(schema.format)) {
    out.format = schema.format;
  }
  for (const key of [
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "pattern",
  ]) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }

  if (schema.properties && typeof schema.properties === "object") {
    const properties = {};
    for (const [name, value] of Object.entries(schema.properties)) {
      const converted = toGeminiSchema(value);
      if (converted) properties[name] = converted;
    }
    if (Object.keys(properties).length) out.properties = properties;
    if (Array.isArray(schema.required) && schema.required.length) {
      out.required = schema.required.slice();
    }
    if (!out.type) out.type = "OBJECT";
  }

  if (schema.items) {
    const items = toGeminiSchema(schema.items);
    if (items) out.items = items;
    if (!out.type) out.type = "ARRAY";
  }

  return out;
};

// Translate DupTrace's provider-neutral message history into a Gemini request
// body: system turns become system_instruction; user/assistant/tool turns become
// `contents`; assistant tool calls become functionCall parts and tool results
// become functionResponse parts (function-call ids preserved on both when
// present). Adjacent same-role turns are coalesced because Gemini expects a
// single content per role turn (e.g. injected context + user message, or several
// parallel function responses). Only the provided MCP tools are declared.
// Synthetic ids we mint when Gemini omits a functionCall id (parseGeminiResponse).
// They exist only so the agent loop and the OpenAI-compatible provider have a
// stable neutral key; they must NEVER be echoed back to Gemini, which associates
// a functionResponse to its functionCall by name/position (and the real id only
// when the model itself supplied one). Sending a fabricated id can 400.
const SYNTHETIC_GEMINI_ID = /^gemini-tool-\d+$/;

export const toGeminiRequest = (messages, tools) => {
  let systemText = "";
  const raw = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemText = systemText
        ? `${systemText}\n\n${message.content || ""}`
        : message.content || "";
      continue;
    }
    if (message.role === "user") {
      raw.push({ role: "user", parts: [{ text: String(message.content ?? "") }] });
      continue;
    }
    if (message.role === "assistant") {
      // Replay the model's ORIGINAL parts verbatim when we captured them (see
      // parseGeminiResponse → geminiParts). Gemini 3.x attaches a signed
      // `thoughtSignature` to each functionCall part that MUST be echoed back on
      // the follow-up request; reconstructing the functionCall from only
      // {name,args,id} drops it and Gemini rejects the turn with HTTP 400
      // INVALID_ARGUMENT ("Function call is missing a thought_signature").
      if (Array.isArray(message.geminiParts) && message.geminiParts.length) {
        raw.push({ role: "model", parts: message.geminiParts });
        continue;
      }
      // Fallback reconstruction (messages not produced by parseGeminiResponse).
      const parts = [];
      if (message.content) parts.push({ text: message.content });
      for (const toolCall of message.toolCalls || []) {
        const functionCall = { name: toolCall.name, args: toolCall.arguments || {} };
        if (toolCall.id && !SYNTHETIC_GEMINI_ID.test(toolCall.id)) functionCall.id = toolCall.id;
        parts.push({ functionCall });
      }
      if (parts.length === 0) parts.push({ text: "" });
      raw.push({ role: "model", parts });
      continue;
    }
    if (message.role === "tool") {
      const value = message.result;
      const response =
        value && typeof value === "object" && !Array.isArray(value)
          ? value
          : { result: value };
      const functionResponse = { name: message.name, response };
      // Only echo a REAL id (one the model supplied); never a synthetic one, so
      // the functionResponse stays symmetric with the replayed functionCall part.
      if (message.toolCallId && !SYNTHETIC_GEMINI_ID.test(message.toolCallId)) {
        functionResponse.id = message.toolCallId;
      }
      raw.push({ role: "user", parts: [{ functionResponse }] });
    }
  }

  const contents = [];
  for (const content of raw) {
    const last = contents[contents.length - 1];
    if (last && last.role === content.role) last.parts.push(...content.parts);
    else contents.push({ role: content.role, parts: [...content.parts] });
  }

  const body = { contents };
  if (systemText) body.system_instruction = { parts: [{ text: systemText }] };

  const functionDeclarations = tools.map((tool) => {
    const declaration = { name: tool.name, description: tool.description };
    const parameters = toGeminiSchema(tool.inputSchema);
    if (parameters && parameters.properties && Object.keys(parameters.properties).length) {
      declaration.parameters = parameters;
    }
    return declaration;
  });
  if (functionDeclarations.length) {
    body.tools = [{ functionDeclarations }];
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  return body;
};

// Parse a Gemini generateContent response into the provider-neutral shape. Throws
// on a blocked/empty/invalid response or a function call with no name (callers map
// that to MODEL_PROVIDER_UNAVAILABLE). A stable fallback id is generated only when
// the API omits one; a provided id is preserved.
export const parseGeminiResponse = (payload) => {
  const candidate = payload?.candidates?.[0];
  if (!candidate) {
    const blockReason = payload?.promptFeedback?.blockReason;
    throw new Error(
      blockReason
        ? `Gemini blocked the request (${blockReason})`
        : "Gemini returned no candidates"
    );
  }

  const parts = candidate.content?.parts;
  if (!Array.isArray(parts)) {
    throw new Error(
      `Gemini returned no content parts (finishReason ${candidate.finishReason || "unknown"})`
    );
  }

  let content = "";
  const toolCalls = [];
  let callIndex = 0;
  for (const part of parts) {
    if (part && typeof part.text === "string") {
      content += part.text;
    } else if (part && part.functionCall) {
      const functionCall = part.functionCall;
      if (!functionCall.name || typeof functionCall.name !== "string") {
        throw new Error("Gemini returned a function call without a name");
      }
      callIndex += 1;
      toolCalls.push({
        id:
          typeof functionCall.id === "string" && functionCall.id
            ? functionCall.id
            : `gemini-tool-${callIndex}`,
        name: functionCall.name,
        arguments: parseToolArguments(functionCall.args),
      });
    }
  }

  // The neutral `toolCalls` is the provider-agnostic contract (other providers and
  // the frontend only ever see this). `geminiParts` additionally retains Gemini's
  // ORIGINAL response parts — including the signed `thoughtSignature` on each
  // functionCall — so toGeminiRequest can replay them verbatim on the follow-up
  // request. It is Gemini-internal: never serialized to the client, never read by
  // another provider.
  return { role: "assistant", content, toolCalls, geminiParts: parts };
};

// HTTP statuses that justify trying the NEXT model in the chain: the model may be
// unavailable, rate-limited, or the server had a transient fault — all plausibly
// resolved by a different model. 401/403 (bad/unauthorized key) and 400/422 (bad
// request) are NOT retried: retrying a permanent auth/config error is pointless.
const isFallbackWorthyStatus = (status) =>
  status === 404 ||
  status === 408 ||
  status === 429 ||
  status === 500 ||
  status === 502 ||
  status === 503 ||
  status === 504;

/**
 * The ordered list of Gemini models to try. The first is the primary (MODEL_NAME,
 * default gemini-3.5-flash-lite); the rest come from MODEL_FALLBACK_MODELS
 * (comma-separated, default gemini-3.1-flash-lite). Duplicates are dropped; an
 * empty MODEL_FALLBACK_MODELS disables fallback (primary only). No undocumented
 * model is assumed reachable — the defaults are the two IDs the configured key was
 * verified to serve.
 * @returns {string[]}
 */
export const geminiModelChain = () => {
  const primary = process.env.MODEL_NAME?.trim() || "gemini-3.5-flash-lite";
  const raw =
    process.env.MODEL_FALLBACK_MODELS === undefined
      ? "gemini-3.1-flash-lite"
      : process.env.MODEL_FALLBACK_MODELS;
  const fallbacks = String(raw)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const chain = [primary, ...fallbacks];
  return [...new Set(chain)];
};

// One attempt against a single model. Resolves the parsed response, or rejects with
// an error carrying `.retryable` (true when the next model should be tried). The
// key is only ever sent in the x-goog-api-key header and never logged.
const completeWithModel = async (model, messages, tools, apiKey, baseUrl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), modelTimeoutMs);

  try {
    let response;
    try {
      response = await fetch(
        `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          signal: controller.signal,
          body: JSON.stringify(toGeminiRequest(messages, tools)),
        }
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        console.error(`[gemini] ${model} timed out after ${modelTimeoutMs}ms`);
        const e = createAgentError(
          "MODEL_PROVIDER_UNAVAILABLE",
          `Gemini request timed out after ${modelTimeoutMs}ms`,
          error
        );
        e.retryable = true; // a different model may respond in budget
        throw e;
      }
      console.error(`[gemini] ${model} request failed: ${sanitizeDiagnostic(error?.message)}`);
      const e = createAgentError("MODEL_PROVIDER_UNAVAILABLE", "Gemini request failed", error);
      e.retryable = true; // network-level failure — try the next model
      throw e;
    }

    if (!response.ok) {
      // Surface ONLY the HTTP status + Google status enum. The raw error body is
      // never thrown or logged beyond a sanitized, clipped server-side line.
      let statusLabel = "";
      try {
        const errorBody = await response.json();
        if (typeof errorBody?.error?.status === "string") {
          statusLabel = errorBody.error.status;
        }
        console.error(
          `[gemini] ${model} API detail: ${sanitizeDiagnostic(
            String(errorBody?.error?.message || "No error message supplied")
          )}`
        );
      } catch {
        /* non-JSON error body — ignore */
      }
      console.error(
        `[gemini] ${model} HTTP ${response.status}${statusLabel ? ` ${statusLabel}` : ""}`
      );
      const e = createAgentError(
        "MODEL_PROVIDER_UNAVAILABLE",
        `Gemini provider returned HTTP ${response.status}${statusLabel ? ` (${statusLabel})` : ""}`
      );
      e.retryable = isFallbackWorthyStatus(response.status);
      throw e;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      const e = createAgentError(
        "MODEL_PROVIDER_UNAVAILABLE",
        "Gemini returned a non-JSON response",
        error
      );
      e.retryable = true; // a truncated/odd body may be model-specific
      throw e;
    }

    try {
      return parseGeminiResponse(payload);
    } catch (error) {
      console.error(`[gemini] ${model} response parse failed: ${sanitizeDiagnostic(error.message)}`);
      const e = createAgentError(
        "MODEL_PROVIDER_UNAVAILABLE",
        `Gemini response error: ${error.message}`,
        error
      );
      e.retryable = true; // an unusable payload from one model may parse fine from another
      throw e;
    }
  } finally {
    clearTimeout(timer);
  }
};

export const createGeminiProvider = () => {
  let apiKey;
  try {
    apiKey = getRequiredEnvironment("MODEL_API_KEY");
  } catch (error) {
    throw createAgentError("MODEL_PROVIDER_UNAVAILABLE", error.message, error);
  }
  const baseUrl = "https://generativelanguage.googleapis.com/v1beta";
  const models = geminiModelChain();

  return {
    name: "gemini",
    // Each attempt gets its own modelTimeoutMs, so the outer bound must cover the
    // whole chain; otherwise runAgent's withTimeout would abort mid-fallback.
    timeoutMs: modelTimeoutMs * Math.max(1, models.length),
    async complete(messages, tools) {
      let lastError = null;

      for (let attempt = 0; attempt < models.length; attempt += 1) {
        const model = models[attempt];
        try {
          return await completeWithModel(model, messages, tools, apiKey, baseUrl);
        } catch (error) {
          lastError = error;
          // A permanent failure (bad key, bad request) will not be fixed by another
          // model — stop immediately rather than masking an auth/config problem.
          if (error?.retryable !== true) throw error;
          const more = attempt < models.length - 1;
          console.error(
            `[gemini] model ${model} unavailable${
              more ? ` — falling back to ${models[attempt + 1]}` : " — no fallback left"
            }`
          );
          if (!more) throw error;
        }
      }

      // Unreachable (the loop returns or throws), but keep a defensive throw.
      throw lastError || createAgentError("MODEL_PROVIDER_UNAVAILABLE", "Gemini provider failed");
    },
  };
};

const createProvider = () => {
  console.error(`[provider-debug] MODEL_PROVIDER=${process.env.MODEL_PROVIDER ?? "<unset>"}`);
  let provider;

  try {
    provider = getRequiredEnvironment("MODEL_PROVIDER");
  } catch (error) {
    throw createAgentError("MODEL_PROVIDER_UNAVAILABLE", error.message, error);
  }

  if (provider === "openai-compatible") return createOpenAiCompatibleProvider();
  if (provider === "claude-cli") return createClaudeCliProvider();
  console.error(`[provider-debug] selected provider=${provider}`);
  if (provider === "gemini") return createGeminiProvider();

  throw createAgentError(
    "MODEL_PROVIDER_UNAVAILABLE",
    `Unsupported MODEL_PROVIDER=${provider}. Use openai-compatible, claude-cli, or gemini.`
  );
};

export const runAgent = async ({ message, conversationId = null, onEvent, context = null }) => {
  const { client, tools } = await createDupTraceClient();
  let provider;

  try {
    provider = createProvider();
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }

  // Explicit, pre-validated prior-turn context (if any) is injected as a clearly
  // labelled message BEFORE the current user turn â€” never as evidence, and it does
  // not replace tool calls. When absent, messages are exactly as before (discovery
  // behaviour preserved). The current user message always comes last, so it wins.
  const contextMessage = buildContextMessage(context);
  const messages = [
    { role: "system", content: systemPrompt },
    ...(contextMessage ? [contextMessage] : []),
    { role: "user", content: message },
  ];
  const activity = [];

  try {
    for (let step = 1; step <= maxAgentSteps; step += 1) {
      let response;

      try {
        response = await withTimeout(
          provider.complete(messages, tools),
          provider.timeoutMs || modelTimeoutMs,
          "Model request"
        );
      } catch (error) {
        // Any failure to obtain a usable completion from the configured model
        // provider (cannot start, non-zero exit, unparseable output, timeout)
        // is a provider-availability problem, not an internal agent-logic bug.
        if (!error.code) error.code = "MODEL_PROVIDER_UNAVAILABLE";
        throw error;
      }

      messages.push(response);

      if (!response.toolCalls?.length) {
        return {
          response: response.content,
          provider: provider.name,
          conversationId,
          activity,
          discoveredTools: tools.map((tool) => tool.name),
          steps: step,
        };
      }

      const toolResults = [];

      for (const toolCall of response.toolCalls) {
        const tool = tools.find((candidate) => candidate.name === toolCall.name);

        if (!tool) throw new Error(`Agent requested undiscovered tool: ${toolCall.name}`);

        const result = await withTimeout(
          client.callTool({
            name: toolCall.name,
            arguments: toolCall.arguments || {},
          }),
          mcpTimeoutMs,
          `MCP tools/call ${toolCall.name}`
        );
        // One real tool round-trip completed. Record it, and â€” only when an
        // observer is attached (streaming transport) â€” emit the SAME record so
        // the UI can show genuine progress as it happens. onEvent is optional
        // and side-effect-only: the returned result is identical with or
        // without it, so the non-streaming /api/chat and CLI paths are unchanged.
        const record = {
          step,
          tool: toolCall.name,
          arguments: toolCall.arguments || {},
          isError: result.isError === true,
          result,
        };
        activity.push(record);
        onEvent?.({ type: "activity", activity: record });
        toolResults.push({
          role: "tool",
          toolCallId: toolCall.id,
          name: toolCall.name,
          result,
        });
      }

      messages.push(...toolResults);
    }

    throw new Error(
      `Agent exceeded MAX_AGENT_STEPS=${maxAgentSteps} without producing a final response`
    );
  } catch (error) {
    error.toolActivity = activity;
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
};

const userMessage = process.argv.slice(2).join(" ").trim();

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!userMessage) {
    console.error('Usage: node agent.js "What\'s wrong with payments?"');
    process.exitCode = 1;
  } else {
    runAgent({ message: userMessage })
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(
          JSON.stringify(
            { code: error.code || "AGENT_ERROR", error: error.message },
            null,
            2
          )
        );
        process.exitCode = 1;
      });
  }
}
