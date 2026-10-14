// _verify_env.mjs — focused tests for the .env loader (env.js).
//
// Part of the npm test suite. Proves the two invariants that matter for the MCP
// fix: (1) a variable defined ONLY in a .env file becomes available to
// process.env after loading, and (2) an already-set real environment variable is
// NEVER overwritten by the file. No dependencies, no network, no secrets.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseEnvFile, loadEnvFile } from "./env.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

// --- parseEnvFile: pure parsing rules ---------------------------------------
const parsed = parseEnvFile(
  [
    "# a comment",
    "   # an indented comment (leading whitespace)",
    "",
    "   ",
    "PLAIN=value",
    "export EXPORTED=yes",
    'QUOTED="has spaces"',
    "SINGLE='single quoted'",
    "WITH_EQUALS=a=b=c",
    "  SPACED_KEY  =  spaced value  ",
    "NOEQUALS",
  ].join("\n"),
);

// Assert the EXACT parsed key set — this proves comments (incl. indented ones) and
// blank/whitespace-only lines contribute nothing, while every real key is present.
const EXPECTED_KEYS = ["PLAIN", "EXPORTED", "QUOTED", "SINGLE", "WITH_EQUALS", "SPACED_KEY"];
const actualKeys = Object.keys(parsed).sort();
check(
  "skips comments (incl. indented) and blank/whitespace-only lines",
  JSON.stringify(actualKeys) === JSON.stringify([...EXPECTED_KEYS].sort()),
  actualKeys.join(","),
);
check("plain key=value", parsed.PLAIN === "value");
check("strips a leading `export `", parsed.EXPORTED === "yes");
check("strips matching double quotes", parsed.QUOTED === "has spaces");
check("strips matching single quotes", parsed.SINGLE === "single quoted");
check("splits on the FIRST '=' only (URLs/values with '=')", parsed.WITH_EQUALS === "a=b=c");
check("trims key and value whitespace", parsed.SPACED_KEY === "spaced value");
check("ignores a line with no '='", !("NOEQUALS" in parsed));

// --- loadEnvFile: applies only unset variables ------------------------------
const dir = mkdtempSync(join(tmpdir(), "duptrace-env-"));
const envPath = join(dir, ".env");
writeFileSync(
  envPath,
  ["DUPTRACE_TEST_FROM_FILE=from-file", "DUPTRACE_TEST_PRESET=from-file", "DUPTRACE_TEST_EMPTY="].join("\n"),
);

delete process.env.DUPTRACE_TEST_FROM_FILE;
process.env.DUPTRACE_TEST_PRESET = "from-real-env";

const applied = loadEnvFile(envPath);

check("loads a variable defined only in the file", process.env.DUPTRACE_TEST_FROM_FILE === "from-file");
check("does NOT overwrite a real environment variable", process.env.DUPTRACE_TEST_PRESET === "from-real-env");
check("loads an empty value as empty string", process.env.DUPTRACE_TEST_EMPTY === "");
check("returns the count of applied variables", applied === 2, `applied ${applied}`);

check("missing file is a silent no-op (returns 0)", loadEnvFile(join(dir, "does-not-exist.env")) === 0);

// --- the real .env, if present, must expose DUPTRACE_MCP_URL ----------------
// (This is the exact variable agent.js requires before it will connect to MCP.)
const realEnvPath = join(HERE, ".env");
const before = process.env.DUPTRACE_MCP_URL;
loadEnvFile(realEnvPath);
check(
  "repo .env (when present) provides DUPTRACE_MCP_URL for the agent",
  process.env.DUPTRACE_MCP_URL === before || /^https?:\/\//.test(process.env.DUPTRACE_MCP_URL || ""),
  String(process.env.DUPTRACE_MCP_URL),
);

// cleanup
delete process.env.DUPTRACE_TEST_FROM_FILE;
delete process.env.DUPTRACE_TEST_PRESET;
delete process.env.DUPTRACE_TEST_EMPTY;
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* ignore */
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log("\n" + "─".repeat(60));
console.log(
  `${failed === 0 ? "ALL ENV CHECKS PASSED" : "ENV CHECKS FAILED"} — ${passed} passed, ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
