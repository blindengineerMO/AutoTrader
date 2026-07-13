# BrainMesh Communication Language PROTOSPEC

Version: `BMCL/1.0`

BrainMesh is AutoTrader's internal brain-to-brain communication stack. It is designed for background, bidirectional, always-on communication between research, discovery, chat, modeling, reporting, and evaluation brains. The protocol is intentionally JSON-first so frames are easy to inspect in SQLite, stream over HTTP, and replay in tests.

## Goals

- Let brains exchange research facts, candidate leads, model scores, warnings, and requests without direct service coupling.
- Support RPC-style request/reply (`ask`) and event/broadcast (`tell` / `event`) patterns.
- Preserve conversation and trace IDs so advanced troubleshooting can follow a decision from crawl to report.
- Work inside the current single-port Express deployment behind Traefik.
- Avoid fragile external infrastructure. The local runtime uses Node `EventEmitter`, SQLite persistence, and Server-Sent Events for live stream inspection.

## Non-Goals

- BrainMesh is not a broker execution protocol.
- BrainMesh does not expose unauthenticated public control surfaces.
- BrainMesh does not replace durable business tables such as `research_snapshots`, `decision_reports`, or `evaluation_reports`; it provides traceable internal coordination around them.

## Core Concepts

### Brain Agent

A brain agent is a named participant with capabilities.

Current built-in agents:

- `brain.research.source`: source learning, crawl source memory, failed URL policy.
- `brain.discovery.company`: dynamic company/product/ticker discovery.
- `brain.research.chat`: xAI/Grok, Gemini, Duck.ai endpoint/webapp research, and chat-research normalization.
- `brain.llm.ollama`: local Ollama LLM assistance for reasoning, research interpretation, analysis, and training suggestions across BrainMesh.
- `brain.intelligence.company`: company workspace and broker-factor intelligence.
- `brain.model.neural`: Brain.js scoring and model memory.
- `brain.playbook.investor`: high-earning investor indicator playbook.
- `brain.reporting`: decision report assembly.
- `brain.evaluation`: daily/manual self-evaluation.

### Conversation

A conversation groups related frames around a task, such as one autonomous research run.

Conversation IDs use the prefix `bc_`.

Example:

```json
{
  "id": "bc_8bdf45a70e40ac3b",
  "topic": "autonomous-research:42",
  "metadata": {
    "researchRunId": 42,
    "trace": "bt_413b1d13e9db7084"
  }
}
```

### Trace

A trace follows causality across one or more conversations. Most autonomous research frames in a run share the same `trace`.

Trace IDs use the prefix `bt_`.

### Frame

A frame is the smallest BrainMesh message unit. Every frame must be valid `BMCL/1.0` JSON.

## Envelope Grammar

Canonical frame:

```json
{
  "proto": "BMCL/1.0",
  "id": "bm_f00d1234cafe9876",
  "ts": "2026-07-12T12:00:00.000Z",
  "trace": "bt_413b1d13e9db7084",
  "conv": "bc_8bdf45a70e40ac3b",
  "cause": "bm_previous_message_id_or_null",
  "hop": 0,
  "ttl": 16,
  "from": "brain.research.source",
  "to": ["brain.discovery.company", "brain.research.chat"],
  "kind": "event",
  "op": "research.collection.ready",
  "qos": {
    "ack": false,
    "durable": true,
    "priority": "normal"
  },
  "ctx": {
    "userId": 1,
    "researchRunId": 42
  },
  "body": {
    "learnedObservations": 12,
    "newsItems": 31
  }
}
```

### Required Fields

- `proto`: must be `BMCL/1.0`.
- `id`: unique frame ID, prefix `bm_`.
- `ts`: ISO-8601 timestamp.
- `trace`: trace ID, prefix `bt_`.
- `conv`: conversation ID, prefix `bc_`.
- `from`: sender agent ID.
- `to`: non-empty array of recipient agent IDs.
- `kind`: one of `tell`, `ask`, `reply`, `event`, `error`.
- `op`: operation name.
- `ctx`: context object.
- `body`: payload object.

### Optional Fields

- `cause`: parent frame ID for replies/errors.
- `hop`: routing hop count. Current local bus starts at `0`.
- `ttl`: maximum allowed hops. Default is `16`.
- `qos`: delivery hints.

## Operation Naming

Operations use dot-separated verbs:

- `research.run.started`
- `research.collection.ready`
- `candidate.discovery.ready`
- `chat.research.ready`
- `preplan.ready`
- `candidate.scores.ready`
- `research.snapshot.persisted`
- `mesh.status`
- `candidate.extract`
- `chat.hints.normalize`
- `llm.assist`
- `llm.reason`
- `llm.research.assist`
- `llm.training.suggest`
- `llm.analysis.assist`
- `source.memory.summary`
- `source.hint.persist`
- `playbook.summary`

