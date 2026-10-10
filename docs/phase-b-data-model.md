# DupTrace Phase B Data Model

## Scope

This document defines the Phase B design for incident intelligence. It is a
data-model and MCP-contract proposal only. It does not implement tools, add
runtime data, modify `server.js`, or introduce deployment and event records.

The design is intentionally deterministic, in-memory, small enough for a
hackathon, and compatible with the current services and health snapshots:

- `payments`
- `auth`
- `checkout`
- `notifications`

The intended domain shape is:

```text
Service
|-- Health
|-- Incidents
|-- Deployments
`-- Events
```

The intended investigation chain is:

```text
service -> incident -> deployment -> events -> evidence -> explanation -> action
```

Phase B initially introduces only incident data and the following future MCP
tools:

- `list_active_incidents`
- `get_incident`

Deployments, events, evidence, explanations, and actions remain future
concepts. Incident records may contain stable references to those future
records, but must not embed unrelated or duplicate mock objects.

## 1. Domain Model

### 1.1 Incident entity

An incident represents a bounded operational problem affecting one service.
It contains the current investigation state, a concise timeline, current
findings, and references to related records. The incident is the central
object that an agent can retrieve after discovering degraded service health.

The canonical shape is:

```json
{
  "id": "INC-2026-001",
  "service": "payments",
  "title": "Elevated payment authorization failures",
  "severity": "SEV-2",
  "status": "investigating",
  "createdAt": "2026-09-19T10:45:00Z",
  "updatedAt": "2026-09-19T11:05:00Z",
  "description": "Payment authorization failures and latency are elevated in the latest health window.",
  "timeline": [],
  "findings": [],
  "suspectedCause": null,
  "relatedDeploymentIds": [],
  "relatedEventIds": []
}
```

All timestamps use ISO 8601 UTC strings with a `Z` suffix. Dataset timestamps
are fixed fixture values, not timestamps generated at request time. This keeps
responses deterministic and makes the examples reproducible.

### 1.2 Top-level field definitions

| Field | Type | Purpose | Required | Mutable | Example |
| --- | --- | --- | --- | --- | --- |
| `id` | string matching `^INC-[0-9]{4}-[0-9]{3}$` | Stable incident identifier used by `get_incident` and future references. | Yes | No | `INC-2026-001` |
| `service` | enum: `payments`, `auth`, `checkout`, `notifications` | Identifies the affected service and joins the incident to health, deployments, and events. | Yes | No for the initial record | `payments` |
| `title` | string | Short human-readable incident summary suitable for an Alexa+ response. | Yes | Yes | `Elevated payment authorization failures` |
| `severity` | enum: `SEV-1`, `SEV-2`, `SEV-3`, `SEV-4` | Operational impact classification. | Yes | Yes, as impact is reassessed | `SEV-2` |
| `status` | enum: `investigating`, `mitigated`, `resolved` | Current incident lifecycle state. | Yes | Yes | `investigating` |
| `createdAt` | ISO 8601 UTC string | Time the incident was first recorded in the fixture. | Yes | No | `2026-09-19T10:45:00Z` |
| `updatedAt` | ISO 8601 UTC string | Time the incident record was last changed. | Yes | Yes | `2026-09-19T11:05:00Z` |
| `description` | string | Human-readable description of the observed impact and scope. | Yes | Yes | `Payment authorization failures and latency are elevated in the latest health window.` |
| `timeline` | array of `TimelineEntry` | Ordered incident-local history. Entries can point to future deployment and event records. | Yes; may be empty | Yes, append-only in normal use | See the timeline example below |
| `findings` | array of `Finding` | Current observations or conclusions produced during investigation. | Yes; may be empty | Yes; findings may be added or revised | See the finding example below |
| `suspectedCause` | `SuspectedCause` or `null` | Current leading causal hypothesis. `null` means no credible hypothesis exists yet. | Yes; nullable | Yes | `{"deploymentId":"DEP-2026-0142",...}` |
| `relatedDeploymentIds` | array of deployment ID strings | Stable references to deployments that may have affected the service. No deployment payload is embedded here. | Yes; may be empty | Yes, append-only unless a mistaken reference is corrected | `["DEP-2026-0142"]` |
| `relatedEventIds` | array of event ID strings | Stable references to service event records that support detection or investigation. No event payload is embedded here. | Yes; may be empty | Yes, append-only unless a mistaken reference is corrected | `["EVT-2026-0901", "EVT-2026-0902"]` |

`service`, `createdAt`, and `id` establish the identity of the original
incident and should not be changed after creation. `severity`, `status`,
`title`, `description`, findings, hypotheses, and references represent the
current investigation state and may change as the incident progresses.

`updatedAt` must be updated whenever a mutable incident field changes. In the
initial deterministic fixture, it is a fixed value in the source data rather
than a runtime clock value.

### 1.3 TimelineEntry

`timeline` is an incident-local view of important changes and observations. It
is not a replacement for the future Event entity. It provides an immediately
useful narrative while allowing each entry to point to a canonical event or
deployment record when those records are implemented.

| Field | Type | Purpose | Required | Mutable | Example |
| --- | --- | --- | --- | --- | --- |
| `id` | string matching `^TL-[0-9]{4}-[0-9]{3}-[A-Z]$` | Stable identifier for the timeline entry within the fixture. | Yes | No | `TL-2026-001-A` |
| `timestamp` | ISO 8601 UTC string | Time at which the observation or change occurred. | Yes | No after append | `2026-09-19T10:45:00Z` |
| `type` | enum: `detection`, `observation`, `deployment`, `investigation`, `mitigation`, `status_change` | Describes the timeline entry category. | Yes | No after append | `detection` |
| `summary` | string | Short factual description of the entry. | Yes | No after append except correction | `5xx error rate crossed the alert threshold.` |
| `source` | enum: `health`, `operator`, `deployment`, `event` | Identifies the originating domain record or observation source. | Yes | No after append | `health` |
| `deploymentId` | deployment ID string or `null` | Optional reference to the future deployment associated with the entry. | Yes; nullable | No after append except correction | `DEP-2026-0142` |
| `eventId` | event ID string or `null` | Optional reference to the future canonical event associated with the entry. | Yes; nullable | No after append except correction | `EVT-2026-0901` |

At least one of `deploymentId` and `eventId` may be populated for a
cross-domain entry. Both may be `null` for a health observation or an
operator-authored note. A non-null reference must also appear in the
corresponding top-level `relatedDeploymentIds` or `relatedEventIds` array.

The timeline is ordered by ascending `timestamp`; ties are ordered by `id`.
It should be append-only so an investigation retains a stable narrative.

### 1.4 Finding

A finding is an explicit observation or intermediate conclusion. Findings are
not presented as proven causal facts unless their evidence supports that
level of confidence.

| Field | Type | Purpose | Required | Mutable | Example |
| --- | --- | --- | --- | --- | --- |
| `id` | string matching `^FND-[0-9]{4}-[0-9]{3}$` | Stable finding identifier. | Yes | No | `FND-2026-001` |
| `statement` | string | The observation or conclusion in plain language. | Yes | Yes, when investigation changes it | `Payment errors and p95 latency increased in the same window.` |
| `confidence` | enum: `low`, `medium`, `high` | Confidence in the finding, separate from incident severity. | Yes | Yes | `high` |
| `evidenceRefs` | array of evidence ID strings | Future references supporting the finding. Empty until the evidence model exists. | Yes; may be empty | Yes, append-only | `["EVD-2026-001", "EVD-2026-002"]` |

The initial Phase B fixture may contain findings with empty `evidenceRefs`.
This indicates that the finding is a deterministic fixture statement, not that
an evidence engine already exists.

### 1.5 SuspectedCause

`suspectedCause` is a structured hypothesis rather than a confirmed root
cause. It must be possible to represent uncertainty and to identify the
deployment under investigation without claiming that the deployment caused
the incident.

| Field | Type | Purpose | Required | Mutable | Example |
| --- | --- | --- | --- | --- | --- |
| `summary` | string | Human-readable causal hypothesis. | Yes when object is present | Yes | `A recent payments deployment is the leading candidate.` |
| `confidence` | enum: `low`, `medium`, `high` | Confidence in the hypothesis. | Yes when object is present | Yes | `medium` |
| `deploymentId` | deployment ID string or `null` | Candidate deployment reference. `null` means no deployment candidate has been identified. | Yes when object is present | Yes | `DEP-2026-0142` |
| `rationale` | string | Explains why this is the current hypothesis without pretending to prove causality. | Yes when object is present | Yes | `The deployment is temporally adjacent to the health regression; event correlation is still required.` |
| `evidenceRefs` | array of evidence ID strings | Future evidence references that support or weaken the hypothesis. | Yes when object is present; may be empty | Yes, append-only | `[]` |

If later evidence disproves the hypothesis, the implementation should retain
the record and revise `summary`, `confidence`, and `rationale` rather than
silently replacing the investigative history.

### 1.6 Service identifiers

The service field reuses the existing `get_service_health` enum exactly:

```json
[
  "payments",
  "auth",
  "checkout",
  "notifications"
]
```

No new service names are introduced in Phase B. An unsupported service is an
input validation error for both proposed tools.

## 2. Incident Status

The lifecycle is intentionally minimal:

| Status | Meaning | Active? | Allowed transition targets |
| --- | --- | --- | --- |
| `investigating` | The issue is active and the cause or full scope is not yet confirmed. | Yes | `mitigated`, `resolved` |
| `mitigated` | User impact is reduced or contained, but the incident still needs follow-up or confirmation. | Yes | `resolved`, `investigating` if impact returns |
| `resolved` | The impact is over and the incident is closed for operational purposes. | No | None in the initial lifecycle |

`list_active_incidents` returns incidents whose status is `investigating` or
`mitigated`. Resolved incidents remain retrievable through `get_incident` if
they remain in the deterministic dataset, but are not returned by the active
list.

The model does not add separate `open`, `acknowledged`, `monitoring`, or
workflow requires them.

## 3. Severity

Severity uses four SRE-style levels:

| Severity | Meaning | Example impact |
| --- | --- | --- |
| `SEV-1` | Critical, broad, or business-critical outage requiring immediate coordinated response. | Payments unavailable across most or all traffic. |
| `SEV-2` | Major customer or business impact affecting a substantial portion of a service, with a credible ongoing risk. | Payment authorization failures and severe latency increase. |
| `SEV-3` | Limited or degraded impact with a workaround, partial scope, or contained customer effect. | Notification delivery degradation with most messages still succeeding. |
| `SEV-4` | Low-impact issue, internal degradation, or early warning that does not materially affect customers. | A non-customer-facing metric anomaly. |

Severity represents impact, not confidence in the cause. A `SEV-2` incident
can have a `low` confidence suspected cause, and a high-confidence finding
does not automatically make an incident high severity.

## 4. Relationships

### 4.1 Service to domain records

The service name is the shared join key across the current and future domain:

```text
Service("payments")
|-- Health snapshot for payments
|-- Incident INC-2026-001
|-- Deployment records whose service is payments
`-- Event records whose service is payments
```

