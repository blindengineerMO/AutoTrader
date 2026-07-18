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
- `brain.broker.alpaca.rules`: Alpaca trading-rule teacher for fractional-order and sizing guardrails.
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
- `source.catalog.list`
- `source.catalog.search`
- `source.catalog.pack`
- `source.catalog.share`
- `decision.analyst.gate.evaluate`
- `energy.eia.snapshot`
- `vehicle.sales.snapshot`
- `pricing.bls.snapshot`
- `commerce.census.retail.snapshot`
- `commerce.amazon.bestsellers.snapshot`
- `commerce.walmart.retail.snapshot`
- `market.alpaca.symbol.eligibility`
- `alpaca.rules.summary`
- `alpaca.rules.evaluate_order`
- `market.consumer-goods.industry.snapshot`
- `market.finra.fixed-income.snapshot`
- `market.sec.ownership.snapshot`
- `government.usaspending.awards.snapshot`
- `government.dod.contracts.snapshot`
- `defense.sipri.snapshot`
- `disaster.gdacs.snapshot`
- `disaster.eonet.snapshot`
- `disaster.reliefweb.snapshot`
- `disaster.emdat.snapshot`
- `disaster.usgs.earthquake.snapshot`
- `weather.nws.alerts.snapshot`
- `wildfire.nifc.snapshot`
- `drought.usdm.snapshot`
- `humanitarian.unhcr.refugees.snapshot`
- `crawler.search`
- `crawler.crawl`
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

### `source.catalog.list`

Recipient: `brain.research.source`

Returns compact SPEC/source-catalog records for BMCL-safe agent use. Optional body fields:
`ids`, `category`/`categories`, `tag`/`tags`, `limit`, `includeRequiredFields`, and `includeNotes`.

### `source.catalog.search`

Recipient: `brain.research.source`

Searches the SPEC/source catalog by query text and returns ranked source records, matching discovery
queries, and relevance terms. Agents use this to discover source methods such as SEC feeds, GDELT,
Google News RSS, issuer-paid newswire discovery, BLS CPI/average-price/PPI series, Census/FRED
housing series, Census MRTS/MARTS retail category series, Census M3/ADVM3 manufacturing activity
series, USDA ERS weekly retail food scanner-demand summaries, USDA AMS agricultural market
price/volume reports, USDA ERS food-price/expenditure products, EIA fuel/energy price-volume
series, BEA/FRED aggregate vehicle-sales series, FINRA fixed-income/corporate-agency bond
credit-risk evidence, SEC 13F/13D/13G ownership-filing evidence,
FINVIZ/TradingView/Yahoo/Nasdaq/MarketBeat/WallStreetZen scraped market
research pages, GDACS global disaster alerts, NASA EONET
natural-event/satellite-imagery metadata, ReliefWeb humanitarian disaster/report evidence,
UNHCR forced-displacement population statistics, EM-DAT/CRED historical disaster
impact/economic-loss evidence, and government
datasets without duplicating catalog knowledge.

### `source.catalog.pack`

Recipient: `brain.research.source`

Returns a compact source pack optimized for agent conversation. Supported built-in packs:
`housing`, `regulatory`, `discovery`, `market-screener`, `credit-risk`, `ownership`, `inflation`, `producer-prices`, `energy-fuel`,
`vehicle-sales`, `global-disasters`, `humanitarian`, `food-retail`, `food-prices`, `retail`,
`manufacturing`, `official`, and `safety`. Packs include source URLs, tags, evidence mode, BMCL use guidance,
discovery queries, relevance terms, and short conversation hints.

### `source.catalog.share`

Recipient: `brain.research.source`

