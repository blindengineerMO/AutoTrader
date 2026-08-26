# AutoTrader

An automated, research-driven stock trading system. AutoTrader runs a continuous research → AI strategy → risk-gated execution loop against the [Alpaca](https://alpaca.markets/) trading API, backed by a large free/open-data research pipeline, a council of debating "personality" trading agents, and a deterministic risk/decision-tree layer that AI conviction cannot override.

> **⚠️ Not financial advice.** This is experimental automated-trading software. It can place real orders against a real brokerage account when configured for live trading. Use paper trading (the default) until you understand the system, and never risk money you cannot afford to lose.

https://github.com/blindengineerMO/AutoTrader.git

---

## Table of contents

- [Application summary](#application-summary)
- [Feature summary](#feature-summary)
- [Architecture](#architecture)
- [API routes](#api-routes)
- [Database](#database)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the app](#running-the-app)
- [Testing](#testing)
- [Operating & managing AutoTrader](#operating--managing-autotrader)
- [Security](#security)
- [License](#license)

---

## Application summary

AutoTrader is a Node.js/Express backend paired with a Vue 3 + Vuetify single-page frontend. For each user it runs a scheduled cycle that:

1. **Researches** — pulls and scores signals from dozens of free, no-login public data sources (SEC filings, government economic data, news, retail/consumer demand, disasters, government contracts, and more).
2. **Reasons** — hands an aggregated research snapshot to a configurable AI provider (local Ollama by default, or OpenAI/DeepSeek/Groq/xAI/Gemini) to produce a structured trading plan, or falls back to a transparent rules-based plan if no AI provider is available.
3. **Debates** — optionally routes candidate ideas through a "council" of user-created AI personality agents that score, challenge, and reach consensus on a recommendation.
4. **Gates** — passes every recommendation through a deterministic decision tree (mandate/universe checks, data-quality gates, valuation, stress tests, position sizing) that AI or persona conviction cannot bypass.
5. **Executes** — places the resulting order via Alpaca (paper by default) or a built-in cash-funded simulation mode, and records it in a double-entry general ledger.
6. **Evaluates** — grades its own past decisions against what actually happened, feeding the result back into source, model, and agent confidence scoring.

The app is multi-user: each user has isolated broker credentials, settings, simulation state, orders, positions, ledger, research history, and agents, managed by an admin role.

## Feature summary

- **Alpaca-backed trading** — paper trading by default; live trading is gated behind credential checks, market-hours windows, kill switches, and daily loss/frequency limits enforced server-side (not just trusted from the AI's plan). The app only trades funds already in the account — it never initiates a deposit.
- **Pluggable AI strategy providers** — OpenAI, DeepSeek, Groq, xAI (Grok), Gemini, and local Ollama, each configurable per-user via the Settings UI or environment variables, with automatic fallback to a rules-based plan.
- **Open research pipeline** — 30+ scraped/API data sources (SEC EDGAR, GDELT, Census, BLS, BEA/FRED, EIA, FINRA, NWS/USGS/GDACS disaster feeds, CPSC/FDA/NHTSA recalls, USAspending government contracts, retail bestseller scrapers, and more), crawled via Crawlee with multi-engine search failover and a self-learning source-relevance store.
- **SPEC-safe research & backtesting lane** — a stricter control plane with point-in-time datasets, versioned features, approved-model gating, independent risk checks, paper order intents, reconciliation, an audit trail, and human-approved model promotion/rollback.
- **Personality/council trading agents** — user-creatable AI personas that research themselves, debate candidate trades in a "council" run, and escalate risky sizing to a human review queue.
- **BrainMesh (BMCL)** — an internal pub/sub + RPC protocol connecting all backend "brain" services, with a live SSE stream for operator troubleshooting and an optional peer-to-peer federation layer that lets multiple AutoTrader instances share a mesh over WebSocket via join tokens.
- **Watcher agents** — dedicated per-symbol research/grading agents running on their own cadence with accuracy scorecards.
- **Simulation & funding** — a persistent paper-trading mode independent of Alpaca's own sandbox, with one-off or recurring simulated cash funding rules.
- **Double-entry accounting** — every fill (live or simulated) produces balanced general-ledger entries with per-symbol and portfolio views.
- **Admin/user management** — multi-tenant with role-based access; public self-registration is disabled, accounts are provisioned by an admin.
- **Decision & evaluation reports** — every cycle produces a report explaining what happened and why, plus scheduled evaluations comparing decisions to outcomes.

## Architecture

```
frontend/   Vue 3 + Vuetify + Pinia + Vue Router (Vite)
src/
  server/   Express app bootstrap (server/index.js) and app wiring (server/app.js)
  routes/   Express routers — request validation (Zod), calls into services
  services/ Business logic (~90 modules): trading cycle, research sources,
            strategy/AI providers, BrainMesh, personality agents, ledger,
            evaluation, alerting, etc.
  db/       better-sqlite3 connection, sequential SQL migrations, repositories
  jobs/     node-cron scheduler — one set of jobs per user
  middleware/ auth (JWT), admin gating, request logging
  shared/   cross-cutting guards (e.g. SSRF protection for the crawler)
  utils/    logger, rate limiter, resilient fetch/cache, trading-calendar helpers
```

**Boot sequence** (`src/server/index.js`): run pending DB migrations synchronously → ensure the default admin account exists → reconcile any research runs left "running" by an unclean shutdown → restore search-provider health state → build the Express app → schedule every user's cron jobs → start listening → attach a WebSocket transport for BrainMesh node federation. Shutdown (`SIGTERM`/`SIGINT`) stops the scheduler, closes the mesh transport, persists provider health, and checkpoints/closes the database.

**Request flow**: `routes/` (validation, auth) → `services/` (business logic, often orchestrating several other services — e.g. the trading cycle chains research → AI strategy → broker → ledger) → `db/repositories/` (prepared-statement wrappers) → a single shared `better-sqlite3` connection in WAL mode.

**Scheduler** (`src/jobs/scheduler.js`): per-user cron tasks, re-registered live whenever a user changes their schedule settings — the core research/trading cycle, daily self-evaluation, hourly watcher-agent research and weekday grading, simulation open/close, personality-agent refresh and periodic "ticks", idle background research, monthly Alpaca statement sync, due simulated-funding rules, and periodic re-checks of Alpaca-excluded symbols.

**BrainMesh (BMCL)**: a custom `BMCL/1.0` message protocol (`tell`/`ask`/`reply`/event frames, persisted to SQLite, streamed live over SSE) that connects the ~15+ built-in "brain" services — research-source discovery, company intelligence, neural scoring, investor playbook, reporting, evaluation, and a local-Ollama LLM participant. A separate federation layer lets independent AutoTrader server instances join a shared mesh over WebSocket using invite/join tokens, so agents can be distributed across machines.

**Personality/council agents**: each agent is researched and given a bias profile; a council run scores candidates per agent, selects a skeptic to challenge the top pick, and builds consensus with position sizing. Every recommendation — regardless of persona conviction — is still passed through the deterministic decision-tree gate described above.

**AI provider strategy**: the chat-research layer prefers a local Ollama instance by default (cost/privacy — no data leaves the machine) and only falls back to external providers if explicitly enabled. The separate trading-strategy layer supports OpenAI/DeepSeek/Groq/xAI/Gemini/Ollama and falls back to a transparent rules-based plan if no provider is usable.

## API routes

All routes are mounted under `/api`. Routes marked **auth** require a `Authorization: Bearer <jwt>` header (obtained via `POST /api/auth/login`); routes marked **admin** additionally require the caller's account to have the `admin` role.

### Auth — `/api/auth`

| Method & path | Auth | Description |
|---|---|---|
| `POST /api/auth/login` | — | Log in with email/password, returns a JWT + user profile. |
| `GET /api/auth/me` | auth | Return the current authenticated user. |
| `POST /api/auth/register` | — | Always returns `410` — self-registration is disabled; accounts are created by an admin. |

### Public — `/api/public`

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/public/home-signal` | — | Public marketing signal shown on the unauthenticated home page. |
| `GET /api/health` | — | Health check; reports trading readiness and any missing configuration. |

### Dashboard — `/api/dashboard`

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/dashboard/summary` | auth | Aggregated dashboard summary for the logged-in user. |

### Orders & ledger — `/api/orders`

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/orders` | auth | List orders for the user. |
| `GET /api/orders/pnl-history` | auth | P&L history. |
| `GET /api/orders/gl-ledger` | auth | General-ledger entries. |
| `GET /api/orders/gl-ledger/companies` | auth | Distinct symbols with ledger activity. |
| `GET /api/orders/gl-ledger/:symbol` | auth | Ledger entries for one symbol. |

### Simulation funding — `/api/simulation-funding` (also mounted at `/api/dashboard/simulation-funding` and `/api/orders/simulation-funding`)

| Method & path | Auth | Description |
|---|---|---|
| `GET /` | auth | Simulated cash-account funding summary. |
| `POST /now` | auth | Add a one-off cash injection to the simulation. |
| `POST /rules` | auth | Create a recurring funding rule. |
| `POST /apply-due` | auth | Manually apply any due funding rules. |
| `DELETE /rules/:id` | auth | Cancel a funding rule. |

### Settings — `/api/settings`

| Method & path | Auth | Description |
|---|---|---|
| `GET /` | auth | Get the user's settings. |
| `PATCH /` | auth | Update settings (loss limits, cron cadences, trading hours/timezone, simulation mode, fractional trading, investing mode, council sizing, excluded symbols, dashboard layout, etc.) — live-reschedules that user's cron jobs. |
| `GET /providers` | auth | List configured AI/data-provider credentials (masked). |
| `PUT /providers/:providerKey` | auth | Save/update a provider credential. |
| `GET /research-sources` | admin | List learned research sources. |
| `POST /research-sources` | admin | Manually add a research source. |
| `PATCH /research-sources/:id` | admin | Edit a research source. |
| `POST /excluded-symbols` | auth | Exclude a symbol from trading. |
| `DELETE /excluded-symbols/:symbol` | auth | Remove an excluded symbol. |
| `POST /ollama-instances` | auth | Register an additional local Ollama endpoint. |
| `PATCH /ollama-instances/:id` | auth | Update an Ollama endpoint. |
| `DELETE /ollama-instances/:id` | auth | Remove an Ollama endpoint. |
| `POST /kill-switch/engage` | auth | Engage the trading kill switch. |
| `POST /kill-switch/release` | auth | Release the trading kill switch. |

### Companies — `/api/companies`

| Method & path | Auth | Description |
|---|---|---|
| `GET /` | auth | List company-intelligence records. |
| `GET /brain/models` | auth | List the user's Brain.js model metadata. |
| `GET /:symbol` | auth | Company-intelligence detail for one symbol. |

### BrainMesh — `/api/brain-mesh`

| Method & path | Auth | Description |
|---|---|---|
| `GET /agents` | auth | List BrainMesh agents. |
| `POST /agents` | auth | Register a dynamic agent. |
| `DELETE /agents/:id` | auth | Remove an agent. |
| `GET /agent-links` | auth | List agent-to-board links. |
| `POST /agent-links` | auth | Link an agent to a board. |
| `DELETE /agent-links/:boardId/:agentId` | auth | Unlink an agent from a board. |
| `GET /conversations` | auth | List BMCL conversations. |
| `GET /messages` | auth | List BMCL messages (filterable). |
| `POST /tell` | auth | Send a fire-and-forget BMCL frame. |
| `POST /ask` | auth | Send an RPC-style BMCL frame and await a reply. |
| `GET /stream` | auth | Server-Sent Events stream of live BMCL frames. |

### BrainMesh federation — `/api/brain-mesh/nodes`

| Method & path | Auth | Description |
|---|---|---|
| `POST /join-tokens` | auth | Create a token so another node can join this mesh. |
| `GET /join-tokens` | auth | List join tokens. |
| `DELETE /join-tokens/:id` | auth | Revoke a join token. |
| `DELETE /join-tokens/:id/purge` | auth | Hard-delete a revoked/unused token. |
| `GET /nodes` | auth | List peer nodes. |
| `GET /nodes/job-stats` | auth | Work/job stats across peer nodes. |
| `DELETE /nodes/:nodeId` | auth | Revoke and disconnect a peer node. |

### Personality/council agents — `/api/agents`

| Method & path | Auth | Description |
|---|---|---|
| `GET /` | auth | List the user's agents. |
| `POST /` | auth | Create an agent by name. |
| `POST /seed` | auth | Ensure the default agent set exists. |
| `POST /research-create` | auth | Kick off async agent-creation research (`202` + run handle). |
| `GET /research-runs/:runId` | auth | Poll an agent-creation research run. |
| `POST /import` | auth | Import an agent from an exported spec. |
| `GET /calibration` | auth | Agent calibration/accuracy summary. |
| `GET /review-queue` | auth | List recommendations flagged for human review. |
| `PATCH /review-queue/:id` | auth | Mark a review-queue item reviewed/dismissed. |
| `GET /council/runs` | auth | List past council runs. |
| `POST /council/run` | auth | Manually trigger a council run. |
| `PATCH /:id` | auth | Update an agent (bias overrides, etc.). |
| `DELETE /:id` | auth | Soft-delete an agent. |
| `GET /:id/export` | auth | Export an agent's spec/profile. |

### Watcher agents — `/api/watcher-agents`

| Method & path | Auth | Description |
|---|---|---|
| `GET /` | auth | List active watcher agents and scorecards. |
| `POST /training-backfill-30d` | auth | Force a 30-day historical training backfill. |
| `GET /:symbol` | auth | Watcher detail: research runs, grades, scorecard, mesh conversation history. |

### Admin / user management — `/api/admin`

| Method & path | Auth | Description |
|---|---|---|
| `GET /users` | admin | Paged/filterable/sortable user list. |
| `POST /users` | admin | Create a user. |
| `PATCH /users/:id` | admin | Update a user's email/role/status. |
| `POST /users/:id/password` | admin | Admin-driven password reset. |
| `DELETE /users/:id` | admin | Delete a user (blocked if it would remove the last active admin, or is self-deletion). |

### Research & SPEC-safe backtesting — `/api/research`

| Method & path | Auth | Description |
|---|---|---|
| `GET /snapshots` | auth | Recent research snapshots. |
| `GET /plans` | auth | Trading plans generated from research. |
| `GET /reports` | auth | Decision reports. |
| `GET /evaluations` | auth | Evaluation reports. |
| `GET /alpaca-documents` | auth | Paged Alpaca statements/documents. |
| `POST /alpaca-documents/sync` | auth | Manually trigger monthly Alpaca document sync. |
| `GET /alpaca-documents/:id/download` | auth | Get a signed download link for a statement. |
| `GET /forecast/:symbol` | auth | Generate a forecast for a symbol. |
| `GET /event-labels` | auth | Training-label accuracy/challenger status. |
| `GET /spec-monitoring` | auth | SPEC-safe lane monitoring status. |
| `GET /spec-data-quality` | auth | Data-quality reports. |
| `GET /safe-mvp/backtests` | auth | SPEC-safe backtest runs. |
| `GET /safe-mvp/backtests/:runId/events` | auth | Backtest run event drill-down. |
| `GET /spec-risk-checks/:runId` | auth | Independent risk-check results for a run. |
| `GET /spec-audit/:runId` | auth | Audit trail for a run. |
| `GET /spec-paper-intents/:runId` | auth | Paper order intents for a run. |
| `GET /spec-models` | auth | Model registry, promotion reviews, training snapshots, rollbacks. |
| `POST /spec-models/:modelVersion/rollback` | auth | Roll back the champion model (requires a reason). |
| `GET /spec-reconciliations` | auth | List reconciliation runs. |
| `GET /spec-reconciliations/:runId` | auth | One reconciliation run's detail. |
| `POST /evaluate` | auth | Manually run the daily evaluation brain. |
| `GET /runs` | auth | List autonomous research runs. |
| `GET /runs/:id` | auth | One research run's detail (ownership-checked). |
| `POST /collect-process` (aliases: `/collect/process`, `/collect-process-research`) | auth | Queue an async research+trading-cycle run (`202` + run handle). |
| `POST /run-cycle` | auth | Synchronously trigger a full research → strategy → execution cycle. |
| `POST /run-research-only` | auth | Run just the research cycle, no trading. |
| `POST /safe-mvp` | auth | Run the SPEC-safe research MVP pipeline for an optional watchlist. |

## Database

- **Engine**: [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (synchronous, prepared statements), `journal_mode=WAL`, `foreign_keys=ON`.
- **Location**: `data/autotrader.db` by default, overridable with `DB_PATH`.
- **Migrations**: sequentially numbered SQL files in `src/db/migrations/` (`001_init.sql`, …), applied in order inside a transaction and recorded in a `schema_migrations` table — append-only, no down-migrations.
- **Running migrations**: `npm run migrate`. Migrations also run automatically and synchronously at server boot, so a fresh checkout self-migrates on `npm start`/`npm run serve`.

## Installation

Prerequisites: Node.js 18+, npm.

```bash
git clone <this-repo-url>
cd Autotrader

# backend
npm install
cp .env.example .env   # then edit .env — see Configuration below

# frontend (separate package, not a workspace)
npm --prefix frontend install
```

## Configuration

Copy `.env.example` to `.env` and fill in what you need. Every value has a safe default or is optional except where noted:

- **Server**: `PORT`, `NODE_ENV`, `LOG_LEVEL`.
- **Auth**: `JWT_SECRET` (change this — used to sign login tokens), `CREDENTIAL_ENCRYPTION_KEY` (strongly recommended — used to encrypt stored provider API keys; if unset it derives from `JWT_SECRET`, so rotating one affects the other), `DEFAULT_ADMIN_EMAILS`, `DEFAULT_ADMIN_PASSWORD` (**change this default in any real deployment**), `DEFAULT_ADMIN_RESET_PASSWORD`.
- **AI strategy providers** (all optional — the app falls back to a rules-based plan without them): `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, plus their `*_MODEL` variants.
- **Local LLM** (used by default for research reasoning): `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, and related tuning vars — see `src/config/index.js` for the full list.
- **Market/economic data** (each optional; scraping fallback is used when absent): `FINNHUB_API_KEY`, `CENSUS_API_KEY`, `BEA_API_KEY`, `BLS_API_KEY`, `EIA_API_KEY`, `USDA_AMS_API_KEY`, `GDELT_DOC_*`.
- **Trading**: `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER` (defaults `true` — keep it that way until you're confident), `ALPACA_BASE_URL`.
- **Billing**: `STRIPE_*` — reserved for an upcoming paid signup flow; not yet wired to any route.

See `src/config/index.js` for the complete set of recognized environment variables, including several additional optional providers (xAI, Gemini, Duck.ai research) not listed in `.env.example`.

## Running the app

**Development** (hot-reloading backend + Vite dev server, run in two terminals):

```bash
npm run dev                       # backend on :3000, auto-restarts on change
npm --prefix frontend run dev     # frontend on :5173, proxies /api to :3000
```

Then open `http://localhost:5173`.

**Production-style** (single process, built frontend served by Express):

```bash
npm start   # builds the frontend, then starts the server on :3000
```

Once running, log in with the default admin (`admin@autotrader.local` / `ChangeMeAdmin123!` unless overridden) and change the password immediately, then create additional users from the admin **Users** view — public self-registration is disabled by design.

## Testing

```bash
npm test          # Vitest unit/integration tests
npm run test:watch
npm run test:e2e  # Playwright end-to-end tests (spins up its own backend + frontend dev server)
```

## Operating & managing AutoTrader

- **Trading readiness**: `GET /api/health` reports whether trading is fully configured (Alpaca credentials, etc.) and what's missing.
- **Kill switch**: any user can halt their own automated trading immediately via `POST /api/settings/kill-switch/engage`, and resume with `.../release`.
- **Scheduling**: each user's cadence for research, trading, evaluation, and watcher cycles is configured via `PATCH /api/settings` and takes effect immediately (the scheduler re-registers cron jobs live).
- **Simulation mode**: toggle a user into cash-simulated paper trading (independent of Alpaca's own sandbox) from Settings, and fund it via the simulation-funding endpoints/rules.
- **Excluded symbols**: block specific tickers from ever being traded, per user, via Settings.
- **Admin duties**: create/disable users and reset passwords from the Users view (`/api/admin/users*`); at least one active admin is always protected from deletion/demotion. Admins can also curate the learned research-source list.
- **BrainMesh troubleshooting**: `GET /api/brain-mesh/stream` gives a live view of internal agent traffic; `/api/brain-mesh/conversations` and `/messages` let you inspect past exchanges.
- **Model governance**: SPEC-safe model promotions require a human-reviewed rollback path (`POST /api/research/spec-models/:modelVersion/rollback`) rather than fully automatic model swaps.

## Security

- **Authentication**: JWT bearer tokens (7-day expiry), verified and re-checked against the database on every request (so disabling a user takes effect immediately, not just at next login).
- **Passwords**: hashed with bcrypt (12 salt rounds); never stored or logged in plaintext.
- **Provider credentials**: third-party API keys you store in Settings are encrypted at rest with AES-256-GCM, keyed from `CREDENTIAL_ENCRYPTION_KEY` (or, if unset, derived from `JWT_SECRET` — set both explicitly in production) and masked in API responses.
- **Roles**: `user` and `admin`; admin-only routes are gated by middleware, and the system always refuses to delete or demote the last remaining active admin.
- **SSRF protection**: the research/crawling subsystem refuses to fetch localhost or private-IP-range targets.
- **Default credentials**: a default admin account is provisioned on first boot with a well-known password (`ChangeMeAdmin123!` unless overridden). **Change this immediately in any deployment reachable outside your own machine.**
- **Known gaps to be aware of before exposing this publicly**:
  - CORS and Helmet are enabled with their default (permissive) options — no origin allowlist is configured in code.
  - There is no inbound HTTP rate limiting on the API itself (the built-in rate limiter only throttles the app's own *outbound* calls to third-party data sources). Put a reverse proxy or WAF in front of any public deployment.
  - Public self-registration is disabled by design — all accounts must be created by an admin.

If you discover a security issue, please open an issue or contact the maintainer privately before public disclosure.

## License

ISC — see `package.json`.