The proposed incident model stores the service identifier, not a duplicated
Service object. This keeps `get_service_health` and future incident tools
consistent when the service catalog grows.

### 4.2 Incident relationships

- `Incident.service` identifies exactly one affected service.
- `Incident.relatedDeploymentIds` contains stable deployment IDs only.
- `Incident.relatedEventIds` contains stable event IDs only.
- `TimelineEntry.deploymentId` and `TimelineEntry.eventId` provide more
  precise links for individual timeline statements.
- `SuspectedCause.deploymentId` identifies the candidate deployment being
  investigated, if one exists.
- `Finding.evidenceRefs` and `SuspectedCause.evidenceRefs` reserve the path
  to future evidence without embedding evidence payloads today.

An incident may reference multiple deployments and events. A deployment or
event may be related to multiple incidents if a shared release or platform
event affects more than one service. The referenced record's own `service`
must match the incident's `service` in the initial model; cross-service
causes can be added later with an explicit relationship type rather than by
silently violating this invariant.

### 4.3 Future-compatible Deployment and Event references

Deployments and events are not implemented in Phase B, but the reference
format is reserved now:

- Deployment ID format: `DEP-YYYY-NNNN`, for example `DEP-2026-0142`.
- Event ID format: `EVT-YYYY-NNNN`, for example `EVT-2026-0901`.
- Evidence ID format: `EVD-YYYY-NNNN`, for example `EVD-2026-0001`.