Rule of thumb: first segment is domain, last segment is state or verb.

## Message Kinds

### `event`

Broadcast state transition. No reply expected.

### `tell`

Directed message. A handler may process it, but callers do not wait.

### `ask`

RPC-style request. The mesh dispatches to registered handlers and returns replies/errors.

### `reply`

Successful response to an `ask`. The `cause` field points to the request frame ID.

### `error`

Failed response to an `ask` or handler failure. The `body.error` field carries the message.

## Runtime Interfaces

### Service API

File: `src/services/brainMeshService.js`

Primary calls:

```js
const brainMesh = require('./brainMeshService');

const conversation = brainMesh.startConversation({
  userId,
  topic: 'autonomous-research:42',
  metadata: { researchRunId: 42 },
});

brainMesh.tell({
  from: 'brain.research.source',
  to: ['brain.discovery.company'],
  kind: 'event',
  op: 'research.collection.ready',
  ctx: { userId, researchRunId: 42 },
  conv: conversation.id,
  trace: conversation.metadata.trace,
  body: { newsItems: 31 }
});

const result = await brainMesh.ask({
  from: 'brain.reporting',
  to: 'brain.research.source',
  op: 'source.memory.summary',
  ctx: { userId },
  body: {}
});
```

### HTTP API

All routes require authentication.

- `GET /api/brain-mesh/agents`
  - Lists built-in and registered brains.
- `POST /api/brain-mesh/agents`
  - Dynamically registers a user-owned brain/agent with `id`, `role`, `capabilities`, `status`, and `metadata`.
- `DELETE /api/brain-mesh/agents/:id`
  - Marks a user-owned dynamic agent as removed. Built-in global brains are not removed through this endpoint.
- `GET /api/brain-mesh/agent-links?boardId=agent-council`
  - Lists agent/board links for the user.
- `POST /api/brain-mesh/agent-links`
  - Links an agent to a board/council/workgroup with `agentId`, `boardId`, `role`, and optional metadata.
- `DELETE /api/brain-mesh/agent-links/:boardId/:agentId`
  - Removes an agent from a board/council/workgroup.
- `GET /api/brain-mesh/conversations?limit=50`
  - Lists recent conversations visible to the user.
- `GET /api/brain-mesh/messages?conversationId=bc_...&traceId=bt_...&limit=100`
  - Lists recorded frames.
- `POST /api/brain-mesh/tell`
  - Sends an event/tell frame.
- `POST /api/brain-mesh/ask`
  - Sends an RPC request and returns replies.
- `GET /api/brain-mesh/stream`
  - Live Server-Sent Events stream.

### SSE Stream

Example:

```bash
curl -N \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/brain-mesh/stream
```

Events:

- `ready`: stream attached.
- `brain-frame`: live frame.
- `heartbeat`: keepalive every 25 seconds.

The stream is WebSocket-style in behavior but uses SSE so AutoTrader remains dependency-light and compatible with Traefik single-port proxying.

## Persistence

Migration: `src/db/migrations/008_brain_mesh_protocol.sql`

Tables:

- `brain_mesh_agents`
- `brain_mesh_conversations`
- `brain_mesh_messages`
- `brain_mesh_agent_links`

Message records store the full frame in `envelope_json`, plus indexed fields for user, conversation, trace, sender, recipient, kind, op, and status.

Agent links bind any BrainMesh agent to a logical board such as `agent-council`, `risk-review`, or `research-desk`. Links are user-scoped and carry a role plus metadata so agents can be dynamically added to or removed from background councils without changing the protocol envelope.

## Console Chat Lifecycle Logs

BMCL emits server-console log messages for each inner-brain or brain-to-agent frame, separate from the broader conversation lifecycle:

- `BMCL chat started`
- `BMCL chat stopped`

Each message includes `frameId`, `kind`, `op`, `from`, `to`, `trace`, and `conversation`. For RPC `ask` frames, the stop log is emitted after replies settle. For fire-and-forget `tell`/`event` frames, the stop log is emitted after each matching handler finishes or immediately with `handlers: 0` when no handler is registered. This intentionally tracks individual chats, not whole conversations.

## Built-in RPC Handlers

### `mesh.status`

Available on every built-in brain. Returns role, status, capabilities, and metadata.

### `candidate.extract`

Recipient: `brain.discovery.company`

Body:

```json
{
  "news": { "items": [] },
  "learned": { "observations": [] },
  "maxCandidates": 18
}
```

Returns dynamic company candidates from crawled/news text.

### `chat.hints.normalize`

