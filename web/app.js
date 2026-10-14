// app.js — DupTrace investigation workspace.
//
// Pure DOM: no framework, no build step, no new dependencies. It renders the
// existing /api/chat(/stream) responses into a three-pane investigation surface
// — a rail of recent investigations, the central conversation + evidence, and a
// context inspector — without inventing anything the API did not return.
//
// Data-integrity rules preserved from the previous build:
//   • every label is derived from the actual tool name (no hard-coded sequence)
//   • every count is computed from the actual toolActivity array
//   • step numbers are shown only when the API provided them
//   • context chips show only values that exist in arguments / results
//   • the assistant answer is rendered verbatim from message.content
//   • ALL text reaches the page via textContent (never innerHTML) → XSS-safe;
//     icons are built with createElementNS, so the no-innerHTML rule holds
//   • the browser talks only to /api/chat and /api/chat/stream — never to MCP
// The pure, DOM-free formatters behind these rules live in ./format.js so the
// same code is unit-tested directly (see _verify_format.mjs).

import { sendChat, streamChat } from "./api.js";
import { parseMarkdown } from "./markdown.js";
import {
  humanizeTool,
  contextValues,
  stringifySafe,
  previewOf,
  structuredFacts,
  resultIsEmpty,
  labelFor,
  truncate,
  deriveContext,
  RAW_RESULT_LIMIT,
} from "./format.js";

// Realistic starting questions for this product (service health, incidents,
// deployments, events). Ordinary /api/chat messages — never pre-answered.
const EXAMPLE_PROMPTS = [
  "What's wrong with payments?",
  "Show recent incidents",
  "What deployed before the latest incident?",
];

// Generic follow-up shortcuts. Ordinary user messages sent through /api/chat —
// never special frontend commands, never pre-answered. Shown only after a turn
// where an investigation actually ran.
const FOLLOW_UPS = [
  "What deployment is related?",
  "Show the evidence",
  "What happened before the incident?",
];

const INPUT_MAX_HEIGHT = 200;

const THEME_KEY = "duptrace.theme";
const STORE_KEY = "duptrace.investigations.v1";
const MAX_INVESTIGATIONS = 30; // bound rail growth + localStorage size
const MAX_TURNS_PERSISTED = 60; // per-thread safety cap

/**
 * @typedef {{ role: "user", content: string }} UserTurn
 * @typedef {{ role: "assistant", content: string, toolActivity: import("./api.js").ToolActivity[] }} AssistantTurn
 * @typedef {{
 *   id: string,
 *   title: string,
 *   conversationId: (string|null),
 *   context: ({ activeIncidentId: (string|null), service: (string|null) }|null),
 *   turns: Array<UserTurn|AssistantTurn>,
 *   createdAt: number,
 *   updatedAt: number
 * }} Investigation
 */

/**
 * Each investigation is one conversation thread. Threads persist to localStorage
 * so the "Recent" list is real across reloads; this stores only data the browser
 * already received and rendered (no secrets ever reach the client).
 */
const state = {
  /** @type {Investigation[]} most-recent-first */
  investigations: [],
  /** @type {string|null} */
  activeId: null,
  pending: false,
};

const els = {
  app: /** @type {HTMLElement} */ (document.getElementById("app")),
  scrim: /** @type {HTMLElement} */ (document.getElementById("scrim")),
  rail: /** @type {HTMLElement} */ (document.getElementById("rail")),
  railClose: /** @type {HTMLButtonElement} */ (document.getElementById("railClose")),
  menuToggle: /** @type {HTMLButtonElement} */ (document.getElementById("menuToggle")),
  inspector: /** @type {HTMLElement} */ (document.getElementById("inspector")),
  inspectorToggle: /** @type {HTMLButtonElement} */ (document.getElementById("inspectorToggle")),
  inspectorClose: /** @type {HTMLButtonElement} */ (document.getElementById("inspectorClose")),
  inspectorBody: /** @type {HTMLElement} */ (document.getElementById("inspectorBody")),
  newInvestigation: /** @type {HTMLButtonElement} */ (document.getElementById("newInvestigation")),
  investigationList: /** @type {HTMLElement} */ (document.getElementById("investigationList")),
  investigationEmpty: /** @type {HTMLElement} */ (document.getElementById("investigationEmpty")),
  themeToggle: /** @type {HTMLButtonElement} */ (document.getElementById("themeToggle")),
  themeIcon: /** @type {HTMLElement} */ (document.getElementById("themeIcon")),
  workspaceTitle: /** @type {HTMLElement} */ (document.getElementById("workspaceTitle")),
  workspaceSub: /** @type {HTMLElement} */ (document.getElementById("workspaceSub")),
  conversation: /** @type {HTMLElement} */ (document.getElementById("conversation")),
  form: /** @type {HTMLFormElement} */ (document.getElementById("composer")),
  input: /** @type {HTMLTextAreaElement} */ (document.getElementById("composerInput")),
  send: /** @type {HTMLButtonElement} */ (document.getElementById("sendButton")),
  statusDot: /** @type {HTMLElement} */ (document.querySelector(".status__dot")),
  statusLabel: /** @type {HTMLElement} */ (document.getElementById("statusLabel")),
};

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} tag
 * @param {string|null} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Screen-reader-only label. */
function srOnly(text) {
  return el("span", "sr-only", text);
}

function scrollToEnd() {
  requestAnimationFrame(() => {
    els.conversation.scrollTop = els.conversation.scrollHeight;
  });
}