The future Deployment record should at minimum be keyed by `id` and contain
the affected `service`, release or version information, deployment status,
and start/completion timestamps. The future Event record should at minimum be
keyed by `id` and contain `service`, `timestamp`, `type`, `summary`, and any
associated `deploymentId`. Those records should be canonical; an incident
must not copy their full payload into `timeline`.

## 5. Deterministic Incident Dataset

The initial fixture contains two active incidents and no incidents for the
two currently healthy services. This is enough to demonstrate filtering,
service health correlation, incident retrieval, severity ordering, and a
follow-up investigation without creating a large mock environment.

The fixture reference time is conceptual and fixed. No tool should generate a
new timestamp at request time.

### 5.1 Dataset summary

| ID | Service | Title | Severity | Status | Active |
| --- | --- | --- | --- | --- | --- |
| `INC-2026-001` | `payments` | Elevated payment authorization failures | `SEV-2` | `investigating` | Yes |
| `INC-2026-002` | `notifications` | Notification delivery delays | `SEV-3` | `mitigated` | Yes |

`auth` and `checkout` have no active incident records in this fixture.

### 5.2 Incident `INC-2026-001`

This is the primary investigation incident. Its references are designed to
become real links when deployment and event records are implemented; the
fixture does not claim that those records currently exist.

