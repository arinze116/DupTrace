// _verify_provider.mjs — focused runtime harness for the claude-cli provider.
//
// TEMPORARY verification tool (delete after use; never committed). It does NOT
// call the real `claude` binary — that needs auth and ~80s per turn. Instead it:
//   1. unit-tests the pure parser parseClaudeAgentResponse() (the schema handling
//      that previously silently failed), and
//   2. drives the real createClaudeCliProvider().complete() against a tiny stub
//      "CLI" (a node script wired in via MODEL_CLI_COMMAND) to exercise the
//      spawn / exit-code / timeout-and-terminate paths without MCP or a model.
//
// A small MODEL_CLI_TIMEOUT_MS is set BEFORE importing agent.js so the timeout
// test does not take minutes. Node built-ins + global fetch only; no deps.
//
// Expected final line when healthy:  ALL PROVIDER CHECKS PASSED — <N> passed, 0 failed

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "_stub_claude.mjs");
const TIMEOUT_MS = 8000;

// Must be set before importing agent.js — it reads the timeout once at load.
process.env.MODEL_CLI_TIMEOUT_MS = String(TIMEOUT_MS);

const { parseClaudeAgentResponse, createClaudeCliProvider } = await import("./agent.js");

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