Returns a shareable source pack payload for another BMCL conversation. This is intended for agent
council debates where one agent needs to expose the source set it is relying on. Issuer-paid channels
are marked `issuer-paid-verify-before-scoring`; undocumented aggregation channels are marked
`discovery-only-verify-with-primary-sources`; official/FRED/Census/SEC sources are marked
`official-primary-or-official-derivative`; Realtor.com listing-market research data is marked
`listing-market-not-completed-sales` so agents treat it as current for-sale listing conditions rather
than completed transaction prices; Redfin Data Center records are marked
`completed-sales-local-market` so agents can separate local completed-sale and transaction-market
evidence from listing-side asking-price conditions; CPSC consumer-product recall records are marked
`official-fixed-income-credit-market-risk` so agents share FINRA fixed-income/corporate-agency
bond evidence as official credit-market risk context covering yield-spread widening, falling bond
prices, distressed trading, downgrade risk, refinancing pressure, and equity-credit divergence;
`official-consumer-product-recall-risk` so agents share them as official safety-risk evidence covering
hazards, injuries, remedies, affected units, and repeat manufacturer/retailer exposure; openFDA food
enforcement records are marked `official-food-recall-enforcement-risk` so agents share FDA Recall
Enterprise System food recall data with classification, recalling-firm, distribution-pattern, product
quantity, and reason-for-recall context; USDA FSIS meat, poultry, and egg recall records are marked
`official-meat-poultry-egg-recall-risk` so agents share establishment-number, pounds-recalled,
classification, health-risk, geography, and retail-distribution evidence for operational and brand
risk scoring; NHTSA vehicle and automotive-equipment recall records are marked
`official-vehicle-recall-risk` so agents share campaign-number, affected-vehicle, component,
defect-summary, consequence, remedy, completion, and brand-quality evidence for auto-sector scoring;
FINVIZ, TradingView, Yahoo Finance, Nasdaq, MarketBeat, and WallStreetZen public market research records are marked
`scraped-market-screener-verify-before-trading` so agents share delayed/scraped market activity,
earnings/IPO catalysts, analyst research, broker upgrades/downgrades, price-target changes,
consensus forecasts, Zen Ratings, component grades, quantitative ratings, institutional holdings, insider activity, market movers, volume anomalies, and
technical/fundamental screen evidence only as corroborating research that must be verified against
original broker notes where available, broker quotes, Finnhub, SEC filings, Nasdaq
Trader/security-master data, and official sources before trading;
BLS CPI and average-price records are marked `official-consumer-price-inflation-series` so agents
share category index movement, selected-product dollar prices, energy/food sensitivity, footnotes, and
API limit/key context as price/inflation evidence rather than unit-sales volume; BLS PPI records are
marked `official-producer-price-inflation-series` so agents share producer selling prices, final and
intermediate demand, input costs, wholesale trends, industry margins, product-category inflation, and
price pass-through separately from CPI; EIA fuel and energy records are marked
`official-energy-fuel-price-volume-series` so agents share gasoline and diesel prices, petroleum
product supplied, retail/supplier fuel volumes, refinery output, inventories/stocks, electricity
sales/prices, natural-gas sales/prices, geography/PADD/state/city, units, frequency, and release-date
evidence, using configured `eia` API credentials when available and public EIA pages, XLS/CSV
downloads, or bulk files otherwise; BEA/FRED vehicle-sales records are marked
`official-vehicle-sales-aggregate-series` so agents share BEA/FRED total, light-vehicle, and
domestic-auto sales observations, SAAR units, revision assumptions, and aggregate auto-demand
momentum without treating them as manufacturer/model registration records; GDACS global disaster
records are marked `official-global-disaster-alert-series` so agents share alert level, event type,
severity, estimated population exposure, country/ISO3, GeoRSS geometry, CAP/report URLs, and update
time before scoring local operational, supply-chain, insurance, travel, utility, or recovery-spend
exposure; NASA EONET records are marked `official-natural-event-satellite-metadata-series` so agents
share natural-event category, open/closed status, latest geometry, magnitude, source URLs, and latest
observation dates before scoring local facility, customer-market, supply-chain, agriculture, aviation,
insurance, utility, logistics, or recovery-spend exposure; ReliefWeb records are marked
`curated-humanitarian-disaster-report-series` so agents share country/region, disaster type, source
organization, report theme, casualty/displacement/aid signals, conflict context, dates, and company
location/customer/supply-chain overlap before scoring logistics, insurers, defense, healthcare, food,
utilities, infrastructure, construction, or recovery-spend exposure; EM-DAT/CRED records are marked
`historical-disaster-impact-loss-series` so agents share historical disaster-impact, human-impact,
economic-loss, country/type/date, and access-term evidence for long-run exposure modeling without
treating it as a live alert feed; UNHCR Refugee Statistics records are marked
`official-forced-displacement-population-series` so agents share official annual refugee,
asylum-seeker, internally displaced, stateless, origin-country, host-country, demographics, and
solutions evidence before scoring country-exposed defense/security, healthcare, shelter, food,
logistics, insurers, banks, border-policy, or aid-demand effects; Census MRTS/MARTS retail records are marked
`official-retail-demand-category-series` so agents share official category-level sales, inventory,
inventory-to-sales, seasonality, and advance-vs-final revision evidence without treating the data as
UPC-level product sales; Census M3/ADVM3 manufacturing records are marked
`official-manufacturing-demand-supply-series` so agents share shipments, new orders, unfilled orders,
inventories, sector/category, seasonality, and advance-vs-full revision evidence as upstream
demand/supply-chain context rather than store-level retail sales; USDA ERS Weekly Retail Food Sales
records are marked `official-food-retail-scanner-demand-series` so agents share public
category-level scanner-demand evidence for grocery/food demand, dollars, unit sales, shares,
year-over-year/3-year changes, seasonality, pandemic/recession effects, and geography limits without
treating the public files as unrestricted UPC/transaction-level scanner data or using removed
volume-sales fields; USDA AMS Market News and MyMarketNews records are marked
`official-agricultural-market-price-volume-series` so agents share official agricultural commodity
price, volume, sales/movement, wholesale, retail, shipping, commodity, grade/unit, market-location,
and report-date evidence, using configured `usda-ams` API credentials for large MyMarketNews pulls
when available and public report pages otherwise; USDA ERS food-price records are marked
`official-food-price-expenditure-series` so agents share food CPI/PPI forecasts, food expenditures,
food-dollar/farm-to-retail spread context, regional food-at-home prices, mean unit values, price
indexes, food groups, methodology/revision notes, and coverage-window caveats before scoring
affordability, input-cost, demand, or margin effects.

### `decision.analyst.gate.evaluate`

Recipient: `brain.evaluation`

Evaluates analyst recommendation evidence using the practical decision rule from `DECISION.md`.
Agents use this during research, Agent Council debate, daily self-improvement, and board analysis
whenever an analyst upgrade, Buy rating, consensus page, or price-target change influences a thesis.

Request body:

```json
{
  "candidate": {
    "symbol": "AAPL",
    "localAiScore": 72,
    "volatilityPct": 2.1,
    "changePct": 0.8
  },
  "quote": { "current": 210.12 },
  "marketBeatIntel": { "signals": [] },
  "yahooFinanceIntel": { "signals": [] },
  "nasdaqIntel": { "signals": [] },
  "factorIntel": { "secFilingFactor": { "score": 72, "latestForm": "10-Q" } },
  "secOwnershipIntel": { "compositeScore": 64 }
}
```

Reply body:

```json
{
  "version": "analyst-decision-gate-v1",
  "symbol": "AAPL",
  "analystDriven": true,
  "passed": false,
  "status": "analyst-evidence-blocked",
  "compositeScore": 52,
  "directBuyAllowed": false,
  "summary": "Analyst evidence is not sufficient for a buy candidate yet.",
  "gates": [
    { "key": "analyst-upgrade-detected", "passed": true },
    { "key": "newly-issued-recommendation", "passed": true },
    { "key": "material-estimate-or-target-change", "passed": false },
    { "key": "analyst-historically-credible", "passed": true },
    { "key": "sec-filing-data-supports-thesis", "passed": true },
    { "key": "valuation-still-attractive", "passed": false },
    { "key": "liquidity-and-portfolio-risk-checks", "passed": true }
  ]
}
```

Protocol rule: a passed analyst gate only permits continued full-tree evaluation. It never authorizes
live or simulated orders on its own, and failed gates must keep analyst-driven ideas in hold/watch or
further-research status.

### `energy.eia.snapshot`

Recipient: `brain.research.source`

Returns a compact EIA energy/fuel snapshot for BMCL-safe agent use. The handler uses the configured
Settings `eia` provider API key or `EIA_API_KEY` for EIA API v2 pulls when available, and falls back
to the public Gasoline and Diesel Fuel Update page when no key exists or public fuel context is needed.
The reply includes `apiConfigured`, `fallbackUsed`, latest gasoline/diesel/API series observations,
opportunity/risk/energy-price/shipping/consumer-fuel pressure scores, source URLs, limited failures,
and a short BMCL use note. Optional body field: `timeoutMs`, clamped between 1500 and 15000 ms.

Agents use this operation when they need fresh official fuel-cost context for logistics, airlines,
trucking, utilities, refiners, chemicals, retailers, restaurants, EVs, consumer discretionary, or
energy-sector debate without moving full EIA archives through the mesh.

### `vehicle.sales.snapshot`

Recipient: `brain.research.source`