```json
{
  "id": "INC-2026-001",
  "service": "payments",
  "title": "Elevated payment authorization failures",
  "severity": "SEV-2",
  "status": "investigating",
  "createdAt": "2026-09-19T10:45:00Z",
  "updatedAt": "2026-09-19T11:05:00Z",
  "description": "Payment authorization failures and latency are elevated in the latest health window, affecting the payment path while investigation continues.",
  "timeline": [
    {
      "id": "TL-2026-001-A",
      "timestamp": "2026-09-19T10:45:00Z",
      "type": "detection",
      "summary": "5xx error rate crossed the alert threshold and payment latency increased.",
      "source": "health",
      "deploymentId": null,
      "eventId": "EVT-2026-0901"
    },
    {
      "id": "TL-2026-001-B",
      "timestamp": "2026-09-19T10:50:00Z",
      "type": "deployment",
      "summary": "A recent payments deployment was identified as a candidate for correlation.",
      "source": "deployment",
      "deploymentId": "DEP-2026-0142",
      "eventId": "EVT-2026-0902"
    },
    {
      "id": "TL-2026-001-C",
      "timestamp": "2026-09-19T11:05:00Z",
      "type": "investigation",
      "summary": "The deployment remains a medium-confidence hypothesis pending event correlation.",
      "source": "operator",
      "deploymentId": "DEP-2026-0142",
      "eventId": "EVT-2026-0903"
    }
  ],
  "findings": [
    {
      "id": "FND-2026-001",
      "statement": "Payment error rate and p95 latency increased in the same 15-minute health window.",
      "confidence": "high",
      "evidenceRefs": []
    },
    {
      "id": "FND-2026-002",
      "statement": "The candidate deployment is temporally adjacent to the observed regression, but causality is not confirmed.",
      "confidence": "medium",
      "evidenceRefs": []
    }
  ],
  "suspectedCause": {
    "summary": "A recent payments deployment is the leading candidate for the authorization failure regression.",
    "confidence": "medium",
    "deploymentId": "DEP-2026-0142",
    "rationale": "The deployment is temporally adjacent to the elevated 5xx rate and p95 latency; event correlation is required before calling it causal.",
    "evidenceRefs": []
  },
  "relatedDeploymentIds": ["DEP-2026-0142"],
  "relatedEventIds": [
    "EVT-2026-0901",
    "EVT-2026-0902",
    "EVT-2026-0903"
  ]
}
```

### 5.3 Incident `INC-2026-002`

This secondary incident demonstrates that multiple services can have active
incidents while preserving a small fixture. Its `mitigated` status keeps it
active for the list tool but distinguishes it from the primary investigation.