Recipient: `brain.research.chat`

Normalizes untrusted chat JSON into clean `candidateHints` and `sourceHints`.

### Local Ollama LLM Operations

Recipient: `brain.llm.ollama`

The local Ollama brain is a shared BMCL participant for agents that need local LLM reasoning without coupling directly to Ollama APIs. The implementation uses the official `ollama` npm package against `OLLAMA_BASE_URL` (default `http://localhost:11434`), `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS` (default `300000`), `OLLAMA_MAX_PROMPT_TOKENS` (default `4096`), `OLLAMA_NUM_PREDICT` (default `1400`), and `OLLAMA_THINK` (default `false`), redacts sensitive keys from request bodies, clips oversized strings, and returns compact AI-to-AI JSON. It may use bounded app-owned research tools only for research-oriented requests.

Chat research also prefers Ollama locally by default (`CHAT_RESEARCH_PREFER_OLLAMA=true`). After a successful local Ollama research/comprehension response, external chat providers are skipped. If local Ollama fails, external providers are still skipped unless `CHAT_RESEARCH_EXTERNAL_FALLBACK_ENABLED=true`. Duck.ai browser automation is opt-in with `DUCK_AI_RESEARCH_ENABLED=true` or a sanctioned endpoint.

The final strategy engine also uses this context policy for local Ollama. It sends a compact decision frame containing ranked signal metrics, top candidate rationale, macro/consumer summaries, chat-research hints, and compact source metadata. It does not send the full research snapshot, crawler archive, terminal stream, or full page excerpts to the structured-completion strategy call.

Personality trading agents (`agent.personality.*`) persist a `localAiCollaboration` persona block and a `model.bmcl` block that name `brain.llm.ollama` as their local LLM collaborator. This metadata is also advertised in the BrainMesh agent registry with the `bmcl.ask.ollama` capability so seeded agents such as Bill Gates, imported agents, and newly researched custom agents can discover that they may use BMCL `ask` frames for reasoning, research interpretation, analysis, and self-improvement.

Personality agent BMCL identities are shared globally by slug, not duplicated per user. For example, two users who both enable the Bill Gates worker use the same BrainMesh participant ID, `agent.personality.bill-gates`. User-specific state remains in `trading_agents`, agent workspaces, council runs, recommendations, reports, and account/ledger tables keyed by `user_id`; BMCL frames must carry the caller's `ctx.userId` so the shared brain can reason against the correct user's portfolio and settings.

Typical personality-agent self-improvement frame:

```json
{
  "from": "agent.personality.bill-gates",
  "to": ["brain.llm.ollama"],
  "kind": "ask",
  "op": "llm.training.suggest",
  "body": {
    "question": "What should this agent adjust after the council outcome?",
    "evidence": [{ "symbol": "MSFT", "action": "buy", "outcome": "underperformed" }],
    "desiredOutput": "training notes and small bias-tuning suggestions"
  }
}
```

Supported ops:

- `llm.assist`: general structured assistance for any brain/agent.
- `llm.reason`: evidence-based causal reasoning over supplied context.
- `llm.research.assist`: research interpretation, gap detection, and optional controlled search/page-reading tool calls.
- `llm.training.suggest`: model-training, labeling, feature, and evaluation-loop suggestions; tools are disabled.
- `llm.analysis.assist`: broader analysis support; tools are only used when `body.allowTools === true`.

Request body:

```json
{
  "question": "What did this watcher miss?",
  "evidence": [{ "symbol": "XYZ", "rationale": "..." }],
  "allowTools": false,
  "desiredOutput": "training labels and next checks"
}
```

Response body:

```json
{
  "provider": "ollama",
  "brainId": "brain.llm.ollama",
  "model": "llama3.1",
  "mode": "training",
  "summary": "short answer",
  "reasoning": "brief auditable causal chain",
  "insights": ["specific finding"],
  "recommendations": ["specific next action"],
  "followUpQuestions": ["question another brain should answer"],
  "trainingNotes": ["feature/label/model-memory suggestion"],
  "sourceHints": [],
  "candidateHints": [],
  "riskNotes": ["specific caveat"]
}
```

Tool-capable research requests can trigger `search_live_research` and `read_research_url`. These tools are implemented by the application, use short timeouts, and reject local/private URLs. Before a local chat request is sent, AutoTrader estimates prompt tokens and splits oversized crawled/news/article payloads into sub-`OLLAMA_MAX_PROMPT_TOKENS` questions, then merges chunk-level `candidateHints`, `sourceHints`, and `riskNotes`. If the selected local model reports no tool-calling capability, BMCL keeps the request local and asks Ollama to synthesize from those crawler excerpt chunks without tools.

### `source.memory.summary`