Returns a compact BEA/FRED aggregate vehicle-sales snapshot for BMCL-safe agent use. The handler
tracks whether the configured Settings `bea` provider API key or `BEA_API_KEY` exists, uses direct
FRED CSV series for repeatable no-key execution, and keeps BEA iTable/API URLs in the source list for
official verification and future direct BEA pulls. The reply includes `beaApiConfigured`,
`beaDirectApiUsed`, `fredCsvUsed`, latest `TOTALSA`, `ALTSALES`, and `DAUTOSAAR` observations,
monthly and year-over-year momentum, opportunity/risk/demand scores, source URLs, limited failures,
and a short BMCL use note. Optional body field: `timeoutMs`, clamped between 1500 and 15000 ms.

Agents use this operation when they need aggregate auto-demand context for automakers, EV makers,
auto suppliers, dealers, fleet/rental firms, auto finance, insurers, logistics, energy, or consumer
discretionary debate. It is aggregate industry volume only, not manufacturer/model registration data.

### `pricing.bls.snapshot`

Recipient: `brain.research.source`

Returns a compact official BLS pricing and inflation snapshot for BMCL-safe agent use. The handler
uses the configured Settings `bls` provider API key or `BLS_API_KEY` / `BLS_REGISTRATION_KEY` as the
optional BLS `registrationkey`; when no key is configured it still uses the public v2 endpoint at
lower unauthenticated limits. Optional body fields: `timeoutMs`, clamped between 1500 and 20000 ms;
`startYear`; `endYear`; and `seriesIds`, defaulting to the application-maintained CPI,
average-price, and PPI pack.

The reply includes provider/caveat metadata, API-key status, BLS source URLs, limited failures,
selected series, row/series counts, latest observations, month-over-month and year-over-year changes,
consumer-inflation score, selected average-price pressure score, producer-cost pressure score,
margin-pressure score, affordability-risk score, and a compact BMCL use note.

Agents use this operation when they need official consumer pricing, selected actual-dollar-price, and
producer selling-price evidence for household furnishings, appliances, cleaning-adjacent household
products, personal-care/apparel themes, vehicles, recreational goods, food products, manufacturer
input-cost pressure, pricing power, affordability risk, and margin pressure. CPI is price-index
movement, average-price data is limited selected-product dollar-price evidence, and PPI is producer
selling-price evidence. None of these are unit-sales volume, SKU/store-level sales, or
company-specific revenue.

### `commerce.census.retail.snapshot`

Recipient: `brain.research.source`

Returns a compact Census retail/trade snapshot for BMCL-safe agent use. The handler uses the
configured Settings `census-retail` provider API key or `CENSUS_API_KEY` for Census EITS data pulls.
When no key is configured, it still returns source and variable metadata context and explains that row
data was skipped. Optional body fields: `timeoutMs`, clamped between 1500 and 20000 ms; `startTime`
such as `2025-01`; `geography`, defaulting to `us`; `datasets`, defaulting to `mrts`, `marts`, and
`mtis`; and `includeData`, which can be set to `false` for metadata-only source sharing.

The reply includes provider/caveat metadata, API-key status, source URLs, limited failures, dataset
summaries, selected variables, latest periods, row/series counts, top latest-vs-prior series,
retail-demand score, inventory-pressure score, demand-slowdown score, consumer-bias label, and the
Annual Retail Trade Survey / Annual Integrated Economic Survey source context.

Agents use this operation when they need official category-level retail demand, advance retail-sales,
combined retail/wholesale/manufacturing sales-inventory, excess-inventory, supply-shortage, annual
retail sales, e-commerce sales, gross-margin, operating-expense, or merchandise-line context. This is
category or aggregate evidence only. It must not be treated as UPC-level, store-level, or
company-specific sales data.

### `commerce.amazon.bestsellers.snapshot`

Recipient: `brain.research.source`

Returns a compact scraped Amazon Best Sellers and Movers & Shakers product-rank snapshot for
BMCL-safe agent use. Optional body fields: `timeoutMs`, clamped between 1500 and 20000 ms; `limit`,
clamped between 1 and 100; `sourceIds` or `categories`, matching source IDs such as
`home-kitchen`, `household-supplies`, `kitchen-dining`, `laundry-supplies`, `cleaning-tools`,
`all-purpose-cleaners`, or `movers-shakers`; and `includeMovers`, defaulting to `true`.

The reply includes provider/caveat metadata, source URLs, limited failures, product-rank signal
counts, category summaries, product-momentum score, stable-demand score, acceleration score, top
products, fastest movers, and compact product fields such as rank, ASIN when visible, title,
brand hint, category, price, rating/review count when visible, rank-gain percentage when visible,
and source/product URLs.

Agents use this operation to detect consumer-demand themes, rapid storefront rank acceleration,
brand/product leads, household, kitchen, cleaning, CPG, ecommerce, logistics, and retail signals. It
is scraped Amazon storefront evidence only. It must not be treated as absolute sales volume, revenue,
market share, UPC scanner data, or company-specific financial performance, and should be
corroborated with Census retail/trade, USDA/BLS, company filings, independent news, broker/Finnhub,
and verified brand-to-company mappings before influencing decisions.

### `commerce.walmart.retail.snapshot`

Recipient: `brain.research.source`

Returns a compact scraped Walmart bestseller, trending, category, price, review, availability, and
low-stock product-demand snapshot for BMCL-safe agent use. Optional body fields: `timeoutMs`,
clamped between 1500 and 20000 ms; `limit`, clamped between 1 and 100; `sourceIds` or `categories`,
matching source IDs such as `household-supply-bestsellers`, `home-bestsellers`,
`top-100-home-trending`, `cleaning-supplies`, or `cleaning-sponges-bestsellers`; and
`includeTrending`, defaulting to `true`.

The reply includes provider/caveat metadata, source URLs, limited failures, product-demand signal
counts, category summaries, product-demand score, trend-acceleration score, availability-pressure
score, top products, trending products, low-stock products, and compact product fields such as rank,
Walmart product ID when visible, title, brand hint, category, price, unit price, rating/review count
when visible, “bought since yesterday” labels when visible, availability/low-stock labels, and
source/product URLs.

Agents use this operation to detect consumer-demand themes, retail velocity hints, home/household
and cleaning-product leads, ecommerce demand, and availability pressure. It is scraped Walmart
storefront evidence only. It must not be treated as audited sales figures, absolute sales volume,
revenue, market share, UPC scanner data, or company-specific financial performance, and should be
corroborated with Census retail/trade, scanner summaries, USDA/BLS, company filings, independent
news, broker/Finnhub, and verified brand-to-company mappings before influencing decisions.

### `market.alpaca.symbol.eligibility`

Recipient: `brain.research.source`

