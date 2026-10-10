# DupTrace

**Investigate operational incidents with evidence, not guesswork.**

DupTrace is an agent-native investigation interface built around deterministic fixture data and read-only MCP tools. It helps developers inspect service health, explore incident evidence, and carry verified context across follow-up questions.

## Why DupTrace

Operational investigations often require developers to connect information scattered across service health, incident timelines, deployment records, and event evidence. DupTrace provides a conversational workflow for examining that information while keeping the underlying evidence inspectable.

## Core capabilities

- MCP-backed tool execution for operational investigations.
- Structured evidence and readable tool activity.
- Incident timeline integrity checks against referenced events.
- Follow-up context derived from verified tool activity.
- Streaming responses using Server-Sent Events.
- Provider error handling and response checks designed to avoid exposing internal details.
- A causality guardrail: correlation is not proof of causation.

## Architecture

- **Interface:** HTML, CSS, and browser JavaScript.
- **Application/API:** Node.js, Express, and TypeScript-aware execution through `tsx`.
- **Agent integration:** MCP tools and a configurable model provider.
- **Validation:** Automated integrity, formatting, provider, and web/API test suites.

## Requirements

- Node.js with npm.
- Access to the configured DupTrace MCP endpoint.
- A supported model provider. The default configuration uses the Claude CLI, which must be installed and authenticated separately.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Edit `.env` and configure the MCP endpoint and model provider for your environment. Do not commit `.env` or credentials.

4. Start the required MCP server and fixture data source using their configured launch instructions.

5. Start DupTrace:

   ```bash
   npm start
   ```

6. Open the local application address reported by the server.

For development with automatic restarts:

```bash
npm run dev
```

## Configuration

| Variable | Purpose |
|---|---|
| `DUPTRACE_MCP_URL` | MCP endpoint used by the application |
| `MODEL_PROVIDER` | Model-provider selection |
| `MODEL_CLI_COMMAND` | CLI executable for the CLI provider |
| `MODEL_NAME` | Optional model identifier |
| `MODEL_API_KEY` | Provider API key, when required |
| `MODEL_BASE_URL` | API-compatible provider base URL |
| `MAX_AGENT_STEPS` | Maximum agent-loop steps |
| `MCP_CLIENT_TIMEOUT_MS` | MCP client timeout |
| `MODEL_TIMEOUT_MS` | Model API timeout |
| `MODEL_CLI_TIMEOUT_MS` | CLI provider timeout |

Use only the configuration variables supported by the selected provider. Keep real credentials in `.env`, never in source control.

## Tests

Run the full automated suite:

```bash
npm test
```

The suite checks timeline integrity, context validation, evidence formatting, provider process behavior, web/API routes, streaming behavior, request validation, and secret leakage in tested responses.

## Investigation principle

DupTrace distinguishes observed evidence from interpretation. A correlation between two events does not establish causation. Conclusions should remain proportional to the evidence returned by the tools.

## Current scope

DupTrace currently focuses on controlled fixture data and read-only investigation workflows. Do not treat fixture results as live production telemetry unless the configured data source explicitly provides it.

## Security

- Keep API keys and local environment files out of Git.
- Do not expose internal provider errors or credentials to users.
- Keep investigation tools read-only unless the architecture is explicitly reviewed and changed.
- Validate tool outputs before using them as evidence.

## Status

Automated checks currently pass in the development environment. Deployment readiness, external provider availability, and hackathon-specific submission requirements must be assessed separately.