Recipient: `brain.research.source`

Returns counts and top source-memory records for a user.

### `source.hint.persist`

Recipient: `brain.research.source`

Persists source hints into learned URL memory.

### `playbook.summary`

Recipient: `brain.playbook.investor`

Returns the local investor playbook summary.

### `mesh.agent.linked`

Recipient: linked agent ID

Emitted by `brain.mesh.registry` whenever a dynamic agent is attached to a board.

### `mesh.agent.unlinked`

Recipient: unlinked agent ID

Emitted by `brain.mesh.registry` whenever a dynamic agent is removed from a board.

### `agent.research.started`

Recipient: research/source, company discovery, and company intelligence brains

Emitted when the UI starts an autonomous agent creation run. The frame body includes the target name and generated research questions.

### `agent.profile.ready`

Recipient: agent council moderator and reporting brain

Emitted when Crawlee/Finnhub research has produced a saved personality model, source URLs, watch symbols, and opportunity map.

## Autonomous Research Trace

An autonomous collect/process run emits these frames:

1. `research.run.started`
2. `research.collection.ready`
3. `candidate.discovery.ready`
4. `chat.research.ready`
5. `preplan.ready`
6. `candidate.scores.ready`
7. `research.snapshot.persisted`

Troubleshooting a bad trade starts by finding the decision report, finding the linked `researchRunId`/snapshot, then querying BrainMesh messages by conversation or trace.

The crawler now runs as an adaptive research frontier rather than a fixed depth pass. It can:

- start from all configured broad queries and learned sources,
- read article bodies and extract company/entity/ticker leads,
- derive new Google/News searches from article titles, ownership/deal/product phrases, and entity names,
- follow high-relevance links,
- repeat until the frontier has no valuable links/searches left or the safety budgets are reached.

The terminal stream includes `entityLeads` and `generatedSearches` when new research points are spawned.

An autonomous agent creation run emits:

1. `agent.research.started`
2. Crawlee terminal events on the agent run status endpoint
3. `agent.profile.ready`
4. Optional `mesh.agent.linked` if the saved agent is attached to a board

Troubleshooting a weak personality model starts with the agent folder `agent.json`, then the agent research run terminal lines, then BrainMesh messages for the `agentResearchRunId`.

## Troubleshooting Playbooks

### A Brain Did Not Respond

1. `GET /api/brain-mesh/agents`
2. Confirm the target brain has the expected capability.
3. Send `POST /api/brain-mesh/ask` with `op: "mesh.status"`.
4. Check for `error` frames with the same `trace`.

### Candidate Appeared From Nowhere

1. Open the decision report evidence for the symbol.
2. Check if the signal has `discovery` or `chatResearch`.
3. Query BrainMesh for `candidate.discovery.ready`, `chat.research.ready`, and `preplan.ready`.
4. Verify whether `fromChat` or `fromCrawl` was true in the `preplan.ready` frame.

### Chat Research Polluted Sources

1. Query frames with `op = chat.research.ready`.
2. Review `sourceHints`.
3. In Settings -> Research URL memory, pause/block the source if needed.
4. The normal failed URL policy still applies: 10 failures retires non-manual sources.

### SSE Stream Disconnects Behind Proxy

1. Confirm Traefik does not buffer SSE responses.
2. Check the response headers:
   - `Content-Type: text/event-stream`
   - `Cache-Control: no-cache, no-transform`
   - `X-Accel-Buffering: no`
3. Reconnect with the same `conversationId` or `traceId` filter.

## Safety Rules

- Do not place trades directly from BrainMesh frames.
- Never put plaintext credentials in `body`.
- Do not include full article bodies unless required for debugging; send excerpts, hashes, counts, and source URLs.
- Keep `ttl` finite. Default `16`.
- Use `ctx.userId` for all user-specific frames.

## Extension Pattern

To add a new brain:

1. Register the agent:

```js
brainMesh.registerAgent({
  id: 'brain.agent.name',
  role: 'custom-agent',
  capabilities: ['mesh.status', 'custom.op'],
});
```

2. Register handlers:

```js
brainMesh.registerHandler('brain.agent.name', 'custom.op', async (envelope) => {
  return { ok: true, input: envelope.body };
});
```

3. Emit frames from the relevant service.
4. Optionally link it to a board:

```js
brainMesh.linkAgentToBoard({
  userId,
  agentId: 'brain.agent.name',
  boardId: 'agent-council',
  role: 'member',
});
```

5. Add the brain and operations to this spec.

## Versioning

`BMCL/1.0` is backward-compatible inside AutoTrader 1.x. Breaking changes require a new `proto` value and compatibility handling in `brainMeshService.validateEnvelope`.