Returns a compact Alpaca asset/tradability decision before agents spend Finnhub, crawler, or board
debate budget on a symbol. Request body supports either a known symbol plus optional company name:

```json
{
  "symbol": "AAPL",
  "companyName": "Apple Inc."
}
```

or a company/name-only lookup:

```json
{
  "companyName": "Example Company"
}
```

The handler uses the caller's `ctx.userId` to read Alpaca credentials and user Settings exclusions.
Reply body includes `provider`, `version`, `eligibility`, `excludedSymbols`, and `bmclUse`.
`eligibility` includes fields such as `eligible`, `symbol`, `companyName`, `reason`, `degraded`,
and compact Alpaca `asset` metadata when available.

If Alpaca explicitly reports the asset missing, inactive, or non-tradable, the system persists the
symbol to user Settings exclusions and agents must skip watcher creation, scoring, and trading for
that symbol. If Alpaca is not configured or transiently unavailable, the response may be
`eligible: true` with `degraded: true`; agents may continue simulation/research and use
Finnhub/web-scrape enrichment, but reports should disclose that Alpaca tradability was not confirmed.

### `alpaca.rules.summary`

Recipient: `brain.broker.alpaca.rules`

Returns the current user-scoped Alpaca trading-rule summary for agent education and strategy
planning. The handler reads `ctx.userId` Settings and returns:

```json
{
  "provider": "alpaca",
  "version": "alpaca-rules-v1",
  "docUrl": "https://docs.alpaca.markets/us/docs/fractional-trading",
  "fractionalTradingEnabled": true,
  "fractionalMinNotionalUsd": 1,
  "maxBuyOrderNotionalUsd": 100,
  "rules": ["..."],
  "agentGuidance": "..."
}
```

Agents use this operation before proposing fractional quantities, interpreting Alpaca broker
constraints, or teaching a newly created personality agent how the app executes. Fractional
quantities are planning hints only; BrainMesh never submits broker orders directly.

### `alpaca.rules.evaluate_order`

Recipient: `brain.broker.alpaca.rules`

Evaluates a proposed order shape against the app's Alpaca rules without placing an order. Request
body:

```json
{
  "symbol": "AAPL",
  "side": "buy",
  "quantity": 0.25,
  "price": 20,
  "asset": {
    "tradable": true,
    "fractionable": true
  }
}
```

The reply includes `allowed`, `failed`, `warnings`, `notionalUsd`, `fractional`, and the embedded
rules summary. Current guardrails:

- Fractional quantities require Settings `fractionalTradingEnabled` and Alpaca asset metadata
  `fractionable: true`.
- Quantities may use at most 9 decimal places.
- The app uses quantity-based market/day Alpaca orders and does not mix `qty` with `notional`.
- Fractional short sales are not allowed; fractional sells must be long sells against owned
  positions.
- The configured max buy per order notional applies equally to whole-share and fractional-share
  buy orders.
- Fractional orders are still subject to cash, kill-switch, trade-count, and portfolio checks in
  the trading rules engine and broker execution path.

### `market.consumer-goods.industry.snapshot`

Recipient: `brain.research.source`

Returns a compact scraped consumer-goods and household/personal-products industry discovery
snapshot for BMCL-safe agent use. Optional body fields: `timeoutMs`, clamped between 1500 and
20000 ms; `limit`, clamped between 1 and 100; and `sourceIds`/`providers`/`categories`, matching
source IDs or providers such as `stockanalysis-household-personal-products`,
`yahoo-household-personal-products`, `companiesmarketcap-consumer-goods-revenue`,
`fortune-500`, `stockanalysis`, `yahoo-finance`, `companiesmarketcap`, or `fortune`.

The reply includes provider/caveat metadata, source URLs, limited failures, signal counts, unique
symbol counts, household/personal-product counts, revenue-ranked counts, industry score, revenue
leadership score, valuation coverage score, source summaries, top companies, household/personal
product companies, revenue leaders, and compact company fields such as rank, ticker, company name,
source, market cap, revenue, profit, P/E, dividend yield, visible price/change, source URL, and
company URL.

Agents use this operation to identify public CPG, home-care, personal-care, consumer-defensive, and
large revenue-ranked companies for deeper research and self-improvement. It is scraped
industry/ranking evidence only. It must not be treated as primary filings, broker-grade quotes,
real-time portfolio data, product-level sales, or direct company sales attribution. Corroborate with
SEC filings, company reports, broker/Finnhub quotes, BLS/Census/Amazon/Walmart demand proxies,
independent news, and verified ticker mappings before scoring or trading.

### `market.nasdaq.research.snapshot`

Recipient: `brain.research.source`

Returns a compact Nasdaq public market-research snapshot for BMCL-safe agent use. The handler
scrapes/parses Nasdaq main market activity, stocks, earnings-calendar, and IPO-calendar pages, and can
optionally collect compact company-page snippets for analyst research, institutional holdings, and
insider activity. Optional body fields: `timeoutMs`, clamped between 1500 and 15000 ms; `limit`,
clamped between 1 and 50; `screenIds`; `includeCompanyPages`; and `companySymbols`/`symbols`.

The reply includes provider/caveat metadata, signal counts, top signals, earnings catalysts, IPO
catalysts, optional company page snippets, opportunity/risk/catalyst scores, source URLs, limited
failures, and a short BMCL use note.

Agents use this operation when they need Nasdaq market overview, stock activity, earnings-calendar,
IPO-calendar, analyst-research, institutional-holdings, or insider-activity evidence for candidate
discovery, self-improvement, council debate, or report citations. Nasdaq public pages are treated as
scraped/delayed research context and must be corroborated with broker quotes, Finnhub, SEC filings,
GDELT/Google News, Nasdaq Trader/security-master data, and other primary sources before influencing a
live order.

### `market.marketbeat.analyst.snapshot`

Recipient: `brain.research.source`

Returns a compact MarketBeat public analyst-research snapshot for BMCL-safe agent use. The handler
scrapes/parses MarketBeat analyst ratings, upgrades, downgrades, and price-target-change pages, and
can optionally collect compact per-symbol consensus forecast snippets. Optional body fields:
`timeoutMs`, clamped between 1500 and 15000 ms; `limit`, clamped between 1 and 50; `screenIds`;
`includeConsensusPages`; and `companySymbols`/`symbols`.

The reply includes provider/caveat metadata, analyst/broker-action counts, top positive and negative
actions, price-target changes, optional consensus forecast snippets, opportunity/risk/target/
consensus scores, source URLs, limited failures, and a short BMCL use note.

