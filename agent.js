import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { fileURLToPath } from "node:url";
import { buildContextMessage } from "./chat_context.js";

const defaultMaxAgentSteps = 12;
const defaultMcpTimeoutMs = 10000;
const defaultModelTimeoutMs = 60000;
// The claude-cli provider shells out to the interactive Claude CLI, which is far
// slower than a hosted API call — tens of seconds per turn is normal — so it gets
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
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
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
    mcpUrl = getRequiredEnvironment("DUPTRACE_MCP_URL");
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
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

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

const createOpenAiCompatibleProvider = () => {
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

      try {
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
// explicitly with concrete examples — the DupTrace rules in --system-prompt do
// not — and carry the running transcript so prior tool results inform reasoning.
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
    "object and nothing else — no prose, no Markdown, no code fences.",
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
      // withTimeout can only lose a Promise race — it has no handle to this child,
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

const createProvider = () => {
  let provider;

  try {
    provider = getRequiredEnvironment("MODEL_PROVIDER");
  } catch (error) {
    throw createAgentError("MODEL_PROVIDER_UNAVAILABLE", error.message, error);
  }

  if (provider === "openai-compatible") return createOpenAiCompatibleProvider();
  if (provider === "claude-cli") return createClaudeCliProvider();

  throw createAgentError(
    "MODEL_PROVIDER_UNAVAILABLE",
    `Unsupported MODEL_PROVIDER=${provider}. Use openai-compatible or claude-cli.`
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
  // labelled message BEFORE the current user turn — never as evidence, and it does
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
        // One real tool round-trip completed. Record it, and — only when an
        // observer is attached (streaming transport) — emit the SAME record so
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