```json
{
  "id": "INC-2026-002",
  "service": "notifications",
  "title": "Notification delivery delays",
  "severity": "SEV-3",
  "status": "mitigated",
  "createdAt": "2026-09-19T10:20:00Z",
  "updatedAt": "2026-09-19T11:00:00Z",
  "description": "Notification delivery latency increased and a subset of messages was delayed; impact is currently contained.",
  "timeline": [
    {
      "id": "TL-2026-002-A",
      "timestamp": "2026-09-19T10:20:00Z",
      "type": "detection",
      "summary": "Notification 5xx rate and p95 latency increased in the latest health window.",
      "source": "health",
      "deploymentId": null,
      "eventId": "EVT-2026-0910"
    },
    {
      "id": "TL-2026-002-B",
      "timestamp": "2026-09-19T11:00:00Z",
      "type": "mitigation",
      "summary": "Queue pressure was reduced and delivery delays are currently contained.",
      "source": "operator",
      "deploymentId": null,
      "eventId": "EVT-2026-0911"
    }
  ],
  "findings": [
    {
      "id": "FND-2026-003",
      "statement": "Notification error rate and p95 latency are degraded, but the issue is currently contained.",
      "confidence": "high",
      "evidenceRefs": []
    }
  ],
  "suspectedCause": null,
  "relatedDeploymentIds": [],
  "relatedEventIds": ["EVT-2026-0910", "EVT-2026-0911"]
}
```

### 5.4 Deterministic ordering

`list_active_incidents` should return records in this order:

1. Severity rank, from `SEV-1` to `SEV-4`.
2. `createdAt`, newest first within the same severity.
3. `id`, ascending as a final tie-breaker.

The response must not include `generatedAt`, random values, request-specific
IDs, or other changing fields.

## 6. Primary Demo Incident

The primary incident is `INC-2026-001`, the payments incident. This choice is
intentional because the existing `get_service_health` fixture already reports
that `payments` is degraded:

- availability: `99.21`
- error rate: `18.4`
- p95 latency: `920`
- signals: increased 5xx error rate and increased p95 latency

The intended future investigation is:

```text
get_service_health(service="payments")
  -> list_active_incidents(service="payments")
  -> get_incident(id="INC-2026-001")
  -> get_recent_deployments(service="payments")
  -> get_service_events(service="payments")
  -> correlate evidence
  -> explain suspected cause
```

Only the first three calls in that sequence are in scope for the current
design. `get_recent_deployments`, `get_service_events`, correlation, and
explanation are future capabilities. The incident's medium-confidence
deployment hypothesis is deliberately phrased so Alexa+ can explain what is
known, what is suspected, and what evidence is still missing.

## 7. Health Consistency

The proposed incident dataset is consistent with the existing deterministic
health snapshots in `server.js`.

| Service | Existing health | Proposed active incident state | Consistency assessment |
| --- | --- | --- | --- |
| `payments` | `degraded`, 18.4 error rate, p95 920 ms, increased 5xx and latency signals | `INC-2026-001`, `SEV-2`, `investigating` | Consistent. The degraded health supports an active major incident. |
| `auth` | `healthy`, 0.03 error rate, p95 118 ms, no notable change | No active incident | Consistent for this fixture. Healthy does not imply no historical incidents. |
| `checkout` | `healthy`, 0.12 error rate, p95 245 ms, stable latency signal | No active incident | Consistent. There is no contradictory active incident. |
| `notifications` | `degraded`, 4.6 error rate, p95 684 ms, increased 5xx and latency signals | `INC-2026-002`, `SEV-3`, `mitigated` | Consistent. The degraded health supports a contained active incident. |

No health values need to change for this design. In particular, the model does
not add an active `SEV-1` incident to a healthy service.

The current health tool does not expose an absolute snapshot timestamp. The
incident timestamps therefore express deterministic fixture chronology and
must not be described as an exact production-time correlation until health,
deployment, and event records share an explicit `asOf` or observation time.
That timestamp alignment is a future implementation decision, not a reason to
change `server.js` during design review.

## 8. Future Evidence Chain

The future chain must preserve both references and reasoning:

```text
Incident
  -> Deployment
  -> Event
  -> Evidence
```