Agents use this operation when they need analyst recommendation, broker upgrade/downgrade,
price-target revision, analyst-firm, previous-rating/new-rating, previous-target/new-target, or
consensus forecast evidence for candidate discovery, self-improvement, council debate, or report
citations. MarketBeat public pages are treated as scraped/delayed summary context and must be
corroborated with original broker notes where available, broker quotes, Finnhub/company research, SEC
filings, GDELT/Google News, Nasdaq Trader/security-master data, and other primary sources before
influencing a live order.

### `market.wallstreetzen.snapshot`

Recipient: `brain.research.source`

Returns a compact WallStreetZen public quantitative-rating snapshot for BMCL-safe agent use. The
handler scrapes/parses WallStreetZen stock-screener and stock-ratings pages, and can optionally
collect compact per-symbol ticker analysis snippets. Optional body fields: `timeoutMs`, clamped
between 1500 and 15000 ms; `limit`, clamped between 1 and 50; `screenIds`;
`includeTickerPages`; and `companySymbols`/`symbols`.

The reply includes provider/caveat metadata, signal/rated/ticker-page counts, top rated/positive/
negative rows, optional ticker summaries, quant/opportunity/risk scores, source URLs, limited
failures, and a short BMCL use note.

Agents use this operation when they need WallStreetZen Zen Rating, stock screener, stock-ratings,
component-grade, fair-value, valuation, financial, industry-rating, or ticker-analysis evidence for
candidate discovery, self-improvement, council debate, or report citations. WallStreetZen public
pages are treated as scraped/delayed vendor summary context and must be corroborated with SEC/company
filings, broker/Finnhub quotes, Nasdaq Trader/security-master data, GDELT/Google News, and other
primary sources before influencing a live order.

### `market.finra.fixed-income.snapshot`

Recipient: `brain.research.source`

Returns a compact FINRA fixed-income and corporate/agency bond snapshot for BMCL-safe agent use. The
handler fetches FINRA public market-data pages, parses visible corporate bond/security rows when
server-rendered, and always includes the official source list and caveats. Optional body fields:
`timeoutMs`, clamped between 1500 and 15000 ms; `limit`, clamped between 1 and 80; and `sourceIds`
from `finra-data-portal`, `finra-fixed-income`, `finra-corp-agency-bonds`, or
`finra-corp-agency-trade-activity`.

The reply includes provider/caveat metadata, fixed-income page/source availability, trade-signal
counts, top credit weakness/strength rows, credit-stress score, refinancing-pressure score,
equity-credit-divergence score, opportunity/risk scores, source URLs, limited failures, and a short
BMCL use note.

Agents use this operation when they need official credit-market evidence for yield-spread widening,
falling bond prices, distressed trading, downgrade/watch risk, refinancing pressure, or divergence
between equity optimism and credit weakness. FINRA fixed-income evidence must be mapped from issuer
or security identifier to equity ticker before candidate scoring or council recommendations.

### `market.sec.ownership.snapshot`

Recipient: `brain.research.source`

Returns a compact official SEC ownership-filing snapshot for BMCL-safe agent use. The handler fetches
the current SEC 13F-HR, Schedule 13D, and Schedule 13G Atom feeds using the configured SEC EDGAR
User-Agent. Optional body fields: `timeoutMs`, clamped between 1500 and 15000 ms; `limit`, clamped
between 1 and 160; `feedTypes` or `formTypes` from `13F-HR`, `SC 13D`, `SC 13G`, or matching source
IDs; and `includeDetails`, which attempts limited filing/detail parsing for richer but slower
evidence.

The reply includes provider/caveat metadata, source URLs, limited failures, entry/form counts,
activist/passive/institutional signal counts, new-position and reduction counts, top activist
signals, top institutional signals, top beneficial owners, top reductions, activist-pressure score,
institutional-demand score, concentration-risk score, opportunity/risk scores, and a short BMCL use
note.

Agents use this operation when they need official evidence for hedge-fund or institutional manager
positioning, new institutional positions, position increases/reductions, activist stakes, passive
large beneficial owners, or concentrated ownership. 13F holdings are delayed and do not reveal
real-time current positions; all 13F/13D/13G evidence must be verified against the filing document and
mapped from issuer/filer metadata to equity ticker before candidate scoring or council recommendations.

### `government.usaspending.awards.snapshot`

Recipient: `brain.research.source`

Returns a compact USAspending federal awards/contracts snapshot for BMCL-safe agent use. The handler
uses the public no-auth USAspending Advanced Search API, primarily
`/api/v2/search/spending_by_award/`, with optional award-type counts from
`/api/v2/search/spending_by_award_count/`. Optional body fields: `timeoutMs`, clamped between 1500
and 20000 ms; `limit`, clamped between 1 and 100; `page`; `dateRange`; `recipientNames` or
`contractor`; `awardingAgency`; `fundingAgency`; `awardType` (`contracts` by default); `country` or
`placeOfPerformanceCountry`; `pscCodes`; `naicsCodes`; `keywords`; and `includeCounts`.

The reply includes provider/caveat metadata, source URLs, limited failures, returned/total award
counts, returned obligated amount, award-type counts, top recipients/countries/agencies, top awards,
government-demand score, defense-demand score, infrastructure-demand score, conflict-exposure score,
opportunity/risk scores, and compact conflict-inference rows.

Agents use this operation when they need official federal-spending evidence for contractor revenue
catalysts, Department of Defense or military-branch exposure, infrastructure awards, agency-budget
signals, place-of-performance geography, PSC/NAICS product/service demand, or government-demand
momentum. USAspending does not prove that a Pentagon contract is tied to one specific war. Any
war/conflict association must be explicitly labeled as inferred unless corroborated by contract
documents, contracting command, place of performance, appropriation account, task order, budget
records, or independent reporting.

### `government.dod.contracts.snapshot`

Recipient: `brain.research.source`

Returns a compact DoD/War.gov daily major contract-announcement snapshot for BMCL-safe agent use. The
handler fetches the public Contract Announcements RSS feed, follows recent announcement detail pages,
and can optionally fetch targeted search pages before parsing rows. Optional body fields: `timeoutMs`,
clamped between 1500 and 20000 ms; `limit`, clamped between 1 and 80; `searchTerms`, `search`,
`contractor`, or `query`; and `includeDetails`, which defaults to `true`.

The reply includes provider/caveat metadata, source URLs, limited failures, announcement/contract
counts, total announced value, top contractors, top branches, top locations, top contracts,
defense-demand score, innovation-demand score, foreign-exposure score, opportunity/risk scores, and
compact conflict-inference rows when the text references foreign military/security or conflict
geography.

