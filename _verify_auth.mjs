// Focused tests for the hosted session and internal MCP request boundary.
import { createSessionCookie, hasValidSession, isAuthorizedMcpRequest, verifyAccessPassword } from "./auth.js";

const previous = {
  DUPTRACE_ACCESS_PASSWORD: process.env.DUPTRACE_ACCESS_PASSWORD,
  DUPTRACE_SESSION_SECRET: process.env.DUPTRACE_SESSION_SECRET,
  DUPTRACE_INTERNAL_MCP_TOKEN: process.env.DUPTRACE_INTERNAL_MCP_TOKEN,
};
const results = [];
const check = (name, ok) => { results.push({ name, ok: Boolean(ok) }); console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`); };
try {
  process.env.DUPTRACE_ACCESS_PASSWORD = "test-only-password";
  process.env.DUPTRACE_SESSION_SECRET = "test-only-session-secret-with-enough-entropy";
  process.env.DUPTRACE_INTERNAL_MCP_TOKEN = "test-only-internal-token";
  check("accepts the configured access password", verifyAccessPassword("test-only-password"));
  check("rejects a wrong access password", !verifyAccessPassword("wrong-password"));
  check("rejects password login when no candidate is provided", !verifyAccessPassword(undefined));

  const now = 1_800_000_000_000;
  const cookie = createSessionCookie(now);
  const cookiePair = cookie.split(";")[0];
  check("session cookie is HttpOnly, Secure and SameSite=Strict", /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Strict/.test(cookie));
  check("accepts a valid signed session", hasValidSession({ headers: { cookie: cookiePair } }, now));
  check("rejects a tampered session signature", !hasValidSession({ headers: { cookie: cookiePair + "x" } }, now));
  check("rejects a session after expiry", !hasValidSession({ headers: { cookie: cookiePair } }, now + 12 * 60 * 60 * 1000 + 2000));
  check("rejects a missing session cookie", !hasValidSession({ headers: {} }, now));

  check("accepts the server-only MCP token header", isAuthorizedMcpRequest({ headers: { "x-duptrace-internal-token": "test-only-internal-token" } }));
  check("rejects an incorrect MCP token", !isAuthorizedMcpRequest({ headers: { "x-duptrace-internal-token": "wrong" } }));
  check("rejects a missing MCP token", !isAuthorizedMcpRequest({ headers: {} }));
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "AUTH CHECKS FAILED" : "ALL AUTH CHECKS PASSED"} — ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
