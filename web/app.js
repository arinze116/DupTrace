// app.js — DupTrace investigation experience (G2-D2).
//
// Pure DOM: no framework, no build step, no new dependencies. It renders the
// existing /api/chat response into a recognisable investigation surface — what
// you asked, what DupTrace checked, what each tool returned, and what the
// assistant concluded — without inventing anything the API did not return.
//
// Data-integrity rules enforced throughout:
//   • every label is derived from the actual tool name (no hard-coded sequence)
//   • every count is computed from the actual toolActivity array
//   • step numbers are shown only when the API provided them
//   • context chips show only values that exist in arguments / results
//   • the assistant answer is rendered verbatim from message.content
//   • all text reaches the page via textContent (never innerHTML) → XSS-safe
//   • the browser talks only to /api/chat — never to MCP directly
// The pure, DOM-free formatters behind these rules live in ./format.js so the
// same code is unit-tested directly (see _verify_format.mjs).

import { sendChat, streamChat } from "./api.js";
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

const EXAMPLE_PROMPT = "What's wrong with payments?";

// Generic follow-up shortcuts. They are ordinary user messages sent through
// /api/chat — never special frontend commands, never pre-answered. Shown only
// after a turn where an investigation actually ran.
const FOLLOW_UPS = [
  "What deployment is related?",
  "Show the evidence",
  "What happened before the incident?",
];

const INPUT_MAX_HEIGHT = 200;

/** In-memory only. Refresh resets it — no persistence by design. */
const state = {
  conversationId: /** @type {string|null} */ (null),
  pending: false,
  // Explicit follow-up context resolved from the previous turn's verified tool
  // results — { activeIncidentId, service } or null. Sent with the next request.
  context: /** @type {{ activeIncidentId: (string|null), service: (string|null) }|null} */ (null),
};