Agents use this operation when they need official major-contract evidence for near-term defense
revenue catalysts, contracting activity, product/service demand, place of performance, funding
source, expected completion date, strategic technology demand, or contractor follow-up. Daily
announcements are threshold-limited to major awards and omit smaller contracts, so agents should pair
this source with USAspending for broader coverage and verify parent-company/ticker mapping plus
revenue materiality before candidate scoring or council recommendations.

### `defense.sipri.snapshot`

Recipient: `brain.research.source`

Returns compact SIPRI military and arms data context for BMCL-safe agent use. The handler fetches the
SIPRI database directory plus the military expenditure, arms transfers, arms-transfer methodology,
arms industry, financial-value, and embargo pages when available, then falls back to static dataset
definitions when a page is temporarily unavailable. Optional body fields: `timeoutMs`, clamped between
1500 and 20000 ms, and `includePages`, which defaults to `true`.

The reply includes provider/caveat metadata, source URLs, limited failures, dataset summaries,
coverage notes, required fields, observed page signals, measure distinctions, and analysis rules.
Supported dataset measures include military expenditure, arms-transfer volume/TIV, arms-company
revenue, financial value of the arms trade, arms embargoes, peace operations, and nuclear-force
geopolitical context.

Agents use this operation when they need strategic defense-budget, arms-flow, arms-industry,
embargo/regulatory, peace-operation, nuclear-force, or geopolitical military context. SIPRI measures
are not interchangeable: military expenditure is country spending, arms transfers are cross-border
major-weapons transfer volume, arms-company revenue is company arms/military-services revenue, and a
contract award value is a separate USAspending or DoD/War.gov field. SIPRI TIV is a volume indicator,
not a financial price, and must not be compared directly with GDP, military expenditure, company
sales, financial arms-trade values, or government contract awards.

### `disaster.gdacs.snapshot`

Recipient: `brain.research.source`

Returns a compact GDACS global disaster alert snapshot for BMCL-safe agent use. The handler uses the
public GDACS RSS/GeoRSS feed as the no-key executable path and keeps the GDACS API docs, OpenAPI
specification, feed reference, 24-hour feed, and all-events feed in the source list. The reply
includes `eventCount`, `highImpactCount`, alert/event-type counts, estimated population exposure,
top events, disaster/supply-chain/insurance/recovery scores, source URLs, limited failures, and a
short BMCL use note. Optional body fields: `timeoutMs`, clamped between 1500 and 15000 ms, and
`feedUrl` for a specific GDACS feed.

Agents use this operation when they need near-real-time global disaster context for earthquakes,
tropical cyclones, floods, wildfires, droughts, volcanoes, tsunamis, cross-border disaster
monitoring, exposed-population screening, utility/travel/logistics disruption, insurance losses, or
recovery/rebuilding tailwinds. GDACS estimates are preliminary and must be localized against company
facilities, customer markets, routes, and supply chains.

### `disaster.eonet.snapshot`

Recipient: `brain.research.source`

Returns a compact NASA EONET natural-event snapshot for BMCL-safe agent use. The handler collects the
public no-key current-open events endpoint, a configurable recent-events window, and category
metadata. The reply includes `eventCount`, `openEventCount`, `highImpactCount`, category counts,
top events, natural-event/wildfire/storm-flood/aviation-visibility/agriculture-drought/recovery
scores, source URLs, limited failures, category metadata, and a short BMCL use note. Optional body
fields: `timeoutMs`, clamped between 1500 and 15000 ms; `days`, clamped between 1 and 365; and
`limit`, clamped between 1 and 250.

Agents use this operation when they need continuously updated natural-event and satellite-imagery
metadata for wildfires, severe storms, volcanoes, floods, drought, dust/haze, sea/lake ice,
landslides, or extreme temperatures. EONET observations must be localized against company facilities,
customer markets, retail footprints, logistics routes, suppliers, crop exposure, aviation routes,
insured assets, utilities, and recovery/rebuilding demand before influencing trade recommendations.

### `disaster.reliefweb.snapshot`

Recipient: `brain.research.source`

Returns a compact ReliefWeb humanitarian disaster/report snapshot for BMCL-safe agent use. The handler
collects the ReliefWeb disasters and reports endpoints through the configured Settings
`reliefweb.appName` or `RELIEFWEB_APP_NAME`. The reply includes `appConfigured`, `disasterCount`,
`reportCount`, disaster-type counts, country counts, report-theme counts, conflict/displacement/
casualty/aid/infrastructure/food-health signals, humanitarian-impact/crisis-severity/aid-requirement/
infrastructure-recovery/supply-chain-disruption scores, top disaster records, top report records,
source URLs, limited failures, and a short BMCL use note. Optional body fields: `timeoutMs`, clamped
between 1500 and 15000 ms, and `limit`, clamped between 1 and 100.

Agents use this operation when they need humanitarian impact evidence for casualty/displacement
reports, aid requirements, situation reports, conflict-related emergencies, government/NGO response
activity, access disruption, food/health/shelter risk, or recovery demand. ReliefWeb API pulls require
a pre-approved appName; missing or rejected app names must be treated as source unavailability rather
than a research failure.

### `humanitarian.unhcr.refugees.snapshot`

Recipient: `brain.research.source`

Returns a compact UNHCR Refugee Statistics snapshot for BMCL-safe agent use. The handler uses the
UNHCR `population/v1/years`, `population`, and `countries` endpoints, preserves the Refugee Data
Finder and API documentation URLs in the source list, and walks backward from the advertised latest
year until it finds a non-empty population aggregate. The reply includes `latestYear`, forced
displacement/persons-of-concern totals, refugee/asylum/IDP/stateless counts, top country-of-origin
rows, top host-country rows, origin/host concentration, displacement/refugee-asylum/IDP/statelessness
scores, aid-demand, shelter/infrastructure-demand, healthcare-demand, logistics/access-risk, and
border-policy-risk scores, source URLs, limited failures, and a BMCL use note. Optional body fields:
`timeoutMs`, clamped between 1500 and 15000 ms; `year`; and `limit`, clamped between 25 and 1000.

Agents use this operation when they need official forced-displacement population evidence for
refugees, asylum seekers, internally displaced people, stateless populations, country-of-origin
trends, host-country trends, demographics, solutions, aid demand, border-policy pressure, and
location-aware company exposure. The signal must be localized against company offices, retail
footprints, suppliers, logistics routes, customer markets, government-contract exposure, insurance
books, and banking/credit exposure before it influences a trade recommendation.

### `disaster.emdat.snapshot`

Recipient: `brain.research.source`

