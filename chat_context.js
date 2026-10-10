// chat_context.js — the explicit prior-turn context contract.
//
// A follow-up like "Show the evidence" carries no incident id, because the chat
// path is stateless (conversationId is echoed, never used to restore history).
// Rather than repurpose conversationId, the client sends a small, EXPLICIT
// structured context { activeIncidentId, service } derived from verified tool
// results. The server validates it against the real fixtures (a bad hint must
// never steer the agent), and the agent injects it as clearly-labelled
// prior-turn context — never as evidence, never as a substitute for tool calls.
//
// Pure and dependency-free so validation and injection are unit-testable without
// standing up the server. Shared by server.js (validate) and agent.js (inject).

const INCIDENT_ID_RE = /^INC-[0-9]{4}-[0-9]{3}$/;

/**
 * Keep only context values consistent with the existing fixture data; drop
 * anything malformed or unsupported (safely ignored, never trusted). Returns a
 * `{ activeIncidentId, service }` object with validated-or-null fields, or null
 * when nothing valid remains.
 *
 * @param {unknown} context
 * @param {{ incidentIds?: string[], services?: string[] }} fixtures
 * @returns {{ activeIncidentId: (string|null), service: (string|null) } | null}
 */
export const sanitizeChatContext = (context, { incidentIds = [], services = [] } = {}) => {
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;

  const idSet = new Set(incidentIds);
  const serviceSet = new Set(services);

  const rawId =
    typeof context.activeIncidentId === "string" ? context.activeIncidentId.trim() : "";
  const rawService = typeof context.service === "string" ? context.service.trim() : "";

  const activeIncidentId =
    INCIDENT_ID_RE.test(rawId) && idSet.has(rawId) ? rawId : null;
  const service = serviceSet.has(rawService) ? rawService : null;

  if (!activeIncidentId && !service) return null;
  return { activeIncidentId, service };
};

/**
 * Build the labelled prior-turn context message injected into the agent input.
 * It states plainly that it is context (not evidence), that the agent must still
 * call the real read-only MCP tools, and that the CURRENT request overrides it.
 * Returns a provider-neutral `{ role, content }` message, or null when there is
 * nothing valid to inject (so discovery behaviour is preserved).
 *
 * @param {{ activeIncidentId: (string|null), service: (string|null) } | null} context
 * @returns {{ role: "user", content: string } | null}
 */
export const buildContextMessage = (context) => {
  if (!context) return null;

  const subject = [];
  if (context.activeIncidentId) subject.push(`incident ${context.activeIncidentId}`);
  if (context.service) subject.push(`service ${context.service}`);
  if (subject.length === 0) return null;

  return {
    role: "user",
    content:
      `Prior-turn context (not evidence; the current request takes precedence): ` +
      `the active investigation concerns ${subject.join(", ")}. ` +
      `If the current request refers to it implicitly (for example "show the evidence"), ` +
      `call the appropriate read-only MCP tools for that incident ` +
      `(e.g. get_incident_evidence with its incidentId) instead of listing every active incident. ` +
      `If the current request names a different incident or service, follow the current request and ignore this context.`,
  };
};