### 8.1 Proposed future flow

1. An Incident identifies the affected service and candidate deployment IDs.
2. A Deployment record describes what changed, when it changed, and which
   service version was affected.
3. Event records describe observable operational changes around the deployment,
   such as error-rate alerts, latency changes, queue pressure, or rollback
   actions.
4. Evidence records normalize a specific observation or comparison that
   supports a finding or suspected cause.
5. A Finding or `SuspectedCause` points to evidence IDs through `evidenceRefs`.
6. A future explanation layer can traverse those references and state why a
   deployment is suspected, including uncertainty and missing evidence.

### 8.2 Evidence provenance requirement

Every future causal claim should be traceable to evidence with at least:

- evidence ID
- source type, such as `health`, `deployment`, or `event`
- source record ID
- observation time or comparison window
- factual observation
- relationship to the finding or suspected cause
- confidence or strength

For the primary incident, the eventual answer to:

> What evidence caused DupTrace to suspect this deployment?

should be assembled from explicit references such as:

```text
INC-2026-001
  -> DEP-2026-0142
  -> EVT-2026-0901 and EVT-2026-0902
  -> EVD-2026-0001 and EVD-2026-0002
```

The explanation should be able to say that the deployment was temporally
adjacent to increased 5xx errors and p95 latency, while distinguishing those
correlations from proof of causation. No evidence records are created by this
Phase B design.

### 8.3 No duplicated source payloads

Incident records may contain summaries for conversational usefulness, but the
canonical deployment, event, and evidence payloads must live in their own
future collections. This avoids inconsistent copies when an event is updated
and allows multiple incidents to reference the same operational record.

## 9. MCP Tool Contracts

These are proposed contracts for future MCP registration. They use the same
service enum and structured-output approach as `get_service_health`, but they
are not implemented yet.

### 9.1 `list_active_incidents`

#### Purpose

Return active incidents across all services, or active incidents for one
existing service. Active means status is `investigating` or `mitigated`.

#### Input schema

```json
{
  "type": "object",
  "properties": {
    "service": {
      "type": "string",
      "enum": [
        "payments",
        "auth",
        "checkout",
        "notifications"
      ],
      "description": "Optional service filter. Omit to inspect all services."
    }
  },
  "additionalProperties": false
}
```

An empty object is valid. There is no pagination, time filter, severity
filter, or status filter in the initial contract; those can be added when the
dataset is no longer a small deterministic fixture.

#### Output schema

The tool returns `structuredContent` with this shape and a text JSON fallback
using the same object:

```json
{
  "type": "object",
  "required": ["incidents", "count", "filter"],
  "properties": {
    "incidents": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "id",
          "service",
          "title",
          "severity",
          "status",
          "createdAt",
          "updatedAt"
        ],
        "properties": {
          "id": { "type": "string" },
          "service": {
            "type": "string",
            "enum": [
              "payments",
              "auth",
              "checkout",
              "notifications"
            ]
          },
          "title": { "type": "string" },
          "severity": {
            "type": "string",
            "enum": ["SEV-1", "SEV-2", "SEV-3", "SEV-4"]
          },
          "status": {
            "type": "string",
            "enum": ["investigating", "mitigated"]
          },
          "createdAt": { "type": "string" },
          "updatedAt": { "type": "string" }
        },
        "additionalProperties": false
      }
    },
    "count": {
      "type": "integer",
      "minimum": 0
    },
    "filter": {
      "type": "object",
      "required": ["service"],
      "properties": {
        "service": {
          "type": ["string", "null"],
          "enum": [
            "payments",
            "auth",
            "checkout",
            "notifications",
            null
          ]
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

The response deliberately returns summaries rather than full incident
timelines. The summary is sufficient for Alexa+ to choose an incident for
`get_incident` without flooding the conversational context.

#### Error behavior

- An unsupported `service` value is rejected by input validation and returned
  as an MCP tool error with `isError: true`.
- Missing input is treated as `{}` and returns all active incidents.
- A valid service with no active incidents is a successful response with
  `incidents: []`, `count: 0`, and the requested service in `filter.service`.
- The tool must not return an HTTP-level error for an empty result.

#### Example request

```json
{
  "name": "list_active_incidents",
  "arguments": {
    "service": "payments"
  }
}
```

#### Example response

```json
{
  "incidents": [
    {
      "id": "INC-2026-001",
      "service": "payments",
      "title": "Elevated payment authorization failures",
      "severity": "SEV-2",
      "status": "investigating",
      "createdAt": "2026-09-19T10:45:00Z",
      "updatedAt": "2026-09-19T11:05:00Z"
    }
  ],
  "count": 1,
  "filter": {
    "service": "payments"
  }
}
```

### 9.2 `get_incident`

#### Purpose

Return one complete incident by stable ID, including its timeline, findings,
current suspected cause, and future deployment/event references.

#### Input schema

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^INC-[0-9]{4}-[0-9]{3}$",
      "description": "Stable incident identifier."
    }
  },
  "required": ["id"],
  "additionalProperties": false
}
```

