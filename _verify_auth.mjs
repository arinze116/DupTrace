import { isAuthorizedMcpRequest } from "./auth.js";

const previous = process.env.DUPTRACE_INTERNAL_MCP_TOKEN;
const results = [];
const check = (name, ok) => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
};

try {
  process.env.DUPTRACE_INTERNAL_MCP_TOKEN = "test-only-internal-token";
  check(
    "accepts the server-only MCP token header",
    isAuthorizedMcpRequest({
      headers: { "x-duptrace-internal-token": "test-only-internal-token" },
    }),
  );
  check(
    "rejects an incorrect MCP token",
    !isAuthorizedMcpRequest({ headers: { "x-duptrace-internal-token": "wrong" } }),
  );
  check(
    "rejects a missing MCP token",
    !isAuthorizedMcpRequest({ headers: {} }),
  );
  delete process.env.DUPTRACE_INTERNAL_MCP_TOKEN;
  check(
    "rejects requests when the internal token is not configured",
    !isAuthorizedMcpRequest({ headers: { "x-duptrace-internal-token": "test-only-internal-token" } }),
  );
} finally {
  if (previous === undefined) delete process.env.DUPTRACE_INTERNAL_MCP_TOKEN;
  else process.env.DUPTRACE_INTERNAL_MCP_TOKEN = previous;
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length ? "MCP AUTH CHECKS FAILED" : "ALL MCP AUTH CHECKS PASSED"} — ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
