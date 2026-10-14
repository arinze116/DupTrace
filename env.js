// env.js — zero-dependency .env loader.
//
// Why this exists: the entry points (`tsx server.js`, `node agent.js`) run the
// file directly, so process.env relies on the shell exporting every variable.
// `node --env-file` / dotenv are not used here (no new dependency, and tsx does
// not read .env by itself). Without this, a variable defined ONLY in .env — most
// importantly DUPTRACE_MCP_URL, which agent.js requires before it will connect to
// the MCP server — is undefined, so MCP initialization fails with MCP_UNAVAILABLE
// before any connection is attempted.
//
// Real environment variables always WIN: a variable already present in
// process.env is never overwritten. That keeps `KEY=value npm start` overrides and
// the test harnesses' explicit child env authoritative over the file.

import { readFileSync } from "node:fs";

/**
 * Parse .env text into a key→value map. Pure and dependency-free.
 * Rules: skip blank lines and `#` comments; tolerate a leading `export `; split on
 * the first `=` only; strip one layer of matching surrounding quotes. Values may
 * contain `=` (e.g. URLs with query strings) because we split on the first `=`.
 * @param {string} text
 * @returns {Record<string,string>}
 */
export const parseEnvFile = (text) => {
  /** @type {Record<string,string>} */
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

/**
 * Load a .env file into process.env without overriding anything already set.
 * A missing/unreadable file is a silent no-op (safe in production, in the
 * test harnesses, and in a bare checkout).
 * @param {string|URL} path
 * @returns {number} count of variables actually applied (for diagnostics/tests)
 */
export const loadEnvFile = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  const parsed = parseEnvFile(text);
  let applied = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied += 1;
    }
  }
  return applied;
};