#### Output schema

The output is the complete `Incident` entity defined in Section 1. Its
required top-level fields are:

```json
[
  "id",
  "service",
  "title",
  "severity",
  "status",
  "createdAt",
  "updatedAt",
  "description",
  "timeline",
  "findings",
  "suspectedCause",
  "relatedDeploymentIds",
  "relatedEventIds"
]
```

The nested `TimelineEntry`, `Finding`, and `SuspectedCause` shapes are the
exact shapes defined in Sections 1.3, 1.4, and 1.5. The tool returns the
object as `structuredContent` and also provides a text JSON representation for
clients that only consume text content.

#### Error behavior

- An input that is missing `id`, has an invalid ID format, or contains extra
  fields is rejected by input validation and returned as an MCP tool error
  with `isError: true`.
- A validly formatted but unknown ID is a deterministic not-found tool error
  with `isError: true` and a message containing the requested ID.
- A valid existing ID returns exactly one complete incident.
- The tool must not silently return an empty object or a different incident.

#### Example request

```json
{
  "name": "get_incident",
  "arguments": {
    "id": "INC-2026-001"
  }
}
```

#### Example response

```json
{
  "id": "INC-2026-001",
  "service": "payments",
  "title": "Elevated payment authorization failures",
  "severity": "SEV-2",
  "status": "investigating",
  "createdAt": "2026-09-19T10:45:00Z",
  "updatedAt": "2026-09-19T11:05:00Z",
  "description": "Payment authorization failures and latency are elevated in the latest health window, affecting the payment path while investigation continues.",
  "timeline": [
    {
      "id": "TL-2026-001-A",
      "timestamp": "2026-09-19T10:45:00Z",
      "type": "detection",
      "summary": "5xx error rate crossed the alert threshold and payment latency increased.",
      "source": "health",
      "deploymentId": null,
      "eventId": "EVT-2026-0901"
    }
  ],
  "findings": [
    {
      "id": "FND-2026-001",
      "statement": "Payment error rate and p95 latency increased in the same 15-minute health window.",
      "confidence": "high",
      "evidenceRefs": []
    }
  ],
  "suspectedCause": {
    "summary": "A recent payments deployment is the leading candidate for the authorization failure regression.",
    "confidence": "medium",
    "deploymentId": "DEP-2026-0142",
    "rationale": "The deployment is temporally adjacent to the elevated 5xx rate and p95 latency; event correlation is required before calling it causal.",
    "evidenceRefs": []
  },
  "relatedDeploymentIds": ["DEP-2026-0142"],
  "relatedEventIds": [
    "EVT-2026-0901",
    "EVT-2026-0902",
    "EVT-2026-0903"
  ]
}
```

The example is abbreviated only in the sense that it shows one timeline entry
and one finding; an actual response must return the complete stored incident
including all entries and findings.

## 10. Alexa+ Investigation Flow

Alexa+ should use the tools as evidence-oriented capabilities rather than a
hard-coded conversation tree. The model should choose the next tool based on
the information returned by the previous tool and should distinguish facts,
hypotheses, and missing evidence.

Example conversation:

```text
User: What's wrong with payments?
```

Intended reasoning sequence:

1. Call `get_service_health` for `payments`.
   - Contributes the current status, availability, error rate, latency
     percentiles, comparison window, and health signals.
