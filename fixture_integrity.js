// fixture_integrity.js — pure, dependency-free fixture-integrity rules.
//
// Factored out of server.js so the startup validation can be unit-tested with
// synthetic fixtures (importing server.js would start the HTTP listener). Each
// rule throws a clear Error on the first inconsistency, matching server.js's
// existing fail-fast convention in assertEvidenceFixtureIntegrity().

/**
 * Every timeline entry that references an event (`eventId`) must point at a real
 * event AND carry that event's exact `occurredAt`. This catches drift like the
 * TL-2026-001-B / EVT-2026-0902 mismatch (timeline said 10:50, the event — and the
 * deployment's completedAt — said 10:44). Entries without an eventId are skipped.
 *
 * @param {Array<{id:string, timeline?: Array<{id:string, eventId:(string|null), timestamp:string}>}>} incidents
 * @param {Array<{id:string, occurredAt:string}>} events
 */
export const assertTimelineIntegrity = (incidents, events) => {
  const eventById = new Map(events.map((event) => [event.id, event]));

  for (const incident of incidents) {
    for (const entry of incident.timeline || []) {
      if (entry.eventId == null) continue;

      const event = eventById.get(entry.eventId);
      if (!event) {
        throw new Error(
          `Timeline entry ${entry.id} references an unknown event ${entry.eventId}`
        );
      }

      if (entry.timestamp !== event.occurredAt) {
        throw new Error(
          `Timeline entry ${entry.id} timestamp ${entry.timestamp} does not match ` +
            `event ${entry.eventId} occurredAt ${event.occurredAt}`
        );
      }
    }
  }
};
