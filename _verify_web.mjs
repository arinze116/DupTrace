// _verify_web.mjs — self-contained runtime harness for the DupTrace web layer.
//
// TEMPORARY verification tool (delete after use; never committed). It exercises
// the REAL server.js end to end and only mocks the model provider:
//
//   browser fetch  ─▶  POST /api/chat  ─▶  runAgent()  ─▶  MCP client
//                                                │            │
//                                                ▼            ▼
//                                        mock provider   server.js /mcp
//                                        (this file)     (12 real tools, in-process)
//
// server.js hosts the DupTrace MCP server, the /api/chat handler, AND the static
// web UI on one loopback origin, so the agent connects back to the same process
// via DUPTRACE_MCP_URL. Nothing here touches app.js/styles.css logic directly —
// it verifies what the browser actually receives over the wire.
//
// Expected final line when healthy:  ALL WEB CHECKS PASSED — <N> passed, 0 failed
//
// No dependencies: Node built-ins + global fetch only.

import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "server.js");

const MOCK_PORT = 4010;
const PORT_A = 3100; // Phase A — working mock provider
const PORT_B = 3101; // Phase B — provider unavailable (MODEL_PROVIDER=none)

// A sentinel that must NEVER appear in any response the browser receives.
const SECRET = "sk-verify-DO-NOT-LEAK-4242";
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;

const results = [];
const bodiesSeen = []; // every Phase-A response body, for the leak scan
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- mock OpenAI-compatible model provider ---------------------------------
// First completion → one tool call (get_service_health for payments).
// Once a role:"tool" message is present in the transcript → a final answer.
function startMockProvider() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let payload = {};
        try {
          payload = JSON.parse(raw);
        } catch {
          /* ignore */
        }
        const msgs = Array.isArray(payload.messages) ? payload.messages : [];
        const sawToolResult = msgs.some((m) => m && m.role === "tool");

        const message = sawToolResult
          ? {
              role: "assistant",
              content:
                "Payments is degraded: the latest window shows an elevated 5xx error rate and higher p95 latency.",
              tool_calls: [],
            }
          : {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_service_health",
                    arguments: JSON.stringify({ service: "payments" }),
                  },
                },
              ],
            };

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message }] }));
      });
    });
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

// --- spawn a real server.js with a controlled environment ------------------
function startServer(port, extraEnv) {
  const env = {
    ...process.env,
    PORT: String(port),
    MCP_BIND_HOST: "127.0.0.1",
    DUPTRACE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    // Let server.js fall back to its own localhost defaults for the host/origin
    // allowlists. (Setting these to "" parses to an empty allowlist, which makes
    // createMcpExpressApp 403 every request — including the readiness probe.)
    MCP_PUBLIC_URL: "",
    MCP_AUTH_MODE: "none",
    ...extraEnv,
  };
  const child = spawn(process.execPath, [SERVER], {
    cwd: HERE,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.on("data", () => {});
  child.getStderr = () => stderr;
  return child;
}

async function waitForServer(port, tries = 150) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { host: `127.0.0.1:${port}` },
      });
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  return false;
}

async function post(port, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave null */
    }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await res.text();
  return {
    status: res.status,
    text,
    contentType: res.headers.get("content-type") || "",
  };
}