// ---------------------------------------------------------------------------
// Icons — one coherent inline-SVG stroke family (no emoji, no icon font)
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/** name → array of [elementTag, attributes]. Stroke styling is applied by CSS .icon. */
const ICONS = {
  menu: [
    ["line", { x1: 4, y1: 7, x2: 20, y2: 7 }],
    ["line", { x1: 4, y1: 12, x2: 20, y2: 12 }],
    ["line", { x1: 4, y1: 17, x2: 20, y2: 17 }],
  ],
  close: [
    ["line", { x1: 6, y1: 6, x2: 18, y2: 18 }],
    ["line", { x1: 18, y1: 6, x2: 6, y2: 18 }],
  ],
  plus: [
    ["line", { x1: 12, y1: 5, x2: 12, y2: 19 }],
    ["line", { x1: 5, y1: 12, x2: 19, y2: 12 }],
  ],
  panel: [
    ["rect", { x: 2.5, y: 4.5, width: 19, height: 15, rx: 2.5 }],
    ["line", { x1: 15, y1: 4.5, x2: 15, y2: 19.5 }],
  ],
  chevron: [["polyline", { points: "9 6 15 12 9 18" }]],
  sun: [
    ["circle", { cx: 12, cy: 12, r: 4 }],
    ["line", { x1: 12, y1: 1.8, x2: 12, y2: 4 }],
    ["line", { x1: 12, y1: 20, x2: 12, y2: 22.2 }],
    ["line", { x1: 1.8, y1: 12, x2: 4, y2: 12 }],
    ["line", { x1: 20, y1: 12, x2: 22.2, y2: 12 }],
    ["line", { x1: 4.6, y1: 4.6, x2: 6.2, y2: 6.2 }],
    ["line", { x1: 17.8, y1: 17.8, x2: 19.4, y2: 19.4 }],
    ["line", { x1: 19.4, y1: 4.6, x2: 17.8, y2: 6.2 }],
    ["line", { x1: 6.2, y1: 17.8, x2: 4.6, y2: 19.4 }],
  ],
  moon: [["path", { d: "M20.5 13.3A8.3 8.3 0 1 1 10.7 3.5 6.5 6.5 0 0 0 20.5 13.3z" }]],
  trace: [["path", { d: "M2 13h4l2.4-7 3.3 13 2.3-9 1.7 5H22" }]],
  search: [
    ["circle", { cx: 11, cy: 11, r: 7 }],
    ["line", { x1: 16.5, y1: 16.5, x2: 21, y2: 21 }],
  ],
  refresh: [
    ["path", { d: "M3 12a9 9 0 0 1 15-6.7L21 8" }],
    ["path", { d: "M21 3v5h-5" }],
    ["path", { d: "M21 12a9 9 0 0 1-15 6.7L3 16" }],
    ["path", { d: "M3 21v-5h5" }],
  ],
  info: [
    ["circle", { cx: 12, cy: 12, r: 9 }],
    ["line", { x1: 12, y1: 11, x2: 12, y2: 16 }],
    ["path", { d: "M12 7.6h.01" }],
  ],
  alert: [
    ["path", { d: "M10.3 4.4 2.7 17.5a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z" }],
    ["line", { x1: 12, y1: 10, x2: 12, y2: 14 }],
    ["path", { d: "M12 17.3h.01" }],
  ],
};

/**
 * Build an inline SVG icon via the DOM (never innerHTML).
 * @param {keyof typeof ICONS} name
 * @param {number} [size]
 * @returns {SVGElement}
 */
function icon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "icon");
  for (const [tag, attrs] of ICONS[name] || []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) node.setAttribute(k, String(attrs[k]));
    svg.appendChild(node);
  }
  return svg;
}

function setIcon(node, name, size) {
  if (!node) return;
  node.textContent = "";
  node.appendChild(icon(name, size));
}

function mountStaticIcons() {
  setIcon(els.menuToggle, "menu");
  setIcon(els.railClose, "close");
  setIcon(els.inspectorToggle, "panel");
  setIcon(els.inspectorClose, "close");
  setIcon(document.querySelector(".newbtn__icon"), "plus", 17);
}

// ---------------------------------------------------------------------------
// Theme system — explicit choice persists; otherwise follow the OS
// ---------------------------------------------------------------------------

const rootEl = document.documentElement;

function savedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

function systemPrefersDark() {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

function resolvedTheme() {
  return savedTheme() || (systemPrefersDark() ? "dark" : "light");
}

function applyTheme(theme) {
  rootEl.setAttribute("data-theme", theme);
  const dark = theme === "dark";
  // Icon + accessible name + tooltip describe the ACTION (the destination mode):
  // in dark mode the control shows a sun and offers to switch to light, and the
  // reverse in light mode — so a single icon button is unambiguous.
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  els.themeToggle.setAttribute("aria-label", label);
  els.themeToggle.setAttribute("title", label);
  setIcon(els.themeIcon, dark ? "sun" : "moon", 18);
}

function setTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage disabled — theme still applies for this session */
  }
  applyTheme(theme);
}

function toggleTheme() {
  setTheme(resolvedTheme() === "dark" ? "light" : "dark");
}

function initTheme() {
  applyTheme(resolvedTheme());
  try {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        // Follow the OS only while the user has made no explicit choice.
        if (!savedTheme()) applyTheme(e.matches ? "dark" : "light");
      });
  } catch {
    /* matchMedia unavailable — explicit toggle still works */
  }
}

// ---------------------------------------------------------------------------
// Investigation store (persistence + lifecycle)
// ---------------------------------------------------------------------------

function uid() {
  try {
    if (window.crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return "inv-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** Thread title from the first user message (collapsed, clipped). */
function titleFrom(message) {
  const t = String(message || "").replace(/\s+/g, " ").trim();
  if (!t) return "Investigation";
  return t.length > 60 ? t.slice(0, 60).trimEnd() + "…" : t;
}

function activeInvestigation() {
  return state.investigations.find((i) => i.id === state.activeId) || null;
}

function createInvestigation(firstMessage) {
  const now = Date.now();
  const inv = {
    id: uid(),
    title: titleFrom(firstMessage),
    conversationId: null,
    context: null,
    turns: [],
    createdAt: now,
    updatedAt: now,
  };
  state.investigations.unshift(inv);
  if (state.investigations.length > MAX_INVESTIGATIONS) {
    state.investigations.length = MAX_INVESTIGATIONS;
  }
  state.activeId = inv.id;
  return inv;
}

function sanitizeContext(c) {
  if (!c || typeof c !== "object") return null;
  const activeIncidentId = typeof c.activeIncidentId === "string" ? c.activeIncidentId : null;
  const service = typeof c.service === "string" ? c.service : null;
  if (!activeIncidentId && !service) return null;
  return { activeIncidentId, service };
}

function sanitizeTurn(t) {
  if (!t || typeof t !== "object") return null;
  if (t.role === "user") {
    return { role: "user", content: typeof t.content === "string" ? t.content : "" };
  }
  if (t.role === "assistant") {
    return {
      role: "assistant",
      content: typeof t.content === "string" ? t.content : "",
      toolActivity: Array.isArray(t.toolActivity) ? t.toolActivity : [],
    };
  }
  return null;
}

function sanitizeInvestigation(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  const turns = Array.isArray(raw.turns)
    ? raw.turns.map(sanitizeTurn).filter(Boolean).slice(-MAX_TURNS_PERSISTED)
    : [];
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  return {
    id: raw.id,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "Investigation",
    conversationId: typeof raw.conversationId === "string" ? raw.conversationId : null,
    context: sanitizeContext(raw.context),
    turns,
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
  };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.investigations)) return;
    state.investigations = data.investigations
      .map(sanitizeInvestigation)
      .filter(Boolean)
      .slice(0, MAX_INVESTIGATIONS);
    const active = typeof data.activeId === "string" ? data.activeId : null;
    state.activeId = state.investigations.some((i) => i.id === active) ? active : null;
  } catch {
    /* absent or corrupt storage — start fresh, in-memory */
  }
}

function serializeInvestigation(inv) {
  return {
    id: inv.id,
    title: inv.title,
    conversationId: inv.conversationId || null,
    context: inv.context || null,
    turns: inv.turns.slice(-MAX_TURNS_PERSISTED),
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
  };
}