const els = {
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
 * @param {string} [className]
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

/**
 * @param {"ready"|"busy"|"error"|"offline"} stateName
 * @param {string} label
 */
function setStatus(stateName, label) {
  els.statusDot.dataset.state = stateName;
  els.statusLabel.textContent = label;
}

function scrollToEnd() {
  requestAnimationFrame(() => {
    els.conversation.scrollTop = els.conversation.scrollHeight;
  });
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function renderEmptyState() {
  const wrap = el("section", "empty");
  wrap.appendChild(el("p", "empty__title", "DupTrace"));
  wrap.appendChild(el("p", "empty__tagline", "Trace the signal. Find the cause."));
  wrap.appendChild(
    el(
      "p",
      "empty__hint",
      "Investigate service health, incidents, deployments, events, and operational evidence.",
    ),
  );

  wrap.appendChild(el("p", "empty__try", "Try"));
  const example = el("button", "empty__example", EXAMPLE_PROMPT);
  example.type = "button";
  example.addEventListener("click", () => submit(EXAMPLE_PROMPT));
  wrap.appendChild(example);

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

/**
 * @param {import("./api.js").ToolActivity[]} activity
 * @returns {HTMLElement}
 */
function renderInvestigation(activity) {
  const total = activity.length;
  const errored = activity.filter((a) => a.isError === true).length;
  const successful = total - errored;

  const section = el("section", "investigation");
  section.setAttribute("aria-label", "Investigation activity");

  const head = el("div", "investigation__head");
  head.appendChild(el("h3", "investigation__title", "Investigation activity"));

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
 * @param {import("./api.js").ToolActivity} entry
 * @param {number} index
 * @returns {HTMLElement}
 */
function renderCheck(entry, index) {
  const item = el("li", "check");
  const isError = entry.isError === true;

  const details = el("details", "check__details");
  const summary = el("summary", "check__summary");

  // Step number only when the API actually provided one (no fabrication).
  const stepText = Number.isFinite(entry.step)
    ? String(entry.step).padStart(2, "0")
    : "··";
  const step = el("span", "check__step", stepText);
  if (!Number.isFinite(entry.step)) step.classList.add("check__step--none");
  summary.appendChild(step);

  const status = el(
    "span",
    `check__status ${isError ? "check__status--error" : "check__status--ok"}`,
    isError ? "!" : "✓",
  );
  status.setAttribute("aria-hidden", "true");
  summary.appendChild(status);
  summary.appendChild(srOnly(isError ? "returned an error:" : "completed:"));

  const labelWrap = el("span", "check__labels");
  labelWrap.appendChild(el("span", "check__label", humanizeTool(entry.tool)));
  labelWrap.appendChild(el("span", "check__tool", entry.tool || "tool"));
  summary.appendChild(labelWrap);

  const context = contextValues(entry);
  if (context.length > 0) {
    const chips = el("span", "check__context");
    for (const value of context) chips.appendChild(el("span", "chip", value));
    summary.appendChild(chips);
  }

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

/**
 * Render the assistant conclusion into a container, verbatim. Never rewritten;
 * empty content shows a neutral placeholder. Shared by the one-shot and the
 * streaming paths so the answer reads identically either way.
 * @param {HTMLElement} answerEl
 * @param {string} content
 */
function renderAnswerInto(answerEl, content) {
  const text = typeof content === "string" ? content : "";
  if (text.trim().length > 0) {
    answerEl.appendChild(el("p", "answer__text", text));
  } else {
    answerEl.appendChild(
      el("p", "answer__text answer__text--muted", "DupTrace returned no answer text."),
    );
  }
}

/**
 * Render a whole assistant turn in one shot (answer → investigation → follow-ups).
 * Used for the non-streaming fallback and any turn that produced no tool activity.
 * @param {{ content: string, toolActivity: import("./api.js").ToolActivity[] }} answer
 */
function renderAssistant({ content, toolActivity }) {
  const { block, body } = messageBlock("assistant", "DupTrace");

  // 1) The assistant conclusion, verbatim and prominent. Never rewritten.
  const answer = el("div", "answer");
  renderAnswerInto(answer, content);
  body.appendChild(answer);

  const activity = Array.isArray(toolActivity) ? toolActivity : [];

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
 * are appended as they arrive (reusing renderCheck + the investigation panel
 * markup), and the answer + follow-ups are placed when the final event lands.
 * Nothing here invents data — every row comes from a real `activity` event, and
 * the summary counts are computed from what actually arrived.
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
        el(
          "span",
          "investigation__stat investigation__stat--error",
          `${errored} returned error`,
        ),
      );
    }
  }

  function ensureInvestigation() {
    ensureBlock();
    if (listEl) return;
    body.appendChild(el("hr", "turn-divider"));
    const section = el("section", "investigation");
    section.setAttribute("aria-label", "Investigation activity");
    const head = el("div", "investigation__head");
    head.appendChild(el("h3", "investigation__title", "Investigation activity"));
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
  // investigation panel. The sub-line stays generic — we never invent progress text.
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
 * @param {import("./api.js").APIError} failure
 * @param {string} retryMessage
 */
function renderError(failure, retryMessage) {
  const { title, detail } = describeFailure(failure);
  const { block, body } = messageBlock("assistant", "DupTrace");
  block.classList.add("msg--error");

  body.appendChild(el("p", "error__title", title));
  if (detail) body.appendChild(el("p", "error__detail", detail));

  const retry = el("button", "error__retry", "Retry");
  retry.type = "button";
  retry.addEventListener("click", () => {
    block.remove();
    submit(retryMessage);
  });
  body.appendChild(retry);

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
 * This mirrors submit()'s own guard — it never enables an action submit() would
 * reject, and adds no behaviour of its own.
 */
function updateSendState() {
  const hasText = els.input.value.trim().length > 0;
  els.send.disabled = state.pending || !hasText;
  els.send.setAttribute("aria-busy", String(state.pending));
}

/** @param {boolean} pending */
function setPending(pending) {
  state.pending = pending;
  els.input.setAttribute("aria-busy", String(pending));
  updateSendState();
  if (pending) setStatus("busy", "Investigating…");
}

/**
 * Send one turn and render it progressively from the SSE stream. Guards against
 * re-entry while a request is in flight. The state machine (conversationId,
 * pending, status) is identical to the one-shot path; only the rendering is now
 * incremental, driven by real `activity` events.
 * @param {string} rawText
 */
async function submit(rawText) {
  const message = (rawText ?? "").trim();
  if (!message || state.pending) return;

  clearEmptyState();
  renderUser(message);

  els.input.value = "";
  autosize();

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
  // authoritative result come from the resolved value below, so exactly one place
  // renders the conclusion.
  const result = await streamChat({
    message,
    conversationId: state.conversationId,
    context: state.context,
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
  // carries a code) or a partially streamed turn is shown as-is — a fallback would
  // only repeat the same failure.
  if (!result.ok && result.kind === "network" && !turn.hasBlock()) {
    outcome = await sendChat({
      message,
      conversationId: state.conversationId,
      context: state.context,
    });
  }

  if (outcome.ok) {
    // Carry whatever conversationId the server issued back on the next request.
    state.conversationId = outcome.conversationId ?? state.conversationId;
    // Remember the incident/service this turn resolved (from verified tool results)
    // so the next follow-up can reference it without a broad rediscovery. A turn
    // that resolved nothing new keeps the prior context.
    state.context = deriveContext(outcome.toolActivity) || state.context;
    if (turn.hasBlock()) {
      turn.finish(outcome.message.content);
    } else {
      renderAssistant({
        content: outcome.message.content,
        toolActivity: outcome.toolActivity,
      });
    }
    setStatus("ready", "Ready");
  } else {
    renderError(outcome, message);
    setStatus(
      outcome.kind === "network" ? "offline" : "error",
      outcome.kind === "network" ? "Offline" : "Error",
    );
  }

  setPending(false);
  els.input.focus();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  renderEmptyState();
  setStatus("ready", "Ready");

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(els.input.value);
  });

  // Enter sends; Shift+Enter inserts a newline.
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
  els.input.focus();
  updateSendState();
}

init();
