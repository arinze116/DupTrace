// markdown.js — a tiny, dependency-free, DOM-free Markdown parser.
//
// It parses a safe SUBSET of Markdown into a plain AST (arrays of block/inline
// nodes). It never touches the DOM and never produces HTML strings, so it is
// unit-testable in plain Node (see _verify_markdown.mjs) and the browser-side
// renderer (app.js) can turn the AST into DOM nodes using textContent only —
// preserving DupTrace's "never innerHTML, all model output is untrusted" rule.
//
// Supported: ATX headings (#..######), paragraphs with soft line breaks,
// **bold**/__bold__, *italic*/_italic_, `inline code`, [links](url), ordered and
// unordered lists, fenced code blocks (``` or ~~~), and pipe tables.
//
// Safety: link hrefs are scheme-validated here (javascript:, data:, etc. are
// rejected → the link renders as plain text). Raw HTML in the source is never
// interpreted — it stays as literal text nodes. The parser is TOTAL: any input,
// including partial/streaming fragments (unterminated **, an open code fence, a
// half-written table), yields an AST without throwing.

/**
 * Validate a link target. Returns a safe href string, or null when the scheme is
 * not allowlisted (caller then renders the link text as plain text).
 * @param {string} raw
 * @returns {string|null}
 */
export function sanitizeHref(raw) {
  const href = String(raw ?? "").trim();
  if (!href) return null;
  // Allow same-document anchors and clearly-relative paths (same origin).
  if (/^[#/](?!\/)/.test(href) || /^\.\.?\//.test(href)) return href;
  // Allow only these absolute schemes; everything else (javascript:, data:,
  // vbscript:, file:, …) is rejected. Leading control chars can't sneak a scheme
  // past this because we test the trimmed start.
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  return null;
}

const BLANK = /^\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function isBlank(line) {
  return line == null || BLANK.test(line);
}

/** A table separator row like `---|:--:|--:` (must contain a pipe to beat `---` hr). */
function isTableSeparator(line) {
  if (line == null || !line.includes("|")) return false;
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line);
}

/** Split a table row into trimmed cell strings, tolerating optional outer pipes. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseAlign(sep) {
  return splitRow(sep).map((c) => {
    const t = c.trim();
    const left = t.startsWith(":");
    const right = t.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/** True when `line` begins a non-paragraph block (used to end paragraph runs). */
function startsBlock(line, next) {
  if (line == null) return false;
  if (FENCE.test(line)) return true;
  if (HEADING.test(line)) return true;
  if (LIST_ITEM.test(line)) return true;
  if (line.includes("|") && isTableSeparator(next)) return true;
  return false;
}

/**
 * Parse inline Markdown into inline nodes. Total: unterminated markers degrade to
 * literal text. Nodes: {type:"text",value} | {type:"strong"|"em"|"link",children}
 * | {type:"code",value} | {type:"br"} ; link also carries {href}.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseInline(text) {
  const src = String(text ?? "");
  const nodes = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      nodes.push({ type: "text", value: buf });
      buf = "";
    }
  };

  while (i < src.length) {
    const c = src[i];

    // Backslash escape of a Markdown punctuation character → literal.
    if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    // Inline code (highest precedence; no formatting inside).
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        nodes.push({ type: "code", value: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Link: [text](href) with an optional "title".
    if (c === "[") {
      const m = /^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(src.slice(i));
      if (m) {
        flush();
        nodes.push({ type: "link", href: sanitizeHref(m[2]), children: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }

    // Strong: ** or __
    if ((c === "*" && src[i + 1] === "*") || (c === "_" && src[i + 1] === "_")) {
      const marker = c + c;
      const end = src.indexOf(marker, i + 2);
      if (end !== -1) {
        flush();
        nodes.push({ type: "strong", children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // Emphasis: * or _
    if (c === "*" || c === "_") {
      const end = src.indexOf(c, i + 1);
      if (end !== -1 && end > i + 1) {
        flush();
        nodes.push({ type: "em", children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    buf += c;
    i += 1;
  }
  flush();
  return nodes;
}

/**
 * Parse a Markdown document into block nodes. Total (never throws) for any input,
 * including partial/streaming fragments.
 * Blocks: {type:"heading",level,inline} | {type:"paragraph",inline} |
 *   {type:"list",ordered,items:[inline[]]} | {type:"code",lang,text} |
 *   {type:"table",align,header:[inline[]],rows:[[inline[]]]}
 * @param {string} source
 * @returns {Array<object>}
 */
export function parseMarkdown(source) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // Fenced code block.
    const fence = FENCE.exec(line);
    if (fence) {
      const markerChar = fence[2][0];
      const len = fence[2].length;
      const lang = fence[3].trim();
      const closeRe = new RegExp("^\\s*" + (markerChar === "`" ? "`" : "~") + "{" + len + ",}\\s*$");
      i += 1;
      const body = [];
      while (i < lines.length && !closeRe.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing fence (absent at EOF → fine)
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }

    // ATX heading.
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    // Pipe table: a header row with a pipe, immediately followed by a delimiter
    // row that has the SAME number of columns (per GitHub tables). The column
    // match also means a half-typed delimiter (e.g. "|---" under a two-column
    // header, as seen mid-stream) does NOT produce a broken table — it stays text.
    if (line.includes("|") && isTableSeparator(lines[i + 1])) {
      const headerCells = splitRow(line);
      const sepCells = splitRow(lines[i + 1]);
      if (headerCells.length === sepCells.length) {
        const header = headerCells.map(parseInline);
        const align = parseAlign(lines[i + 1]);
        i += 2;
        const rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
          rows.push(splitRow(lines[i]).map(parseInline));
          i += 1;
        }
        blocks.push({ type: "table", align, header, rows });
        continue;
      }
    }

    // List (consecutive items of the same ordered/unordered kind).
    const first = LIST_ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2]);
      const items = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m) break;
        if (/\d/.test(m[2]) !== ordered) break; // a different kind starts a new list
        items.push(parseInline(m[3]));
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph: consecutive lines until a blank line or a new block starts. Single
    // newlines become soft breaks (<br>) — friendlier for chat text than collapsing.
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length === 0) {
      // Defensive: guarantee forward progress (should not happen).
      para.push(line);
      i += 1;
    }
    const inline = [];
    para.forEach((p, idx) => {
      if (idx > 0) inline.push({ type: "br" });
      for (const node of parseInline(p)) inline.push(node);
    });
    blocks.push({ type: "paragraph", inline });
  }

  return blocks;
}
