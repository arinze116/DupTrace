// _verify_markdown.mjs — focused tests for the Markdown parser (web/markdown.js).
//
// Part of the npm test suite. Pure: no DOM, no network. It verifies the parse
// layer that app.js turns into DOM (via textContent only), with emphasis on the
// cases the task calls out — tables, streaming/partial fragments, and unsafe
// HTML/links — plus the ordinary block/inline constructs.

import { parseMarkdown, parseInline, sanitizeHref } from "./web/markdown.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

// Collect every text value in an inline tree (recursively) — handy for asserting
// that raw HTML survives as literal text rather than becoming nodes.
function textOf(nodes) {
  let out = "";
  for (const n of nodes || []) {
    if (n.type === "text") out += n.value;
    else if (n.type === "code") out += n.value;
    else if (n.children) out += textOf(n.children);
    else if (n.type === "br") out += "\n";
  }
  return out;
}

console.log("\nparseInline — emphasis / code / links");
const inl = parseInline("plain **bold** and *italic* and `co*de` end");
check("bold → strong node", inl.some((n) => n.type === "strong" && textOf(n.children) === "bold"));
check("italic → em node", inl.some((n) => n.type === "em" && textOf(n.children) === "italic"));
check("inline code is literal (no emphasis inside)", inl.some((n) => n.type === "code" && n.value === "co*de"));

const link = parseInline("see [docs](https://example.com/x?a=1)");
check(
  "safe link → link node with href preserved",
  link.some((n) => n.type === "link" && n.href === "https://example.com/x?a=1" && textOf(n.children) === "docs"),
);

console.log("\nsanitizeHref — scheme allowlist (untrusted links)");
check("https allowed", sanitizeHref("https://a.test") === "https://a.test");
check("http allowed", sanitizeHref("http://a.test") === "http://a.test");
check("mailto allowed", sanitizeHref("mailto:x@a.test") === "mailto:x@a.test");
check("anchor allowed", sanitizeHref("#section") === "#section");
check("javascript: rejected", sanitizeHref("javascript:alert(1)") === null);
check("data: rejected", sanitizeHref("data:text/html,<script>") === null);
check("vbscript: rejected", sanitizeHref("vbscript:msgbox(1)") === null);
check("whitespace-wrapped javascript: rejected", sanitizeHref("  javascript:alert(1) ") === null);

const badLink = parseInline("[click](javascript:alert(1))");
check(
  "unsafe link → href null (renders as plain text, not an anchor)",
  badLink.some((n) => n.type === "link" && n.href === null && textOf(n.children) === "click"),
);

console.log("\nparseMarkdown — raw HTML is NOT interpreted (XSS-safe)");
const html = parseMarkdown("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
const htmlText = JSON.stringify(html);
check("no element/raw-html node types are produced", !/"type":"(html|raw|element)"/.test(htmlText));
check(
  "script/img survive as literal text",
  html[0].type === "paragraph" && textOf(html[0].inline).includes("<script>alert(1)</script>"),
);

console.log("\nparseMarkdown — headings, lists, fenced code");
const hd = parseMarkdown("# Title\n## Sub");
check("ATX headings with levels", hd[0].type === "heading" && hd[0].level === 1 && hd[1].level === 2);

const ul = parseMarkdown("- one\n- two\n- three");
check("unordered list with 3 items", ul[0].type === "list" && ul[0].ordered === false && ul[0].items.length === 3);
const ol = parseMarkdown("1. a\n2. b");
check("ordered list detected", ol[0].type === "list" && ol[0].ordered === true && ol[0].items.length === 2);

const fence = parseMarkdown("```js\nconst a = 1 | 2;\n<b>not html</b>\n```");
check(
  "fenced code: lang + body preserved verbatim (pipes/html literal)",
  fence[0].type === "code" && fence[0].lang === "js" && fence[0].text === "const a = 1 | 2;\n<b>not html</b>",
);

console.log("\nparseMarkdown — tables (the reported failure)");
const table = parseMarkdown(
  [
    "| Incident | Status | Confidence |",
    "|----------|:------:|-----------:|",
    "| INC-2026-001 | investigating | 0.42 |",
    "| INC-2026-002 | mitigated | 0.90 |",
  ].join("\n"),
);
check("table block produced", table[0].type === "table");
check("table header has 3 columns", table[0].header.length === 3 && textOf(table[0].header[0]) === "Incident");
check("table alignment parsed (center / right)", table[0].align[1] === "center" && table[0].align[2] === "right");
check("table has 2 body rows", table[0].rows.length === 2 && textOf(table[0].rows[0][0]) === "INC-2026-001");
check("a bare `---` line is NOT a table (no pipe separator)", parseMarkdown("a\n---\nb")[0].type !== "table");

console.log("\nparseMarkdown — streaming / partial fragments must not throw or break");
const partials = [
  "## Incident Evidence Summ", // heading mid-word
  "Here is **bold that is not closed yet", // unterminated strong
  "```js\nconst x = 1\n// code fence never closed", // open fence
  "| Incident | Status |\n|---", // table being typed (separator incomplete)
  "| Incident | Status |", // header with no separator yet
  "- item one\n- item tw", // list mid-item
  "[half link](https://examp", // half link
  "", // empty
];
let threw = false;
let allArrays = true;
for (const p of partials) {
  try {
    const out = parseMarkdown(p);
    if (!Array.isArray(out)) allArrays = false;
  } catch {
    threw = true;
  }
}
check("partial fragments never throw", !threw);
check("partial fragments always yield a block array", allArrays);
check(
  "header-with-incomplete-separator degrades to a paragraph (not a broken table)",
  parseMarkdown("| Incident | Status |\n|---")[0].type !== "table",
);
check(
  "unterminated bold degrades to literal text",
  textOf(parseMarkdown("**oops")[0].inline).includes("**oops"),
);

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log("\n" + "─".repeat(60));
console.log(
  `${failed === 0 ? "ALL MARKDOWN CHECKS PASSED" : "MARKDOWN CHECKS FAILED"} — ${passed} passed, ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