function saveStore() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        v: 1,
        activeId: state.activeId,
        investigations: state.investigations
          .slice(0, MAX_INVESTIGATIONS)
          .map(serializeInvestigation),
      }),
    );
  } catch {
    /* quota exceeded or storage disabled — the UI keeps working in-memory */
  }
}

// ---------------------------------------------------------------------------
// Derived views over an investigation's REAL activity (no fabrication)
// ---------------------------------------------------------------------------

function allActivity(inv) {
  const out = [];
  for (const t of inv ? inv.turns : []) {
    if (t.role === "assistant" && Array.isArray(t.toolActivity)) {
      for (const a of t.toolActivity) out.push(a);
    }
  }
  return out;
}

function countChecks(inv) {
  return allActivity(inv).length;
}

function distinctTools(activity) {
  const map = new Map();
  for (const a of activity) {
    const name = (a && a.tool) || "tool";
    map.set(name, (map.get(name) || 0) + 1);
  }
  return [...map.entries()].map(([name, count]) => ({ name, count }));
}

// ---------------------------------------------------------------------------
// Rail — recent investigations
// ---------------------------------------------------------------------------

function renderInvestigationList() {
  els.investigationList.textContent = "";
  const items = state.investigations;
  els.investigationEmpty.hidden = items.length > 0;

  for (const inv of items) {
    const li = el("li");
    const btn = el("button", "invlist__item");
    btn.type = "button";
    btn.setAttribute("aria-current", String(inv.id === state.activeId));
    btn.appendChild(el("span", "invlist__dot"));
    btn.appendChild(el("span", "invlist__title", inv.title));
    btn.addEventListener("click", () => selectInvestigation(inv.id));
    li.appendChild(btn);
    els.investigationList.appendChild(li);
  }
}

function selectInvestigation(id) {
  if (state.pending) return; // never switch threads mid-investigation
  if (id !== state.activeId) {
    state.activeId = id;
    saveStore();
    renderActiveInvestigation();
    renderInvestigationList();
    renderInspector();
    updateWorkspaceTitle();
  }
  closeRailDrawer();
}

function startNewInvestigation() {
  if (state.pending) return;
  // No empty rows: the next message creates the thread. Just reset to a draft.
  state.activeId = null;
  saveStore();
  renderActiveInvestigation();
  renderInvestigationList();
  renderInspector();
  updateWorkspaceTitle();
  closeRailDrawer();
  els.input.focus();
}

// ---------------------------------------------------------------------------
// Topbar title
// ---------------------------------------------------------------------------

function subtitleFor(inv) {
  const ctx = inv.context || {};
  const bits = [];
  if (ctx.service) bits.push(ctx.service);
  if (ctx.activeIncidentId) bits.push(ctx.activeIncidentId);
  if (bits.length) return bits.join(" · ");
  const checks = countChecks(inv);
  if (checks) return `${checks} ${checks === 1 ? "check" : "checks"} run`;
  return "Evidence-first incident investigation";
}

function updateWorkspaceTitle() {
  const inv = activeInvestigation();
  if (inv && inv.turns.length > 0) {
    els.workspaceTitle.textContent = inv.title;
    els.workspaceSub.textContent = subtitleFor(inv);
  } else {
    els.workspaceTitle.textContent = "New investigation";
    els.workspaceSub.textContent = "Evidence-first incident investigation";
  }
}

// ---------------------------------------------------------------------------
// Inspector — real, derived investigation context
// ---------------------------------------------------------------------------

function kvRow(dl, key, value, opts = {}) {
  dl.appendChild(el("dt", "insp-kv__key", key));
  let cls = "insp-kv__value";
  if (opts.mono) cls += " insp-kv__value--mono";
  if (opts.accent) cls += " insp-kv__value--accent";
  dl.appendChild(el("dd", cls, value));
}

function metricTile(num, label, isError) {
  const m = el("div", "insp-metric");
  m.appendChild(el("div", "insp-metric__num" + (isError ? " insp-metric__num--error" : ""), num));
  m.appendChild(el("div", "insp-metric__label", label));
  return m;
}

function inspNote(iconName, text, caution) {
  const p = el("p", "insp-note" + (caution ? " insp-note--caution" : ""));
  const ic = el("span", "insp-note__icon");
  ic.appendChild(icon(iconName, 14));
  p.appendChild(ic);
  p.appendChild(el("span", null, text));
  return p;
}

/**
 * The "reading the evidence" section: a standing, honest reminder that DupTrace
 * reports correlation/evidence and does not assert causation, plus any REAL
 * causality-not-confirmed caveats found in the data (never invented).
 */
function methodologySection(activity) {
  const sec = el("div", "insp-section");
  sec.appendChild(el("p", "insp-section__title", "Reading the evidence"));
  sec.appendChild(
    inspNote(
      "info",
      "DupTrace reports correlations and the evidence behind them. Correlation does not establish causation.",
      false,
    ),
  );
  const unconfirmed = (activity || []).some((a) => {
    const sc = a && a.result && a.result.structuredContent;
    return sc && sc.causalityConfirmed === false;
  });
  if (unconfirmed) {
    sec.appendChild(
      inspNote(
        "alert",
        "At least one correlation here is not confirmed as causal by the available evidence.",
        true,
      ),
    );
  }
  return sec;
}