Returns a compact EM-DAT/CRED historical disaster-impact snapshot for BMCL-safe agent use. The handler
uses public HDX CKAN APIs for CRED/EM-DAT dataset discovery and keeps EM-DAT home, public portal,
documentation, HDX organization, package-search, and organization API URLs in the source list. The
reply includes `datasetCount`, `registeredAccessRequired`, CRED organization metadata, disaster-type
signals, historical-impact/economic-loss/human-impact/climate-backtest/data-access-friction scores,
top dataset/package records, source URLs, limited failures, and a short BMCL use note. Optional body
fields: `timeoutMs`, clamped between 1500 and 15000 ms, and `limit`, clamped between 1 and 100.

Agents use this operation when they need historical disaster impact evidence for country, disaster
type/subtype, start/end date, deaths, injuries, affected/displaced population, economic damage,
international assistance, insurance loss, infrastructure exposure, agricultural exposure, logistics
disruption, utility hardening, travel risk, or recovery-spend backtesting. EM-DAT is historical
modeling evidence, not a live alert feed. Detailed downloads may require free registration and are
subject to EM-DAT usage terms; agents must keep those terms visible before using or redistributing
row-level data.

### `disaster.usgs.earthquake.snapshot`

Recipient: `brain.research.source`

Returns a compact USGS Earthquake Catalog and real-time GeoJSON feed snapshot for BMCL-safe agent
use. The handler uses the no-key FDSN event query endpoint for a configurable rolling query and the
USGS magnitude 2.5+ past-day GeoJSON feed as a near-real-time companion. The source list also keeps
the API documentation, query endpoint, 30-day magnitude 4.5+ example, bounding-box example, real-time
GeoJSON feed index, all-hour feed, magnitude 2.5+ day feed, and CSV feed documentation. Optional body
fields: `timeoutMs`, clamped between 1500 and 15000 ms; `days`, clamped between 1 and 365;
`minMagnitude`, clamped between 0 and 10; `limit`, clamped between 1 and 2000; and `bbox` with
`minlatitude`, `maxlatitude`, `minlongitude`, and `maxlongitude`.

The reply includes event counts, magnitude buckets, high-magnitude counts, shallow high-magnitude
counts, tsunami count, PAGER alert counts, max/average magnitude, earthquake/supply-chain/
infrastructure/tsunami/insurance/recovery scores, top event records, source URLs, limited failures,
and a short BMCL use note.

Agents use this operation when they need official seismic-risk evidence for company offices,
factories, retail footprints, ports, suppliers, logistics lanes, utility infrastructure, refineries,
semiconductor fabs, insurers, real estate, construction demand, or recovery-spend debates. USGS
earthquake evidence must be localized against company facilities, customer markets, supply chains, and
regional exposure before influencing recommendations.

### `weather.nws.alerts.snapshot`

Recipient: `brain.research.source`

Returns a compact National Weather Service active-alert snapshot for BMCL-safe agent use. The handler
uses `https://api.weather.gov/alerts/active` by default and supports the official active-alert filters
agents need for localized research: `area` for state/territory codes, `point` for latitude/longitude,
and `event` for specific weather products such as `Tornado Warning`. Optional body fields:
`timeoutMs`, clamped between 1500 and 15000 ms; `area`; `point`; `event`; and `limit`, clamped between
1 and 500.

Requests send an identifying User-Agent from Settings `nws-weather.userAgent`,
`NWS_USER_AGENT`/`NOAA_USER_AGENT`, or a fallback AutoTrader research identifier. The reply includes
whether a custom User-Agent was configured, active alert counts, severe/high-impact counts,
event/severity/urgency/certainty counts, weather-alert/logistics/utility/agriculture/insurance/
retail-foot-traffic/recovery scores, top alert records, source URLs, limited failures, and a short
BMCL use note.

Agents use this operation when they need official current U.S. warnings, watches, advisories, and
emergency weather evidence for company offices, stores, warehouses, factories, ports, utility assets,
agricultural regions, customer markets, supplier sites, and logistics lanes. NWS alert evidence must
be localized against company exposure before influencing trade recommendations.

### `wildfire.nifc.snapshot`

Recipient: `brain.research.source`

Returns a compact National Interagency Fire Center/WFIGS wildfire snapshot for BMCL-safe agent use.
The handler uses the NIFC ArcGIS WFIGS current interagency fire perimeters FeatureServer as the
primary executable source, the NIFC ArcGIS Hub DCAT feed for related wildfire/fire-history dataset
discovery, and the NIFC fire-information page for national preparedness-level context when it can be
parsed. Optional body fields: `timeoutMs`, clamped between 1500 and 15000 ms, and `limit`, clamped
between 1 and 1000 current perimeter records.

The reply includes incident counts, active/large/uncontained counts, total acres, average containment,
preparedness level, state/status/type counts, wildfire/perimeter/smoke-air-quality/utility/insurance/
timber-agriculture/logistics/recovery scores, top incident records, discovered NIFC datasets, source
URLs, limited failures, and a short BMCL use note.

Agents use this operation when they need official U.S. wildfire incident, perimeter, acres-burned,
containment, and preparedness-level evidence for company offices, plants, stores, customer regions,
utilities, insurers, timber/agriculture exposure, logistics routes, travel demand, retail operations,
and recovery-spend debates. NIFC/WFIGS evidence must be localized against company exposure before
influencing trade recommendations.

### `drought.usdm.snapshot`

Recipient: `brain.research.source`

Returns a compact U.S. Drought Monitor snapshot for BMCL-safe agent use. The handler uses the
documented USDM REST statistics service as the executable source, pulling
`GetDroughtSeverityStatisticsByAreaPercent` for D0-D4 drought classifications and `GetDSCI` for the
Drought Severity Coverage Index. It keeps the USDM home, data-download, web-service-info, and GIS
pages in the source list. Optional body fields: `timeoutMs`, clamped between 1500 and 15000 ms;
`area` such as `USStatistics`, `StateStatistics`, `CountyStatistics`, or `HUCStatistics`; `aoi`;
`startDate`; `endDate`; and `statisticsType` (`1` traditional, `2` categorical).

The reply includes release/data-valid dates when parsed, latest period, AOI, DSCI, DSCI/severe
drought changes, D0-D4 percentages, agriculture/water-utility/wildfire-amplification/food-inflation/
livestock/logistics/irrigation-infrastructure scores, top geography rows, source URLs, limited
failures, and a short BMCL use note.

Agents use this operation when they need official weekly drought-classification evidence for company
facilities, farms, retail/customer footprints, suppliers, water utilities, food producers, grocers,
restaurants, livestock exposure, logistics corridors, wildfire-amplification debates, and irrigation
or water-infrastructure demand. USDM evidence must be localized against company exposure before
influencing trade recommendations.

### `crawler.search`