2. If health is `degraded`, call `list_active_incidents` with
   `service: "payments"`.
   - Contributes the active incident ID, severity, lifecycle status, and a
     concise title.
3. Call `get_incident` for the returned incident ID.
   - Contributes the description, timeline, findings, suspected cause, and
     candidate deployment/event references.
4. In the future, call `get_recent_deployments` for `payments`.
   - Resolves the deployment reference into an actual deployment record and
     provides release timing and change information.
5. In the future, call `get_service_events` for `payments`.
   - Resolves event references and supplies alerts, latency changes, error
     changes, rollback signals, and other operational observations.
6. In the future, correlate deployment timing and event evidence.
   - Raises or lowers the suspected-cause confidence without treating timing
     alone as proof.
7. In the future, explain the chain in plain language.
   - States the impact, the active incident, the leading hypothesis, the
     supporting evidence, the uncertainty, and any next action.

An eventual answer could be structured conceptually as:

```text
Payments is degraded: availability is 99.21%, error rate is 18.4%, and p95
latency is 920 ms over the latest 15 minutes. There is one active SEV-2
incident, "Elevated payment authorization failures." A recent deployment is
the leading suspected cause with medium confidence because it is temporally
close to the increase in 5xx errors and latency. Deployment and event
correlation are still needed to confirm causality.
```

That answer is a result of tool composition and model reasoning. No Alexa+
integration or fixed voice script is defined by this document.

## 11. Design Decisions

The following decisions are part of this proposal and should be reviewed
before implementation:

- Use stable fixture IDs with explicit prefixes: `INC`, `TL`, `FND`, `DEP`,
  `EVT`, and `EVD`.
- Keep incident ownership to one existing service in the initial model.
- Treat `investigating` and `mitigated` as active; exclude `resolved` from the
  active list.
- Use `SEV-1` through `SEV-4` for impact and `low` through `high` for
  confidence. Do not conflate them.
- Keep `timeline` as an incident narrative and keep canonical event payloads
  in a future event collection.
- Keep deployment and event references as ID arrays plus precise references on
  timeline entries and hypotheses.
- Allow `suspectedCause` to be `null`; an incident must not invent a cause.
- Return incident summaries from `list_active_incidents` and full records from
  `get_incident`.
- Return empty successful results for valid service filters with no active
  incidents.
- Use MCP tool-level `isError: true` results for validation and not-found
  failures rather than inventing HTTP error semantics.
- Return deterministic ordering and omit request-time timestamps.
- Keep data in memory and use fixed fixture timestamps for the hackathon phase.
- Do not add databases, authentication, OAuth, AWS services, external APIs,
  LLM calls, frontend code, or npm packages for this phase.

Unresolved decisions before or during implementation:

- Whether a future health snapshot should gain an explicit `asOf` timestamp so
  its time relationship to incidents, deployments, and events is machine
  verifiable.
- The complete Deployment schema and whether deployment IDs are globally
  unique or unique only within a service.
- The complete Event schema, event type vocabulary, retention window, and
  whether events can be shared across services.
- The complete Evidence schema and how evidence strength is calculated.
- Whether `mitigated` should remain active for the first implementation or
  whether the active list should include only `investigating` incidents.
- Whether incident history will remain append-only when a severity or title is
  corrected, or whether a separate audit trail is needed.
- Whether `list_active_incidents` should later support severity filtering,
  pagination, or a bounded time window.
- Whether an unknown incident ID should use a standardized error code or only
  the current MCP tool error convention.
- Whether cross-service incidents need an explicit primary service plus
  affected-service list rather than the initial single-service invariant.

## Implementation Readiness

The proposed model is ready for review and for a first deterministic
implementation of `list_active_incidents` and `get_incident` after approval.
It is not yet a complete implementation specification for deployments,
events, evidence, explanation, or action workflows.

The main unresolved decisions are timestamp alignment with health snapshots,
the future Deployment/Event/Evidence schemas, the precise definition of an
active `mitigated` incident, and the standardized not-found error shape. None
blocks implementing the two initial incident tools if the current proposed
defaults are accepted explicitly.