function renderInspector() {
  const body = els.inspectorBody;
  body.textContent = "";
  const inv = activeInvestigation();

  if (!inv || inv.turns.length === 0) {
    body.appendChild(
      el(
        "p",
        "insp-empty",
        "Investigation context appears here once you ask a question — the incident and service in focus, the checks DupTrace ran, and the evidence it gathered.",
      ),
    );
    body.appendChild(methodologySection([]));
    return;
  }

  const activity = allActivity(inv);
  const ctx = inv.context || {};

  // In focus — incident + service from the validated follow-up context.
  const focus = el("div", "insp-section");
  focus.appendChild(el("p", "insp-section__title", "In focus"));
  const kv = el("dl", "insp-kv");
  kvRow(kv, "Incident", ctx.activeIncidentId || "—", {
    mono: !!ctx.activeIncidentId,
    accent: !!ctx.activeIncidentId,
  });
  kvRow(kv, "Service", ctx.service || "—");
  focus.appendChild(kv);
  body.appendChild(focus);

  // Evidence gathered — counts computed from real activity.
  const errored = activity.filter((a) => a && a.isError === true).length;
  const successful = activity.length - errored;
  const ev = el("div", "insp-section");
  ev.appendChild(el("p", "insp-section__title", "Evidence gathered"));
  const metrics = el("div", "insp-metrics");
  metrics.appendChild(metricTile(String(activity.length), activity.length === 1 ? "check" : "checks"));
  metrics.appendChild(metricTile(String(successful), "successful"));
  metrics.appendChild(metricTile(String(errored), errored === 1 ? "error" : "errors", errored > 0));
  ev.appendChild(metrics);
  // Honest framing: these are reproducible counts of real checks, not invented
  // marketing statistics.
  ev.appendChild(
    el("p", "insp-caption", "Counts reflect the checks actually run in this investigation."),
  );
  body.appendChild(ev);

  // Tools used — distinct tool names, provenance in mono.
  const tools = distinctTools(activity);
  if (tools.length > 0) {
    const ts = el("div", "insp-section");
    ts.appendChild(el("p", "insp-section__title", "Tools used"));
    const list = el("div", "insp-tools");
    for (const t of tools) {
      const row = el("div", "insp-tool");
      row.appendChild(el("span", "insp-tool__name", humanizeTool(t.name)));
      row.appendChild(el("span", "insp-tool__id", t.count > 1 ? `${t.name} ×${t.count}` : t.name));
      list.appendChild(row);
    }
    ts.appendChild(list);
    body.appendChild(ts);
  }

  // Provenance — the server-issued conversation id.
  if (inv.conversationId) {
    const pv = el("div", "insp-section");
    pv.appendChild(el("p", "insp-section__title", "Provenance"));
    const kv2 = el("dl", "insp-kv");
    kvRow(kv2, "Conversation", inv.conversationId, { mono: true });
    pv.appendChild(kv2);
    body.appendChild(pv);
  }

  body.appendChild(methodologySection(activity));
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function renderEmptyState() {
  const wrap = el("section", "empty");

  const mark = el("div", "empty__mark");
  mark.appendChild(icon("search", 26));
  wrap.appendChild(mark);

  wrap.appendChild(el("p", "empty__eyebrow", "Evidence-first investigation"));
  wrap.appendChild(el("p", "empty__title", "Trace the signal. Find the cause."));
  wrap.appendChild(
    el(
      "p",
      "empty__hint",
      "Ask about service health, incidents, deployments, and operational events. DupTrace runs the checks and shows its evidence — IDs, timestamps, and the uncertainty behind each correlation.",
    ),
  );

  wrap.appendChild(el("p", "empty__try", "Try asking"));
  const examples = el("div", "empty__examples");
  for (const prompt of EXAMPLE_PROMPTS) {
    const b = el("button", "empty__example", prompt);
    b.type = "button";
    b.addEventListener("click", () => submit(prompt));
    examples.appendChild(b);
  }
  wrap.appendChild(examples);

  els.conversation.appendChild(wrap);
}

function clearEmptyState() {
  els.conversation.querySelector(".empty")?.remove();
}

// ---------------------------------------------------------------------------
// Message scaffolding
// ---------------------------------------------------------------------------

/**
 * @param {"user"|"assistant"} role
 * @param {string} label
 * @returns {{ block: HTMLElement, body: HTMLElement }}
 */
function messageBlock(role, label) {
  const block = el("article", `msg msg--${role}`);
  block.appendChild(el("div", "msg__role", label));
  const body = el("div", "msg__body");
  block.appendChild(body);
  return { block, body };
}

/** @param {string} content */
function renderUser(content) {
  const { block, body } = messageBlock("user", "You");
  body.appendChild(el("p", "answer__text", content));
  els.conversation.appendChild(block);
  scrollToEnd();
}

// ---------------------------------------------------------------------------
// Investigation panel
// ---------------------------------------------------------------------------

// "Observed evidence", not "activity": per the claim-vs-evidence separation,
// this panel holds independently observed tool records, distinct from the
// assistant's conclusion above it.
function investigationTitleNode() {
  const title = el("h3", "investigation__title");
  title.appendChild(icon("trace", 14));
  title.appendChild(el("span", null, "Observed evidence"));
  return title;
}

/**
 * @param {import("./api.js").ToolActivity[]} activity
 * @returns {HTMLElement}
 */
function renderInvestigation(activity) {
  const total = activity.length;
  const errored = activity.filter((a) => a.isError === true).length;
  const successful = total - errored;

  const section = el("section", "investigation");
  section.setAttribute("aria-label", "Observed evidence");

  const head = el("div", "investigation__head");
  head.appendChild(investigationTitleNode());

  const summary = el("p", "investigation__summary");
  summary.appendChild(
    el("span", "investigation__stat", `${total} ${total === 1 ? "check" : "checks"}`),
  );
  summary.appendChild(el("span", "investigation__stat", `${successful} successful`));
  if (errored > 0) {
    summary.appendChild(
      el("span", "investigation__stat investigation__stat--error", `${errored} returned error`),
    );
  }
  head.appendChild(summary);
  section.appendChild(head);

  const list = el("ol", "investigation__list");
  activity.forEach((entry, index) => list.appendChild(renderCheck(entry, index)));
  section.appendChild(list);

  return section;
}

/**
 * Classify one evidence row from its REAL returned fields — never invented:
 *   error       → the tool call returned an error
 *   empty       → no result, or nothing substantive to show
 *   confirmed   → data explicitly carries causalityConfirmed === true
 *   correlation → data explicitly carries causalityConfirmed === false
 *   observed    → a directly returned measurement/record (the default)
 * This keeps the four honest tiers distinct — observed fact vs. correlation vs.
 * (dis)confirmed cause vs. unknown — so timing alignment is never silently
 * presented as proven causation.
 * @param {import("./api.js").ToolActivity} entry
 * @returns {"error"|"empty"|"confirmed"|"correlation"|"observed"}
 */
function classifyEvidence(entry) {
  if (entry.isError === true) return "error";
  if (entry.result === undefined || resultIsEmpty(entry.result)) return "empty";
  const sc = /** @type {any} */ (entry.result)?.structuredContent;
  if (sc && typeof sc === "object" && !Array.isArray(sc)) {
    if (sc.causalityConfirmed === true) return "confirmed";
    if (sc.causalityConfirmed === false) return "correlation";
  }
  return "observed";
}

// Visible tag per classification. "observed" is the default and carries no tag —
// the "Observed evidence" panel header already frames it.
const EVIDENCE_TAG = {
  error: "Error",
  empty: "No data",
  confirmed: "Confirmed",
  correlation: "Correlation",
};

const SR_STATUS = {
  error: "step returned an error:",
  empty: "step returned no data:",
  confirmed: "step confirmed by evidence:",
  correlation: "step observed a correlation, not confirmed as causal:",
  observed: "step observed:",
};

/**
 * @param {import("./api.js").ToolActivity} entry
 * @param {number} index
 * @returns {HTMLElement}
 */
function renderCheck(entry, index) {
  const item = el("li", "check");
  const isError = entry.isError === true;
  // Classify from real returned fields (observed/correlation/confirmed/empty/error).
  const kind = classifyEvidence(entry);

  const details = el("details", "check__details");
  const summary = el("summary", "check__summary");

  // The step node on the trace spine: the real step number when the API gave
  // one, otherwise a plain node dot (never a fabricated sequence).
  const hasStep = Number.isFinite(entry.step);
  const node = el("span", "check__node");
  if (hasStep) {
    node.textContent = String(entry.step).padStart(2, "0");
  } else {
    node.classList.add("check__node--dot");
  }
  if (kind === "error") node.classList.add("check__node--error");
  else if (kind === "correlation") node.classList.add("check__node--correlation");
  summary.appendChild(node);

  // Status for assistive tech; the visual state is the node + the classification tag.
  summary.appendChild(srOnly(SR_STATUS[kind] || SR_STATUS.observed));

  const labelWrap = el("span", "check__labels");
  labelWrap.appendChild(el("span", "check__label", humanizeTool(entry.tool)));
  labelWrap.appendChild(el("span", "check__tool", entry.tool || "tool"));
  summary.appendChild(labelWrap);

  // Classification tag: text + colour together, never colour alone.
  if (EVIDENCE_TAG[kind]) {
    summary.appendChild(el("span", `check__tag check__tag--${kind}`, EVIDENCE_TAG[kind]));
  }

  const context = contextValues(entry);
  if (context.length > 0) {
    const chips = el("span", "check__context");
    for (const value of context) chips.appendChild(el("span", "chip", value));
    summary.appendChild(chips);
  }

  const chevron = el("span", "check__chevron");
  chevron.appendChild(icon("chevron", 15));
  summary.appendChild(chevron);

  details.appendChild(summary);
  details.appendChild(renderCheckBody(entry, isError));
  item.appendChild(details);
  return item;
}

/**
 * @param {import("./api.js").ToolActivity} entry
 * @param {boolean} isError
 * @returns {HTMLElement}
 */
function renderCheckBody(entry, isError) {
  const body = el("div", "check__body");

  // Arguments
  const argsSection = el("div", "check__section");
  argsSection.appendChild(el("div", "check__section-title", "Arguments"));
  const hasArgs = entry.arguments && Object.keys(entry.arguments).length > 0;
  if (hasArgs) {
    argsSection.appendChild(el("pre", "check__pre", stringifySafe(entry.arguments)));
  } else {
    argsSection.appendChild(el("p", "check__none", "No arguments"));
  }
  body.appendChild(argsSection);

  // Result
  const resultSection = el("div", "check__section");
  const resultTitle = el("div", "check__section-title", "Result");
  if (isError) {
    // Neutral wording: an application-level error result is not a system crash.
    resultTitle.appendChild(el("span", "check__flag", "Check returned an error"));
  }
  resultSection.appendChild(resultTitle);

  if (entry.result === undefined) {
    resultSection.appendChild(el("p", "check__none", "No result returned"));
  } else {
    // Readable summary: the preview line, then the real evidence fields (IDs,
    // statuses, confidences, timestamps) drawn straight from structuredContent.
    const preview = previewOf(entry.result);
    if (preview) resultSection.appendChild(el("p", "check__preview", preview));

    const structured = /** @type {any} */ (entry.result)?.structuredContent;
    const { facts, notes } = structuredFacts(structured);
    if (facts.length > 0) {
      const list = el("dl", "facts");
      for (const [key, value] of facts) {
        list.appendChild(el("dt", "fact__key", labelFor(key)));
        list.appendChild(el("dd", "fact__value", value));
      }
      resultSection.appendChild(list);
    }
    for (const note of notes) {
      resultSection.appendChild(el("p", "check__note", note));
    }

    // Raw JSON only when there is actually something to expand — never an empty
    // disclosure. Full result kept out of the initial view and truncated so an
    // enormous payload cannot blow out the layout.
    if (!resultIsEmpty(entry.result)) {
      const raw = el("details", "raw");
      raw.appendChild(el("summary", "raw__summary", "Raw result"));
      const serialized = stringifySafe(entry.result);
      const pre = el("pre", "raw__pre", truncate(serialized, RAW_RESULT_LIMIT));
      if (serialized.length > RAW_RESULT_LIMIT) {
        pre.appendChild(el("span", "raw__truncated", "\n… truncated"));
      }
      raw.appendChild(pre);
      resultSection.appendChild(raw);
    }
  }
  body.appendChild(resultSection);

  return body;
}

// ---------------------------------------------------------------------------
// Assistant turn (answer → investigation → follow-ups)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Markdown rendering (assistant answers only)
//
// Assistant content is Markdown. It is UNTRUSTED model output, so it is parsed
// into a plain AST by ./markdown.js (no HTML) and turned into DOM nodes here using
// textContent / createTextNode exclusively — never innerHTML. Raw HTML in the
// source therefore shows as literal text, link schemes are allowlisted, and the
// renderer is total so partial/streamed content can't throw or break the layout.
// ---------------------------------------------------------------------------

/** Render inline AST nodes into `parent` (text strictly via text nodes). */
function renderInline(parent, nodes) {
  for (const node of nodes || []) {
    if (!node) continue;
    switch (node.type) {
      case "text":
        parent.appendChild(document.createTextNode(node.value));
        break;
      case "br":
        parent.appendChild(document.createElement("br"));
        break;
      case "strong":
        renderInline(parent.appendChild(el("strong")), node.children);
        break;
      case "em":
        renderInline(parent.appendChild(el("em")), node.children);
        break;
      case "code":
        parent.appendChild(el("code", "md-code", node.value));
        break;
      case "link": {
        // sanitizeHref already allowlisted the scheme; a rejected href is null, so
        // the link degrades to plain text rather than becoming a live anchor.
        if (node.href) {
          const a = el("a");
          a.setAttribute("href", node.href);
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer nofollow");
          renderInline(a, node.children);
          parent.appendChild(a);
        } else {
          renderInline(parent, node.children);
        }
        break;
      }
      default:
        break;
    }
  }
}

/** Render a parsed Markdown table into a horizontally-scrollable wrapper. */
function renderMarkdownTable(parent, block) {
  const wrap = el("div", "md-table-wrap");
  const table = el("table", "md-table");
  const cols = block.header.length;

  const thead = el("thead");
  const htr = el("tr");
  block.header.forEach((cell, c) => {
    const th = el("th");
    if (block.align[c]) th.style.textAlign = block.align[c];
    renderInline(th, cell);
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const row of block.rows) {
    const tr = el("tr");
    for (let c = 0; c < cols; c += 1) {
      const td = el("td");
      if (block.align[c]) td.style.textAlign = block.align[c];
      renderInline(td, row[c] || []); // pad short rows, ignore extra cells
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  parent.appendChild(wrap);
}

/** Render block AST nodes into `parent`. */
function renderMarkdownBlocks(parent, blocks) {
  for (const block of blocks || []) {
    switch (block.type) {
      case "heading": {
        const h = el(`h${block.level}`);
        renderInline(h, block.inline);
        parent.appendChild(h);
        break;
      }
      case "paragraph": {
        const p = el("p", "md-p");
        renderInline(p, block.inline);
        parent.appendChild(p);
        break;
      }
      case "list": {
        const list = el(block.ordered ? "ol" : "ul", "md-list");
        for (const item of block.items) {
          renderInline(list.appendChild(el("li")), item);
        }
        parent.appendChild(list);
        break;
      }
      case "code": {
        const pre = el("pre", "md-pre");
        const code = el("code", "md-code", block.text);
        if (block.lang) code.dataset.lang = block.lang;
        pre.appendChild(code);
        parent.appendChild(pre);
        break;
      }
      case "table":
        renderMarkdownTable(parent, block);
        break;
      default:
        break;
    }
  }
}

/**
 * Render the assistant conclusion into a container. The content is Markdown and is
 * rendered as formatted DOM (headings, lists, tables, code, bold/italic, links) —
 * never as raw HTML. Empty content shows a neutral placeholder.
 * @param {HTMLElement} answerEl
 * @param {string} content
 */
function renderAnswerInto(answerEl, content) {
  const text = typeof content === "string" ? content : "";
  if (text.trim().length === 0) {
    answerEl.appendChild(
      el("p", "answer__text answer__text--muted", "DupTrace returned no answer text."),
    );
    return;
  }
  const md = el("div", "answer__md");
  renderMarkdownBlocks(md, parseMarkdown(text));
  answerEl.appendChild(md);
}

/**
 * Render a whole assistant turn in one shot (answer → investigation → follow-ups).
 * Used for the non-streaming fallback and any turn that produced no tool activity.
 * @param {{ content: string, toolActivity: import("./api.js").ToolActivity[] }} answer
 */
function renderAssistant({ content, toolActivity }) {
  const { block, body } = messageBlock("assistant", "DupTrace");

  const activity = Array.isArray(toolActivity) ? toolActivity : [];

  // 1) The assistant conclusion, verbatim and prominent. Never rewritten. When
  // the turn is backed by evidence, it is explicitly labelled "Conclusion" to
  // keep the claim visibly distinct from the observed evidence below it.
  const answer = el("div", "answer");
  // Label the conclusion only when evidence backs it AND there is actual answer
  // text — never "Conclusion" over an empty/placeholder answer.
  if (activity.length > 0 && typeof content === "string" && content.trim()) {
    answer.appendChild(el("p", "answer__eyebrow", "Conclusion"));
  }
  renderAnswerInto(answer, content);
  body.appendChild(answer);

  // 2) The evidence trail — only when an investigation actually ran.
  if (activity.length > 0) {
    body.appendChild(el("hr", "turn-divider"));
    body.appendChild(renderInvestigation(activity));
    // 3) Lightweight next-step shortcuts (ordinary /api/chat messages).
    body.appendChild(renderFollowUps());
  }

  els.conversation.appendChild(block);
  scrollToEnd();
}

/**
 * A single assistant turn rendered progressively from the SSE stream. It builds
 * the SAME DOM renderAssistant produces, but incrementally: tool-activity rows
 * are appended as they arrive, and the answer + follow-ups are placed when the
 * final event lands. Nothing here invents data.
 * @returns {{
 *   addActivity: (entry: import("./api.js").ToolActivity) => void,
 *   finish: (content: string) => void,
 *   hasBlock: () => boolean
 * }}
 */
function createStreamingTurn() {
  let block = null;
  let body = null;
  let answerEl = null;
  let listEl = null;
  let summaryEl = null;
  let count = 0;
  let errored = 0;

  function ensureBlock() {
    if (block) return;
    const made = messageBlock("assistant", "DupTrace");
    block = made.block;
    body = made.body;
    // Reserve the answer slot at the top so the final layout matches
    // renderAssistant: answer → divider → investigation → follow-ups.
    answerEl = el("div", "answer");
    body.appendChild(answerEl);
    els.conversation.appendChild(block);
  }

  function updateSummary() {
    if (!summaryEl) return;
    const successful = count - errored;
    summaryEl.textContent = "";
    summaryEl.appendChild(
      el("span", "investigation__stat", `${count} ${count === 1 ? "check" : "checks"}`),
    );
    summaryEl.appendChild(el("span", "investigation__stat", `${successful} successful`));
    if (errored > 0) {
      summaryEl.appendChild(
        el("span", "investigation__stat investigation__stat--error", `${errored} returned error`),
      );
    }
  }

  function ensureInvestigation() {
    ensureBlock();
    if (listEl) return;
    body.appendChild(el("hr", "turn-divider"));
    const section = el("section", "investigation");
    section.setAttribute("aria-label", "Observed evidence");
    const head = el("div", "investigation__head");
    head.appendChild(investigationTitleNode());
    summaryEl = el("p", "investigation__summary");
    head.appendChild(summaryEl);
    section.appendChild(head);
    listEl = el("ol", "investigation__list");
    section.appendChild(listEl);
    body.appendChild(section);
  }

  return {
    addActivity(entry) {
      ensureInvestigation();
      listEl.appendChild(renderCheck(entry, count));
      count += 1;
      if (entry && entry.isError === true) errored += 1;
      updateSummary();
      scrollToEnd();
    },
    finish(content) {
      ensureBlock();
      // Match renderAssistant: label the conclusion only when evidence backs it
      // and there is actual answer text.
      if (count > 0 && typeof content === "string" && content.trim()) {
        answerEl.appendChild(el("p", "answer__eyebrow", "Conclusion"));
      }
      renderAnswerInto(answerEl, content);
      // Follow-ups only when an investigation actually ran (parity with renderAssistant).
      if (count > 0) body.appendChild(renderFollowUps());
      scrollToEnd();
    },
    hasBlock() {
      return block !== null;
    },
  };
}

function renderFollowUps() {
  const wrap = el("div", "followups");
  wrap.appendChild(el("span", "followups__label", "Follow up"));
  const row = el("div", "followups__row");
  for (const prompt of FOLLOW_UPS) {
    const chip = el("button", "followup", prompt);
    chip.type = "button";
    chip.addEventListener("click", () => submit(prompt));
    row.appendChild(chip);
  }
  wrap.appendChild(row);
  return wrap;
}

// ---------------------------------------------------------------------------
// Loading + error
// ---------------------------------------------------------------------------

/** @returns {HTMLElement} the loading node, so the caller can remove it. */
function showLoading() {
  const { block, body } = messageBlock("assistant", "DupTrace");
  block.classList.add("msg--loading");

  const loader = el("div", "loading");
  const line = el("div", "loading__line");
  line.appendChild(el("span", "loading__text", "Investigating"));
  const dots = el("span", "loading__dots");
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i += 1) dots.appendChild(el("span", "loading__dot"));
  line.appendChild(dots);
  loader.appendChild(line);
  // Shown until the first real tool result streams in, then replaced by the live
  // investigation panel. The sub-line stays generic — we never invent progress.
  loader.appendChild(el("p", "loading__sub", "Checking operational signals"));
  body.appendChild(loader);

  els.conversation.appendChild(block);
  scrollToEnd();
  return block;
}

/**
 * Map a normalised APIError to safe, user-facing copy. Internal server detail is
 * never shown; the mandated network/503 strings are used exactly.
 * @param {import("./api.js").APIError} failure
 * @returns {{ title: string, detail: string }}
 */
function describeFailure(failure) {
  if (failure.kind === "network") {
    return {
      title: "Unable to reach DupTrace.",
      detail: "Check that the server is running and try again.",
    };
  }
  if (failure.status === 400) {
    return {
      title: "That request couldn't be processed.",
      detail: failure.message || "Please rephrase your question and try again.",
    };
  }
  if (failure.status === 503) {
    return {
      title: "The investigation provider is currently unavailable.",
      detail: "Please try again in a moment.",
    };
  }
  return {
    title: "DupTrace hit an internal error while investigating.",
    detail: "Please try again.",
  };
}

/**
 * A stable, user-safe error code for the failure state (never internal detail).
 * The server only ever returns a small enum of codes; network/HTTP fallbacks are
 * derived locally.
 * @param {import("./api.js").APIError} failure
 * @returns {string|null}
 */
function errorCode(failure) {
  if (failure && typeof failure.code === "string" && failure.code) return failure.code;
  if (failure && failure.kind === "network") return "NETWORK";
  if (failure && Number.isFinite(failure.status)) return "HTTP " + failure.status;
  return null;
}

/** A Retry control that removes the given block and re-runs the same turn. */
function retryButton(invId, retryMessage, block) {
  const retry = el("button", "error__retry");
  retry.type = "button";
  retry.appendChild(icon("refresh", 15));
  retry.appendChild(el("span", null, "Retry"));
  retry.addEventListener("click", () => {
    block.remove();
    // Re-run the request for the same (already-recorded) user turn — this does
    // NOT append a duplicate user message to the thread.
    runTurn(invId, retryMessage);
  });
  return retry;
}

/**
 * Full error state — the turn produced no visible evidence before failing.
 * Shows safe copy plus a stable machine-readable code (honest, developer-facing),
 * never internal server detail.
 * @param {import("./api.js").APIError} failure
 * @param {string} invId
 * @param {string} retryMessage
 */
function renderError(failure, invId, retryMessage) {
  const { title, detail } = describeFailure(failure);
  const { block, body } = messageBlock("assistant", "DupTrace");
  block.classList.add("msg--error");

  const wrap = el("div", "error");
  const head = el("div", "state__head");
  head.appendChild(el("p", "error__title", title));
  const code = errorCode(failure);
  if (code) head.appendChild(el("span", "state__code", code));
  wrap.appendChild(head);
  if (detail) wrap.appendChild(el("p", "error__detail", detail));

  wrap.appendChild(retryButton(invId, retryMessage, block));
  body.appendChild(wrap);

  els.conversation.appendChild(block);
  scrollToEnd();
}

/**
 * Partial-result state — real evidence streamed in before the turn was
 * interrupted. The observed checks above stay visible; this notice makes the
 * incompleteness explicit (no conclusion was reached) rather than hiding it.
 * @param {import("./api.js").APIError} failure
 * @param {string} invId
 * @param {string} retryMessage
 */
function renderPartial(failure, invId, retryMessage) {
  const { block, body } = messageBlock("assistant", "DupTrace");
  block.classList.add("msg--partial");

  const wrap = el("div", "partial");
  const head = el("div", "state__head");
  head.appendChild(el("p", "partial__title", "Partial result"));
  const code = errorCode(failure);
  if (code) head.appendChild(el("span", "state__code", code));
  wrap.appendChild(head);
  wrap.appendChild(
    el(
      "p",
      "partial__detail",
      failure.kind === "network"
        ? "The connection dropped mid-investigation. The evidence above is what DupTrace gathered before the interruption — it is incomplete, and no conclusion was reached."
        : "The investigation stopped before reaching a conclusion. The evidence above is incomplete.",
    ),
  );
  wrap.appendChild(retryButton(invId, retryMessage, block));
  body.appendChild(wrap);

  els.conversation.appendChild(block);
  scrollToEnd();
}

// ---------------------------------------------------------------------------
// Composer behaviour
// ---------------------------------------------------------------------------

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, INPUT_MAX_HEIGHT)}px`;
}

/**
 * Reflect the real send affordance: enabled only when there is text to send and
 * no investigation is already running, and marked busy (spinner) during a run.
 */
function updateSendState() {
  const hasText = els.input.value.trim().length > 0;
  els.send.disabled = state.pending || !hasText;
  els.send.setAttribute("aria-busy", String(state.pending));
}

/** @param {"ready"|"busy"|"error"|"offline"} stateName @param {string} label */
function setStatus(stateName, label) {
  els.statusDot.dataset.state = stateName;
  els.statusLabel.textContent = label;
}

/** @param {boolean} pending */
function setPending(pending) {
  state.pending = pending;
  els.input.setAttribute("aria-busy", String(pending));
  updateSendState();
  if (pending) setStatus("busy", "Investigating…");
}

/**
 * Append one new user turn to the active investigation and start the request.
 * Creates the investigation on the first message of a fresh thread.
 * @param {string} rawText
 */
function submit(rawText) {
  const message = (rawText ?? "").trim();
  if (!message || state.pending) return;

  let inv = activeInvestigation();
  const freshThread = !inv;
  if (!inv) inv = createInvestigation(message);

  if (freshThread) clearEmptyState();

  inv.turns.push({ role: "user", content: message });
  renderUser(message);
  renderInvestigationList();
  updateWorkspaceTitle();
  saveStore();

  els.input.value = "";
  autosize();
  updateSendState();

  runTurn(inv.id, message);
}

/**
 * Send one turn to the server and render it progressively from the SSE stream.
 * Reused for the initial send AND for retry (so retry does not re-record the
 * user message). The streaming → one-shot-fallback → render flow is unchanged
 * from the previous build; only the per-thread state wiring is new.
 * @param {string} invId
 * @param {string} message
 */
async function runTurn(invId, message) {
  if (state.pending) return;
  const inv = state.investigations.find((i) => i.id === invId);
  if (!inv) return;

  setPending(true);
  const loading = showLoading();
  let loaderCleared = false;
  const clearLoader = () => {
    if (loaderCleared) return;
    loading.remove();
    loaderCleared = true;
  };

  const turn = createStreamingTurn();

  // Live progress: the first real tool result replaces the loader with the live
  // investigation panel; later results append rows. The answer and the single
  // authoritative result come from the resolved value below.
  const result = await streamChat({
    message,
    conversationId: inv.conversationId,
    context: inv.context,
    onEvent: (event) => {
      if (event.type === "activity") {
        clearLoader();
        turn.addActivity(event.activity);
      }
    },
  });

  clearLoader();

  let outcome = result;

  // A transport failure that produced no visible turn falls back once to the
  // buffered JSON endpoint, so a disrupted stream still yields an answer (and
  // sendChat stays a live, exercised path). A provider/validation failure (which
  // carries a code) or a partially streamed turn is shown as-is.
  if (!result.ok && result.kind === "network" && !turn.hasBlock()) {
    outcome = await sendChat({
      message,
      conversationId: inv.conversationId,
      context: inv.context,
    });
  }

  if (outcome.ok) {
    // Carry whatever conversationId the server issued back on the next request.
    inv.conversationId = outcome.conversationId ?? inv.conversationId;
    // Remember the incident/service this turn resolved (from verified tool
    // results) so the next follow-up can reference it. A turn that resolved
    // nothing new keeps the prior context.
    inv.context = deriveContext(outcome.toolActivity) || inv.context;
    const activity = Array.isArray(outcome.toolActivity) ? outcome.toolActivity : [];
    inv.turns.push({ role: "assistant", content: outcome.message.content, toolActivity: activity });
    inv.updatedAt = Date.now();

    if (turn.hasBlock()) {
      turn.finish(outcome.message.content);
    } else {
      renderAssistant({ content: outcome.message.content, toolActivity: activity });
    }
    setStatus("ready", "Ready");
    saveStore();
    renderInspector();
    updateWorkspaceTitle();
  } else if (turn.hasBlock()) {
    // Evidence streamed before the failure: show it as a partial result attached
    // to the turn, not a full-screen error. The observed checks stay visible.
    renderPartial(outcome, invId, message);
    setStatus(
      outcome.kind === "network" ? "offline" : "error",
      outcome.kind === "network" ? "Offline" : "Error",
    );
  } else {
    renderError(outcome, invId, message);
    setStatus(
      outcome.kind === "network" ? "offline" : "error",
      outcome.kind === "network" ? "Offline" : "Error",
    );
  }

  setPending(false);
  els.input.focus();
}

// ---------------------------------------------------------------------------
// Active-thread rendering
// ---------------------------------------------------------------------------

function renderActiveInvestigation() {
  // Bulk render without flooding the live region (switching/restoring a thread).
  els.conversation.setAttribute("aria-live", "off");
  els.conversation.textContent = "";
  const inv = activeInvestigation();
  if (!inv || inv.turns.length === 0) {
    renderEmptyState();
  } else {
    for (const turn of inv.turns) {
      if (turn.role === "user") {
        renderUser(turn.content);
      } else if (turn.role === "assistant") {
        renderAssistant({ content: turn.content, toolActivity: turn.toolActivity || [] });
      }
    }
  }
  requestAnimationFrame(() => els.conversation.setAttribute("aria-live", "polite"));
}

// ---------------------------------------------------------------------------
// Shell — rail / inspector drawers (responsive) + scrim + keyboard
// ---------------------------------------------------------------------------

function isWide() {
  try {
    return window.matchMedia("(min-width: 1120px)").matches;
  } catch {
    return true;
  }
}

function railIsOpen() {
  return els.app.classList.contains("app--rail-open");
}

function inspectorIsOpen() {
  return els.app.classList.contains("app--inspector-open");
}

function setRailOpen(open) {
  els.app.classList.toggle("app--rail-open", open);
  els.menuToggle.setAttribute("aria-expanded", String(open));
  if (open) els.railClose.focus();
  else els.menuToggle.focus();
}

function closeRailDrawer() {
  if (railIsOpen()) setRailOpen(false);
}

function setInspectorOpen(open) {
  // Overlay mode (below 1120px).
  els.app.classList.toggle("app--inspector-open", open);
  els.inspectorToggle.setAttribute("aria-expanded", String(open));
  // Move focus with the drawer: into it on open, back to its trigger on close.
  if (open) els.inspectorClose.focus();
  else els.inspectorToggle.focus();
}

function setInspectorCollapsed(collapsed) {
  // Docked mode (1120px and up).
  els.app.classList.toggle("app--inspector-collapsed", collapsed);
  els.inspectorToggle.setAttribute("aria-expanded", String(!collapsed));
}

function toggleInspector() {
  if (isWide()) {
    setInspectorCollapsed(!els.app.classList.contains("app--inspector-collapsed"));
  } else {
    setInspectorOpen(!inspectorIsOpen());
  }
}

function closeInspectorDrawer() {
  if (inspectorIsOpen()) setInspectorOpen(false);
}

function closeDrawers() {
  closeRailDrawer();
  closeInspectorDrawer();
}

function syncInspectorToggleAria() {
  if (isWide()) {
    els.inspectorToggle.setAttribute(
      "aria-expanded",
      String(!els.app.classList.contains("app--inspector-collapsed")),
    );
    els.inspectorToggle.setAttribute("aria-label", "Toggle investigation context");
  } else {
    els.inspectorToggle.setAttribute("aria-expanded", String(inspectorIsOpen()));
    els.inspectorToggle.setAttribute("aria-label", "Show investigation context");
  }
}

function handleBreakpointChange() {
  // Leaving/entering the wide layout: drop overlay state so a drawer that was
  // open on a narrow screen doesn't linger as the layout changes.
  if (isWide()) {
    els.app.classList.remove("app--rail-open", "app--inspector-open");
  } else {
    els.app.classList.remove("app--inspector-collapsed");
  }
  syncInspectorToggleAria();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  mountStaticIcons();
  initTheme();
  loadStore();

  els.scrim.removeAttribute("hidden"); // visibility is CSS-driven from here

  // Rail + inspector controls.
  els.menuToggle.addEventListener("click", () => setRailOpen(!railIsOpen()));
  els.railClose.addEventListener("click", () => setRailOpen(false));
  els.inspectorToggle.addEventListener("click", toggleInspector);
  els.inspectorClose.addEventListener("click", () => {
    if (isWide()) {
      setInspectorCollapsed(true);
      els.inspectorToggle.focus(); // close button is now hidden — move focus out
    } else {
      setInspectorOpen(false);
    }
  });
  els.scrim.addEventListener("click", closeDrawers);
  els.newInvestigation.addEventListener("click", startNewInvestigation);
  els.themeToggle.addEventListener("click", toggleTheme);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (railIsOpen() || inspectorIsOpen())) {
      closeDrawers();
    }
  });

  // Keep layout state coherent across the responsive breakpoint.
  try {
    window
      .matchMedia("(min-width: 1120px)")
      .addEventListener("change", handleBreakpointChange);
  } catch {
    /* matchMedia change events unavailable — static layout still works */
  }
  syncInspectorToggleAria();

  // Composer.
  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(els.input.value);
  });
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      els.form.requestSubmit();
    }
  });
  els.input.addEventListener("input", () => {
    autosize();
    updateSendState();
  });

  // First paint.
  renderActiveInvestigation();
  renderInvestigationList();
  renderInspector();
  updateWorkspaceTitle();
  setStatus("ready", "Ready");
  updateSendState();
  els.input.focus();
}

init();