// POST to the streaming endpoint and consume it as a real SSE client: read the
// body incrementally, split on blank-line frame boundaries, and collect the
// ordered events. A non-SSE response (400 validation / 403 origin) is returned
// as status + parsed JSON instead, mirroring how the browser's streamChat copes.
async function postStream(port, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") || !res.body) {
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* leave null */
      }
      return { status: res.status, contentType, events: [], raw: text, json };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let raw = "";
    const events = [];
    const drain = (frame) => {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) return;
      try {
        events.push(JSON.parse(data));
      } catch {
        /* skip malformed frame */
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;
      let b;
      while ((b = buffer.indexOf("\n\n")) !== -1) {
        drain(buffer.slice(0, b));
        buffer = buffer.slice(b + 2);
      }
    }
    if (buffer.trim()) drain(buffer);
    return { status: res.status, contentType, events, raw, json: null };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const mock = await startMockProvider();

  // =========================================================================
  // PHASE A — working provider: static assets + happy path + validation + CORS
  // =========================================================================
  const serverA = startServer(PORT_A, {
    MODEL_PROVIDER: "openai-compatible",
    MODEL_API_KEY: SECRET,
    MODEL_NAME: "mock-model",
    MODEL_BASE_URL: MOCK_BASE,
  });

  try {
    const upA = await waitForServer(PORT_A);
    if (!upA) throw new Error(`server A never came up:\n${serverA.getStderr()}`);

    console.log("\nPhase A — static assets");
    const root = await get(PORT_A, "/");
    bodiesSeen.push(root.text);
    check("GET / → 200", root.status === 200, `status ${root.status}`);
    check("GET / contains \"DupTrace\"", root.text.includes("DupTrace"));
    check("GET / contains id=\"composer\"", root.text.includes('id="composer"'));
    check("GET / references app.js", root.text.includes("app.js"));

    const css = await get(PORT_A, "/styles.css");
    bodiesSeen.push(css.text);
    check(
      "GET /styles.css → 200 text/css",
      css.status === 200 && css.contentType.includes("text/css"),
      `status ${css.status}, ct ${css.contentType}`,
    );

    const appjs = await get(PORT_A, "/app.js");
    bodiesSeen.push(appjs.text);
    check(
      "GET /app.js → 200 javascript",
      appjs.status === 200 && appjs.contentType.includes("javascript"),
      `status ${appjs.status}, ct ${appjs.contentType}`,
    );

    const apijs = await get(PORT_A, "/api.js");
    bodiesSeen.push(apijs.text);
    check(
      "GET /api.js → 200 + exports sendChat",
      apijs.status === 200 && apijs.text.includes("sendChat"),
      `status ${apijs.status}`,
    );

    const formatjs = await get(PORT_A, "/format.js");
    bodiesSeen.push(formatjs.text);
    check(
      "GET /format.js → 200 + exports structuredFacts",
      formatjs.status === 200 &&
        formatjs.contentType.includes("javascript") &&
        formatjs.text.includes("structuredFacts"),
      `status ${formatjs.status}, ct ${formatjs.contentType}`,
    );
    check("app.js imports ./format.js", appjs.text.includes("./format.js"));

    console.log("\nPhase A — happy path (real agent loop + real MCP tool)");
    const happy = await post(PORT_A, { message: "What's wrong with payments?" });
    bodiesSeen.push(happy.text);
    const b = happy.json || {};
    const activity = Array.isArray(b.toolActivity) ? b.toolActivity : [];
    const first = activity[0] || {};
    check("POST /api/chat → 200 ok:true", happy.status === 200 && b.ok === true, `status ${happy.status}`);
    check(
      "assistant content is a non-empty string",
      typeof b?.message?.content === "string" && b.message.content.trim().length > 0,
    );
    check("toolActivity is a non-empty array", activity.length > 0, `len ${activity.length}`);
    check("activity[0].tool === get_service_health", first.tool === "get_service_health", String(first.tool));
    check(
      "activity[0].arguments.service === payments",
      first.arguments && first.arguments.service === "payments",
      JSON.stringify(first.arguments),
    );
    check("activity[0].isError === false", first.isError === false, String(first.isError));
    check(
      "activity[0].result carries real MCP data",
      first.result &&
        (first.result.structuredContent != null || Array.isArray(first.result.content)),
    );

    console.log("\nPhase A — streaming (SSE) happy path");
    const stream = await postStream(PORT_A, { message: "What's wrong with payments?" });
    bodiesSeen.push(stream.raw);
    const evTypes = stream.events.map((e) => e.type);
    const activityEvents = stream.events.filter((e) => e.type === "activity");
    const firstAct = (activityEvents[0] && activityEvents[0].activity) || {};
    const answerEv = stream.events.find((e) => e.type === "answer");
    check(
      "stream content-type is text/event-stream",
      stream.contentType.includes("text/event-stream"),
      stream.contentType,
    );
    check("stream opens with a start event", evTypes[0] === "start", evTypes.join(","));
    check(
      "stream closes with a done event",
      evTypes[evTypes.length - 1] === "done",
      evTypes.join(","),
    );
    check(
      "activity event carries real MCP tool data",
      activityEvents.length > 0 &&
        firstAct.tool === "get_service_health" &&
        firstAct.arguments &&
        firstAct.arguments.service === "payments" &&
        firstAct.isError === false &&
        firstAct.result &&
        (firstAct.result.structuredContent != null ||
          Array.isArray(firstAct.result.content)),
      `${activityEvents.length} activity event(s), tool ${firstAct.tool}`,
    );
    check(
      "answer event has non-empty assistant content",
      typeof answerEv?.message?.content === "string" &&
        answerEv.message.content.trim().length > 0,
    );
    check(
      "event order is start → activity → answer → done",
      evTypes[0] === "start" &&
        evTypes.indexOf("activity") > 0 &&
        evTypes.indexOf("answer") > evTypes.indexOf("activity") &&
        evTypes.indexOf("done") > evTypes.indexOf("answer"),
      evTypes.join(","),
    );
    check(
      "streamed answer matches non-streaming answer (parity)",
      answerEv?.message?.content === b?.message?.content,
    );

    console.log("\nPhase A — streaming validation + origin guard");
    const streamEmpty = await postStream(PORT_A, {});
    bodiesSeen.push(streamEmpty.raw);
    check(
      "stream POST {} → 400 INVALID_REQUEST (stream never opened)",
      streamEmpty.status === 400 &&
        streamEmpty.json?.error?.code === "INVALID_REQUEST",
      `status ${streamEmpty.status}`,
    );
    const streamForeign = await postStream(
      PORT_A,
      { message: "What's wrong with payments?" },
      { origin: "https://evil.example.com" },
    );
    bodiesSeen.push(streamForeign.raw);
    check(
      "stream foreign Origin → 403",
      streamForeign.status === 403,
      `status ${streamForeign.status}`,
    );

    console.log("\nPhase A — request validation (400 INVALID_REQUEST)");
    const empty = await post(PORT_A, {});
    bodiesSeen.push(empty.text);
    check(
      "POST {} → 400 INVALID_REQUEST",
      empty.status === 400 && empty.json?.error?.code === "INVALID_REQUEST",
      `status ${empty.status}`,
    );
    const wrongType = await post(PORT_A, { message: 123 });
    bodiesSeen.push(wrongType.text);
    check("POST {message:123} → 400", wrongType.status === 400, `status ${wrongType.status}`);
    const blank = await post(PORT_A, { message: "   " });
    bodiesSeen.push(blank.text);
    check("POST {message:\"   \"} → 400", blank.status === 400, `status ${blank.status}`);

    console.log("\nPhase A — DNS-rebinding / cross-origin guard");
    const foreign = await post(
      PORT_A,
      { message: "What's wrong with payments?" },
      { origin: "https://evil.example.com" },
    );
    bodiesSeen.push(foreign.text);
    check("foreign Origin → 403", foreign.status === 403, `status ${foreign.status}`);

    console.log("\nPhase A — follow-up context contract");
    const withCtx = await post(PORT_A, {
      message: "Show the evidence",
      context: { activeIncidentId: "INC-2026-001", service: "payments" },
    });
    bodiesSeen.push(withCtx.text);
    check(
      "valid follow-up context accepted → 200 ok:true (investigation still runs)",
      withCtx.status === 200 && withCtx.json?.ok === true,
      `status ${withCtx.status}`,
    );
    const badCtx = await post(PORT_A, {
      message: "Show the evidence",
      context: { activeIncidentId: "'; DROP", service: "not-a-service", junk: 1 },
    });
    bodiesSeen.push(badCtx.text);
    check(
      "malformed context safely ignored → 200 ok:true (not 400, no crash)",
      badCtx.status === 200 && badCtx.json?.ok === true,
      `status ${badCtx.status}`,
    );
    const omittedCtx = await post(PORT_A, { message: "Show the evidence" });
    bodiesSeen.push(omittedCtx.text);
    check(
      "omitted context remains fully supported → 200 ok:true",
      omittedCtx.status === 200 && omittedCtx.json?.ok === true,
      `status ${omittedCtx.status}`,
    );

    console.log("\nPhase A — secret-leak scan (all bodies above)");
    const joined = bodiesSeen.join("\n");
    const leaked =
      joined.includes(SECRET) ||
      joined.includes(MOCK_BASE) ||
      joined.includes("127.0.0.1:" + MOCK_PORT) ||
      joined.includes("Bearer ");
    check(
      "no API key / provider URL / Bearer token in any response",
      !leaked,
      leaked ? "SENSITIVE VALUE FOUND IN RESPONSE" : "",
    );
  } finally {
    serverA.kill();
  }

  // =========================================================================
  // PHASE B — provider unavailable: 503 MODEL_PROVIDER_UNAVAILABLE, no leak
  // =========================================================================
  const serverB = startServer(PORT_B, { MODEL_PROVIDER: "none" });
  try {
    const upB = await waitForServer(PORT_B);
    if (!upB) throw new Error(`server B never came up:\n${serverB.getStderr()}`);

    console.log("\nPhase B — model provider unavailable");
    const down = await post(PORT_B, { message: "What's wrong with payments?" });
    const bodyB = down.json || {};
    check(
      "POST /api/chat → 503 MODEL_PROVIDER_UNAVAILABLE",
      down.status === 503 && bodyB?.error?.code === "MODEL_PROVIDER_UNAVAILABLE",
      `status ${down.status}, code ${bodyB?.error?.code}`,
    );
    const leakedB =
      down.text.includes(SECRET) ||
      down.text.includes("Bearer ") ||
      down.text.includes("Unsupported MODEL_PROVIDER");
    check("503 body leaks no internal detail", !leakedB);

    console.log("\nPhase B — streaming with provider unavailable");
    const downStream = await postStream(PORT_B, {
      message: "What's wrong with payments?",
    });
    const errEv = downStream.events.find((e) => e.type === "error");
    check(
      "stream emits an error event with MODEL_PROVIDER_UNAVAILABLE",
      downStream.status === 200 &&
        errEv?.error?.code === "MODEL_PROVIDER_UNAVAILABLE",
      `status ${downStream.status}, code ${errEv?.error?.code}`,
    );
    const leakedBStream =
      downStream.raw.includes(SECRET) ||
      downStream.raw.includes("Bearer ") ||
      downStream.raw.includes("Unsupported MODEL_PROVIDER");
    check("stream error event leaks no internal detail", !leakedBStream);
  } finally {
    serverB.kill();
  }

  mock.close();

  // --- summary --------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log("\n" + "─".repeat(60));
  if (failed === 0) {
    console.log(`ALL WEB CHECKS PASSED — ${passed} passed, ${failed} failed`);
  } else {
    console.log(`WEB CHECKS FAILED — ${passed} passed, ${failed} failed`);
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`   ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nHARNESS ERROR:", err?.stack || err);
  process.exit(1);
});