Recipient: `brain.research.source`

Runs a bounded Crawlee search/crawl pass for one or more query strings. Body fields:
`query` or `queries`, optional `maxRequests`, `maxWaves`, `maxFollowUps`, `maxSearchExpansions`,
and `maxRuntimeMs`. The handler clamps these values to conservative BMCL limits and returns compact
`pages`, `failures`, `entityLeads`, recent crawler `events`, and `providerFallbacks`.

Agents use this operation when they need fresh web evidence for research, analysis, or self-improvement.
The crawler starts with Google and Google News, uses DuckDuckGo preflight to obtain direct result URLs
when possible, and queues Bing/DuckDuckGo HTML fallback searches when a search provider fails after
Crawlee retries.

### `crawler.crawl`

Recipient: `brain.research.source`

Runs a bounded Crawlee pass over explicit public HTTP(S) URLs. Body fields: `url` or `urls`, optional
`query`/`queries`, `maxRequests`, `maxWaves`, `maxFollowUps`, `maxSearchExpansions`, and `maxRuntimeMs`.
The handler rejects local/private/non-HTTP URLs, clamps budgets, and returns the same compact result
shape as `crawler.search`.

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
- fail over from a failed search provider to alternates such as Bing or DuckDuckGo HTML after retries,
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

## BMCL/2.0 — Distributed Extensions

BMCL/2.0 is additive to BMCL/1.0, not a breaking replacement. `validateEnvelope` accepts any `proto` in `SUPPORTED_PROTOCOLS = ['BMCL/1.0', 'BMCL/2.0']`. In-process frames built via `frame()` keep stamping `BMCL/1.0` — nothing about existing `agent.personality.*` / `brain.*` traffic changes. Only frames that actually cross a node↔coordinator WebSocket get `BMCL/2.0`.

### Distributed brain model

A coordinator (any AutoTrader deployment) can federate with independently-operated **compute nodes** — standalone Node.js processes (see `node-client/`) run by any operator on their own hardware. Nodes advertise capabilities (currently `crawler.crawl`, i.e. scraping/research) and the coordinator distributes matching jobs to them instead of running everything in-process. This is how distributed scraping, distributed research, and access to larger local LLMs (future capability, not yet implemented) become possible without requiring every user to run heavier compute on the coordinator's own machine.

**Trust boundary — this is structural, not a convention.** BrainMesh is still not a broker execution protocol (per Non-Goals above), and federating with third-party nodes does not change that. Order-placement, trading, broker, and rules-engine ops (`order.*`, `trading.*`, `broker.*`, `rules.*`, `kill-switch.*`) can never be wired to a remote node — `brainMeshService.isRemoteDispatchAllowed(op)` denies them, and the check runs both when a node's capability is registered (`registerRemoteHandler`) and again at dispatch time. A malicious or compromised node lying about its capabilities in `node.hello` cannot get an order-placement op onto the remote-dispatch path; the real trading path (`tradingCycle.js` → `rulesEngine.checkTradeAllowed` → broker client) never touches `remoteHandlers` at all.

**Open protocol vs. gated deployment.** The protocol and the node-client/coordinator code are publishable — any operator can implement a compatible node or coordinator. A specific *deployment*, however, is still owned by whoever operates it: joining requires a one-time join token issued from that coordinator's own dashboard. "Open protocol" means the code is open; it does not mean a coordinator accepts unsolicited anonymous connections.

### Node identity & pairing

Each node generates a local Ed25519 keypair on first run (`node-client/src/identity.js`); the private key never leaves the node. A join token (opaque, high-entropy, hashed at rest, single-use, short-lived) is issued once via `POST /api/brain-mesh/nodes/join-tokens` and consumed on the node's first successful handshake, which registers its public key as its durable identity. All subsequent reconnects authenticate by signing a coordinator-issued nonce with that stored private key — no long-lived secret is ever resent over the wire.

Handshake sequence over the WebSocket channel (`/api/brain-mesh/nodes/socket`):

1. Coordinator → node: `node.challenge` `{nonce}`
2. Node → coordinator: `node.hello` `{nodeId, publicKey, joinToken?, signature?, protocolVersions, capabilities:[{op,maxConcurrency}], resources:{cpuCores,ollamaModels}, health, clientVersion}` — `joinToken` on first pairing, `signature` (over the nonce) on every reconnect after.
3. Coordinator → node: `node.hello.ack` `{ok, nodeId, sessionId, heartbeatIntervalMs}` or `{ok:false, reason}`.

Further `kind` values used only on this channel (never emitted to the in-process bus/SSE stream): `node.heartbeat` `{capabilities, health}` (periodic capability/load refresh — see below), `node.job.assign` / `node.job.result` (job dispatch and its result, correlated by a `jobId`), `node.bye` (graceful disconnect).

### Node health telemetry

Every `node.hello` and `node.heartbeat` (default every `heartbeatIntervalMs`, 30s) carries a `health` object computed on the node by `node-client/src/health.js`: `{cpuCores, cpuPercent, ram:{totalMb,usedMb,percent}, uptimeSec, features:[...], ollamaModels:[...], collectedAt}`. `features` currently reports `["ollama"]` when a local Ollama instance answers `/api/tags`; it is meant to grow as node-client picks up more optional integrations, without needing a protocol version bump. The coordinator merges the latest `health` into that node's `brain_mesh_nodes.metadata_json` (`brainMeshNodeRepo.updateNodeHealth`, additive merge — it never clobbers other metadata keys) so `GET /api/brain-mesh/nodes/nodes` and the Settings "compute nodes" panel can show live CPU/RAM/feature status per node alongside its online/offline state. Health is best-effort telemetry only — it is never used for placement or trust decisions; `brainMeshPlacementService.pickNodeForJob` still keys off registered capability load, not health numbers.

### Placement

v1 placement (`brainMeshPlacementService.pickNodeForJob`) is intentionally simple: filter online nodes advertising the requested op with spare capacity (`currentLoad < maxConcurrency`), pick the lowest load ratio, tie-break by longest-idle. No reputation or performance scoring yet — that's a possible future iteration, not required for the current capability + load-balancing model.

### Dispatch precedence

Because the point of federation is to actually offload compute, a connected capable node is preferred over AutoTrader's own local in-process handler for the same op; the local handler remains as an automatic fallback whenever no node is currently online for that op (see `brainMeshService.resolveAndInvoke`).

### Out of scope (this iteration)

Job types beyond scraping (LLM inference, model-scoring — natural follow-ups reusing this same transport/placement machinery); node reputation/quality scoring beyond raw load; multi-coordinator federation-of-federations; encrypted payload bodies beyond transport TLS.
