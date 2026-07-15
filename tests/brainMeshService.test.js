const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-brain-mesh.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const providerCredentialRepo = require('../src/db/repositories/providerCredentialRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const brainMesh = require('../src/services/brainMeshService');
const ollamaClient = require('../src/services/ollamaClient');
const crawleeCrawler = require('../src/services/crawleeResearchCrawlerService');
const alpacaAssetClient = require('../src/services/marketData/alpacaAssetClient');

describe('brainMeshService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ollamaClient.clearOllamaModelCache();
    alpacaAssetClient.__setClientFactoryForTests(null);
  });

  it('registers brains, performs RPC ask/reply, and records frames', async () => {
    const user = userRepo.createUser({
      email: `mesh-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'test-mesh' });

    const result = await brainMesh.ask({
      from: 'test.operator',
      to: 'brain.discovery.company',
      op: 'mesh.status',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {},
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body.id).toBe('brain.discovery.company');
    expect(brainMesh.listAgents(user.id).map((agent) => agent.id)).toContain('brain.discovery.company');

    const dynamic = brainMesh.registerAgent({
      id: `agent.test.${user.id}`,
      userId: user.id,
      role: 'test-agent',
      capabilities: ['mesh.status', 'test.op'],
    });
    expect(dynamic.status).toBe('online');
    brainMesh.linkAgentToBoard({ userId: user.id, agentId: dynamic.id, boardId: 'agent-council', role: 'member' });
    expect(brainMesh.listAgentLinks({ userId: user.id, boardId: 'agent-council' })[0].agent_id).toBe(dynamic.id);
    brainMesh.unlinkAgentFromBoard({ userId: user.id, agentId: dynamic.id, boardId: 'agent-council' });
    expect(brainMesh.listAgentLinks({ userId: user.id, boardId: 'agent-council' })).toHaveLength(0);
    expect(brainMesh.removeAgent(dynamic.id, user.id).status).toBe('removed');

    const messages = brainMesh.listMessages({ userId: user.id, traceId: conversation.metadata.trace, limit: 10 });
    expect(messages.map((message) => message.envelope.kind)).toEqual(expect.arrayContaining(['ask', 'reply']));
  });

  it('summarizes only completed BrainMesh conversations', () => {
    const user = userRepo.createUser({
      email: `mesh-summary-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const active = brainMesh.startConversation({ userId: user.id, topic: 'still-running' });
    brainMesh.tell({
      from: 'brain.research.source',
      to: 'brain.reporting',
      op: 'research.run.started',
      kind: 'event',
      ctx: { userId: user.id },
      conv: active.id,
      trace: active.metadata.trace,
      body: { watchlist: ['AAPL'] },
    });

    const complete = brainMesh.startConversation({ userId: user.id, topic: 'summary-ready' });
    brainMesh.tell({
      from: 'brain.reporting',
      to: 'brain.evaluation',
      op: 'research.snapshot.persisted',
      kind: 'event',
      ctx: { userId: user.id },
      conv: complete.id,
      trace: complete.metadata.trace,
      body: { snapshotId: 77, signalCount: 12 },
    });

    const summaries = brainMesh.listCompletedConversationSummaries(user.id, 50);
    expect(summaries.map((conversation) => conversation.id)).toContain(complete.id);
    expect(summaries.map((conversation) => conversation.id)).not.toContain(active.id);
    expect(summaries.find((conversation) => conversation.id === complete.id)).toMatchObject({
      status: 'complete',
      messageCount: 1,
      lastOperation: 'research.snapshot.persisted',
    });
    expect(summaries.find((conversation) => conversation.id === complete.id).summary).toContain('snapshot 77');
  });

  it('exposes Ollama as a BrainMesh LLM brain for agent reasoning and training assistance', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'deepseek-r1:latest', model: 'deepseek-r1:latest' }] });
      }
      if (target.endsWith('/api/chat')) {
        const body = JSON.parse(options.body);
        expect(body.model).toBe('deepseek-r1:latest');
        expect(body.messages[1].content).toContain('[redacted]');
        return jsonResponse({
          message: {
            content: JSON.stringify({
              summary: 'Use more outcome labels for weak high-volatility calls.',
              reasoning: 'Recent misses cluster around low evidence and high volatility.',
              insights: ['High-volatility holds need stricter confirmation.'],
              recommendations: ['Add a volatility-confirmation feature.'],
              trainingNotes: ['Label weak high-volatility outcomes separately.'],
              riskNotes: ['Local model used only supplied outcomes.'],
            }),
          },
        });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const user = userRepo.createUser({
      email: `mesh-ollama-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'ollama-mesh' });

    const agents = brainMesh.listAgents(user.id);
    const ollamaAgent = agents.find((agent) => agent.id === 'brain.llm.ollama');
    expect(ollamaAgent.capabilities).toContain('llm.training.suggest');

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.llm.ollama',
      op: 'llm.training.suggest',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        objective: 'Improve agent model after daily evaluation.',
        apiKey: 'should-not-leak',
        outcomes: [{ symbol: 'XYZ', predicted: 'buy', actualReturnPct: -4.2 }],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'ollama',
      brainId: 'brain.llm.ollama',
      mode: 'training',
      summary: 'Use more outcome labels for weak high-volatility calls.',
    });
    expect(result.replies[0].body.trainingNotes).toContain('Label weak high-volatility outcomes separately.');
  });

  it('exposes the practical analyst decision gate over BMCL', async () => {
    const user = userRepo.createUser({
      email: `mesh-analyst-gate-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'analyst-gate-mesh' });

    const status = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.evaluation',
      op: 'mesh.status',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {},
    });

    expect(status.ok).toBe(true);
    expect(status.replies[0].body.capabilities).toContain('decision.analyst.gate.evaluate');

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.evaluation',
      op: 'decision.analyst.gate.evaluate',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        now: '2026-07-14T12:00:00Z',
        candidate: {
          symbol: 'ABC',
          localAiScore: 82,
          brokerFactorScore: 74,
          volatilityPct: 2,
          changePct: 0.5,
        },
        quote: { current: 25, dollarVolume: 18000000 },
        marketBeatIntel: {
          compositeScore: 78,
          signals: [
            {
              symbol: 'ABC',
              action: 'upgrade',
              previousRating: 'Hold',
              newRating: 'Buy',
              previousTarget: 35,
              newTarget: 42,
              analystFirm: 'Example Capital',
              publishedAt: '2026-07-14T09:00:00Z',
              reason: 'Upgrade with raised price target.',
            },
          ],
        },
        factorIntel: { compositeScore: 72, secFilingFactor: { score: 72, latestForm: '10-Q' } },
        secOwnershipIntel: { compositeScore: 65 },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      version: 'analyst-decision-gate-v1',
      symbol: 'ABC',
      passed: true,
      status: 'possible-candidate-for-further-evaluation',
      directBuyAllowed: false,
    });
    expect(result.replies[0].body.gates.map((gate) => gate.key)).toEqual(expect.arrayContaining([
      'analyst-upgrade-detected',
      'sec-filing-data-supports-thesis',
      'liquidity-and-portfolio-risk-checks',
    ]));
  });

  it('exposes Alpaca fractional-order rules as a top-level BMCL teacher brain', async () => {
    const user = userRepo.createUser({
      email: `mesh-alpaca-rules-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(user.id, {
      fractionalTradingEnabled: 1,
      fractionalMinNotionalUsd: 1,
      maxBuyOrderNotionalUsd: 25,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'alpaca-rules-mesh' });

    const status = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.broker.alpaca.rules',
      op: 'mesh.status',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {},
    });

    expect(status.ok).toBe(true);
    expect(status.replies[0].body.capabilities).toContain('alpaca.rules.evaluate_order');

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.broker.alpaca.rules',
      op: 'alpaca.rules.evaluate_order',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        symbol: 'AAPL',
        side: 'buy',
        quantity: 0.25,
        price: 20,
        asset: { tradable: true, fractionable: true },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      fractional: true,
      allowed: true,
      notionalUsd: 5,
    });
  });

  it('exposes research source catalog methods over BMCL for agent source sharing', async () => {
    const user = userRepo.createUser({
      email: `mesh-source-catalog-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'source-catalog-mesh' });

    const status = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'mesh.status',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {},
    });

    expect(status.ok).toBe(true);
    expect(status.replies[0].body.capabilities).toEqual(expect.arrayContaining([
      'source.catalog.search',
      'source.catalog.pack',
      'source.catalog.share',
      'energy.eia.snapshot',
      'vehicle.sales.snapshot',
      'pricing.bls.snapshot',
      'commerce.census.retail.snapshot',
      'commerce.amazon.bestsellers.snapshot',
      'commerce.walmart.retail.snapshot',
      'market.alpaca.symbol.eligibility',
      'market.consumer-goods.industry.snapshot',
      'market.finviz.screener.snapshot',
      'market.tradingview.screener.snapshot',
      'market.yahoo.screener.snapshot',
      'market.nasdaq.research.snapshot',
      'market.marketbeat.analyst.snapshot',
      'market.wallstreetzen.snapshot',
      'market.finra.fixed-income.snapshot',
      'market.sec.ownership.snapshot',
      'government.usaspending.awards.snapshot',
      'government.dod.contracts.snapshot',
      'defense.sipri.snapshot',
      'disaster.gdacs.snapshot',
      'disaster.eonet.snapshot',
      'disaster.reliefweb.snapshot',
      'disaster.emdat.snapshot',
      'disaster.usgs.earthquake.snapshot',
      'weather.nws.alerts.snapshot',
      'nuclear.nrc.events.snapshot',
      'wildfire.nifc.snapshot',
      'drought.usdm.snapshot',
      'humanitarian.unhcr.refugees.snapshot',
      'crawler.search',
      'crawler.crawl',
    ]));
    expect(status.replies[0].body.metadata.catalogPacks).toEqual(expect.arrayContaining(['housing', 'regulatory', 'discovery', 'market-screener', 'consumer-goods-industry', 'credit-risk', 'ownership', 'government-contracts', 'defense-geopolitics', 'inflation', 'producer-prices', 'energy-fuel', 'vehicle-sales', 'nuclear', 'global-disasters', 'humanitarian', 'wildfires', 'drought', 'weather-alerts', 'food-retail', 'food-prices', 'retail', 'manufacturing', 'safety']));

    const search = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'FRED New Residential Construction PERMIT HOUST months supply',
        limit: 10,
        includeRequiredFields: true,
      },
    });

    expect(search.ok).toBe(true);
    const sourceIds = search.replies[0].body.sources.map((source) => source.id);
    expect(sourceIds).toEqual(expect.arrayContaining([
      'fred-nrc-total-building-permits',
      'fred-nrc-total-housing-starts',
      'fred-nrs-months-supply-new-homes',
    ]));

    const pack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'housing', limit: 20 },
    });

    expect(pack.ok).toBe(true);
    expect(pack.replies[0].body.pack).toBe('housing');
    expect(pack.replies[0].body.conversationHints.join(' ')).toMatch(/observation\/release dates/);
    expect(pack.replies[0].body.sources.map((source) => source.id)).toContain('census-new-residential-construction');
    expect(pack.replies[0].body.sources.map((source) => source.id)).toContain('realtor-com-research-data-library');
    expect(pack.replies[0].body.sources.map((source) => source.id)).toContain('redfin-data-center');
    expect(pack.replies[0].body.sources.find((source) => source.id === 'realtor-com-research-data-library')).toMatchObject({
      evidenceMode: 'listing-market-not-completed-sales',
    });
    expect(pack.replies[0].body.sources.find((source) => source.id === 'redfin-data-center')).toMatchObject({
      evidenceMode: 'completed-sales-local-market',
    });
    expect(pack.replies[0].body.conversationHints.join(' ')).toMatch(/not completed sale prices/);
    expect(pack.replies[0].body.conversationHints.join(' ')).toMatch(/completed-sales/);

    const inflationPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'inflation', limit: 10 },
    });

    expect(inflationPack.ok).toBe(true);
    expect(inflationPack.replies[0].body.pack).toBe('inflation');
    expect(inflationPack.replies[0].body.sources.map((source) => source.id)).toContain('bls-cpi-data-portal');
    expect(inflationPack.replies[0].body.sources.map((source) => source.id)).toContain('bls-cpi-average-price-data');
    expect(inflationPack.replies[0].body.sources.map((source) => source.id)).toContain('bls-public-api-v2-timeseries-data');
    expect(inflationPack.replies[0].body.sources.find((source) => source.id === 'bls-cpi-data-portal')).toMatchObject({
      evidenceMode: 'official-consumer-price-inflation-series',
    });
    expect(inflationPack.replies[0].body.conversationHints.join(' ')).toMatch(/price\/inflation evidence/);
    expect(inflationPack.replies[0].body.conversationHints.join(' ')).toMatch(/margin or demand pressure/);

    const inflationSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'BLS CPI consumer price index average price data eggs milk bread meat gasoline electricity natural gas CUUR0000SA0 APU0000708111 seriesid',
        limit: 5,
      },
    });

    expect(inflationSearch.ok).toBe(true);
    expect(inflationSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'bls-cpi-average-price-data',
      evidenceMode: 'official-consumer-price-inflation-series',
    });

    const governmentContractsPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'government-contracts', limit: 10 },
    });

    expect(governmentContractsPack.ok).toBe(true);
    expect(governmentContractsPack.replies[0].body.pack).toBe('government-contracts');
    expect(governmentContractsPack.replies[0].body.sources.map((source) => source.id)).toContain('usaspending-search-spending-by-award-api');
    expect(governmentContractsPack.replies[0].body.sources.map((source) => source.id)).toContain('dod-contract-announcements-rss');
    expect(governmentContractsPack.replies[0].body.sources.find((source) => source.id === 'usaspending-search-spending-by-award-api')).toMatchObject({
      evidenceMode: 'official-federal-awards-contracts-signal',
    });
    expect(governmentContractsPack.replies[0].body.sources.find((source) => source.id === 'dod-contract-announcements-rss')).toMatchObject({
      evidenceMode: 'official-federal-awards-contracts-signal',
    });
    expect(governmentContractsPack.replies[0].body.conversationHints.join(' ')).toMatch(/war\/conflict relationship as inferred|war\/conflict links as inferred|war\/conflict relationships as inferred/);
    expect(governmentContractsPack.replies[0].body.conversationHints.join(' ')).toMatch(/DoD\/War\.gov daily contract announcements/);

    const defenseGeopoliticsPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'defense-geopolitics', limit: 12 },
    });

    expect(defenseGeopoliticsPack.ok).toBe(true);
    expect(defenseGeopoliticsPack.replies[0].body.pack).toBe('defense-geopolitics');
    expect(defenseGeopoliticsPack.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'sipri-military-expenditure-database',
      'sipri-arms-transfers-sources-methods',
      'sipri-arms-industry-database',
    ]));
    expect(defenseGeopoliticsPack.replies[0].body.sources.find((source) => source.id === 'sipri-arms-transfers-sources-methods')).toMatchObject({
      evidenceMode: 'sipri-defense-geopolitics-measure-specific',
    });
    expect(defenseGeopoliticsPack.replies[0].body.conversationHints.join(' ')).toMatch(/TIV is transfer volume, not financial price/);
    expect(defenseGeopoliticsPack.replies[0].body.conversationHints.join(' ')).toMatch(/Use USAspending or DoD\/War\.gov for contract award values/);

    const producerPricePack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'producer-prices', limit: 10 },
    });

    expect(producerPricePack.ok).toBe(true);
    expect(producerPricePack.replies[0].body.pack).toBe('producer-prices');
    expect(producerPricePack.replies[0].body.sources.map((source) => source.id)).toContain('bls-ppi-data-portal');
    expect(producerPricePack.replies[0].body.sources.map((source) => source.id)).toContain('bls-public-api-v2-timeseries-data');
    expect(producerPricePack.replies[0].body.sources.find((source) => source.id === 'bls-ppi-data-portal')).toMatchObject({
      evidenceMode: 'official-producer-price-inflation-series',
    });
    expect(producerPricePack.replies[0].body.conversationHints.join(' ')).toMatch(/producer selling-price evidence/);
    expect(producerPricePack.replies[0].body.conversationHints.join(' ')).toMatch(/separately from CPI/);

    const producerPriceSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'BLS PPI Producer Price Index selling prices domestic producers final demand intermediate demand manufacturer pricing input cost pressure wholesale trends price pass-through',
        limit: 5,
      },
    });

    expect(producerPriceSearch.ok).toBe(true);
    expect(producerPriceSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'bls-ppi-data-portal',
      evidenceMode: 'official-producer-price-inflation-series',
    });

    const retailTradePack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'retail', limit: 25 },
    });

    expect(retailTradePack.ok).toBe(true);
    expect(retailTradePack.replies[0].body.pack).toBe('retail');
    expect(retailTradePack.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'census-monthly-retail-trade-api',
      'census-advance-monthly-retail-trade-api',
      'census-manufacturing-trade-inventories-sales-api',
      'census-annual-retail-trade-survey',
    ]));
    expect(retailTradePack.replies[0].body.sources.find((source) => source.id === 'census-manufacturing-trade-inventories-sales-api')).toMatchObject({
      evidenceMode: 'official-retail-demand-category-series',
    });
    expect(retailTradePack.replies[0].body.conversationHints.join(' ')).toMatch(/MRTS\/MARTS\/MTIS/);
    expect(retailTradePack.replies[0].body.conversationHints.join(' ')).toMatch(/company-specific sales/);

    const energyFuelPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'energy-fuel', limit: 10 },
    });

    expect(energyFuelPack.ok).toBe(true);
    expect(energyFuelPack.replies[0].body.pack).toBe('energy-fuel');
    expect(energyFuelPack.replies[0].body.sources.map((source) => source.id)).toContain('eia-open-data');
    expect(energyFuelPack.replies[0].body.sources.map((source) => source.id)).toContain('eia-api-v2');
    expect(energyFuelPack.replies[0].body.sources.map((source) => source.id)).toContain('eia-gasoline-diesel-fuel-update');
    expect(energyFuelPack.replies[0].body.sources.find((source) => source.id === 'eia-api-v2')).toMatchObject({
      evidenceMode: 'official-energy-fuel-price-volume-series',
    });
    expect(energyFuelPack.replies[0].body.conversationHints.join(' ')).toMatch(/energy fuel price\/volume evidence/);
    expect(energyFuelPack.replies[0].body.conversationHints.join(' ')).toMatch(/EIA key/);

    const energyFuelSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'EIA API v2 gasoline prices diesel prices petroleum product supplied retail fuel volumes refinery output inventories electricity sales prices natural gas sales prices shipping logistics',
        limit: 5,
      },
    });

    expect(energyFuelSearch.ok).toBe(true);
    expect(energyFuelSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'eia-api-v2',
      evidenceMode: 'official-energy-fuel-price-volume-series',
    });

    const foodRetailPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'food-retail', limit: 10 },
    });

    expect(foodRetailPack.ok).toBe(true);
    expect(foodRetailPack.replies[0].body.pack).toBe('food-retail');
    expect(foodRetailPack.replies[0].body.sources.map((source) => source.id)).toContain('usda-ers-weekly-retail-food-sales');
    expect(foodRetailPack.replies[0].body.sources.map((source) => source.id)).toContain('usda-ers-weekly-retail-food-sales-documentation');
    expect(foodRetailPack.replies[0].body.sources.find((source) => source.id === 'usda-ers-weekly-retail-food-sales')).toMatchObject({
      evidenceMode: 'official-food-retail-scanner-demand-series',
    });
    expect(foodRetailPack.replies[0].body.conversationHints.join(' ')).toMatch(/category-level scanner-demand/);
    expect(foodRetailPack.replies[0].body.conversationHints.join(' ')).toMatch(/UPC-level access/);

    const foodRetailSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'USDA ERS Weekly Retail Food Sales Circana scanner data grocery demand food category sales unit sales price-versus-volume public summary proprietary UPC',
        limit: 5,
      },
    });

    expect(foodRetailSearch.ok).toBe(true);
    expect(foodRetailSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'usda-ers-weekly-retail-food-sales',
      evidenceMode: 'official-food-retail-scanner-demand-series',
    });

    const foodPricesPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'food-prices', limit: 12 },
    });

    expect(foodPricesPack.ok).toBe(true);
    expect(foodPricesPack.replies[0].body.pack).toBe('food-prices');
    expect(foodPricesPack.replies[0].body.sources.map((source) => source.id)).toContain('usda-ams-market-news');
    expect(foodPricesPack.replies[0].body.sources.map((source) => source.id)).toContain('usda-ams-mymarketnews-api');
    expect(foodPricesPack.replies[0].body.sources.map((source) => source.id)).toContain('usda-ers-food-price-outlook');
    expect(foodPricesPack.replies[0].body.sources.find((source) => source.id === 'usda-ams-market-news')).toMatchObject({
      evidenceMode: 'official-agricultural-market-price-volume-series',
    });
    expect(foodPricesPack.replies[0].body.sources.find((source) => source.id === 'usda-ers-food-price-outlook')).toMatchObject({
      evidenceMode: 'official-food-price-expenditure-series',
    });
    expect(foodPricesPack.replies[0].body.conversationHints.join(' ')).toMatch(/agricultural commodity price\/volume evidence/);
    expect(foodPricesPack.replies[0].body.conversationHints.join(' ')).toMatch(/food-price products/);

    const agriculturalMarketSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'USDA AMS Market News MyMarketNews agricultural commodity prices volume beef pork poultry dairy eggs grains fruits vegetables specialty crops livestock wholesale retail shipping data',
        limit: 5,
      },
    });

    expect(agriculturalMarketSearch.ok).toBe(true);
    expect(agriculturalMarketSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'usda-ams-market-news',
      evidenceMode: 'official-agricultural-market-price-volume-series',
    });

    const ersFoodPriceSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'USDA ERS Food Price Outlook current-year next-year food CPI PPI forecasts prediction interval historical forecast series monthly food price changes',
        limit: 5,
      },
    });

    expect(ersFoodPriceSearch.ok).toBe(true);
    expect(ersFoodPriceSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'usda-ers-food-price-outlook',
      evidenceMode: 'official-food-price-expenditure-series',
    });

    const retailPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'retail', limit: 20 },
    });

    expect(retailPack.ok).toBe(true);
    expect(retailPack.replies[0].body.pack).toBe('retail');
    expect(retailPack.replies[0].body.sources.map((source) => source.id)).toContain('census-monthly-retail-trade-api');
    expect(retailPack.replies[0].body.sources.map((source) => source.id)).toContain('census-advance-monthly-retail-trade-api');
    expect(retailPack.replies[0].body.sources.find((source) => source.id === 'census-monthly-retail-trade-api')).toMatchObject({
      evidenceMode: 'official-retail-demand-category-series',
    });
    expect(retailPack.replies[0].body.conversationHints.join(' ')).toMatch(/category-level or aggregate retail\/trade evidence/);
    expect(retailPack.replies[0].body.conversationHints.join(' ')).toMatch(/UPC-level/);
    expect(retailPack.replies[0].body.conversationHints.join(' ')).toMatch(/Amazon Best Sellers/);
    expect(retailPack.replies[0].body.conversationHints.join(' ')).toMatch(/Walmart/);

    const amazonProductSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'Amazon Movers and Shakers sales rank acceleration household cleaning product demand',
        limit: 10,
      },
    });

    expect(amazonProductSearch.ok).toBe(true);
    expect(amazonProductSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'amazon-movers-and-shakers',
      'amazon-best-sellers-household-supplies',
    ]));
    expect(amazonProductSearch.replies[0].body.sources.find((source) => source.id === 'amazon-movers-and-shakers')).toMatchObject({
      evidenceMode: 'scraped-retail-product-rank-signal',
    });

    const walmartProductSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'Walmart bought since yesterday low stock cleaning sponges bestsellers',
        limit: 10,
      },
    });

    expect(walmartProductSearch.ok).toBe(true);
    expect(walmartProductSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'walmart-cleaning-sponges-bestsellers',
      'walmart-household-supply-bestsellers',
    ]));
    expect(walmartProductSearch.replies[0].body.sources.find((source) => source.id === 'walmart-cleaning-sponges-bestsellers')).toMatchObject({
      evidenceMode: 'scraped-retail-product-rank-signal',
    });

    const retailSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'Census MRTS API monthly retail trade inventory-to-sales category_code data_type_code nonstore ecommerce',
        limit: 5,
      },
    });

    expect(retailSearch.ok).toBe(true);
    expect(retailSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'census-monthly-retail-trade-api',
      evidenceMode: 'official-retail-demand-category-series',
    });

    const manufacturingPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'manufacturing', limit: 10 },
    });

    expect(manufacturingPack.ok).toBe(true);
    expect(manufacturingPack.replies[0].body.pack).toBe('manufacturing');
    expect(manufacturingPack.replies[0].body.sources.map((source) => source.id)).toContain('census-manufacturers-shipments-inventories-orders-api');
    expect(manufacturingPack.replies[0].body.sources.map((source) => source.id)).toContain('census-advance-durable-goods-m3-api');
    expect(manufacturingPack.replies[0].body.sources.find((source) => source.id === 'census-manufacturers-shipments-inventories-orders-api')).toMatchObject({
      evidenceMode: 'official-manufacturing-demand-supply-series',
    });
    expect(manufacturingPack.replies[0].body.conversationHints.join(' ')).toMatch(/upstream manufacturing activity/);
    expect(manufacturingPack.replies[0].body.conversationHints.join(' ')).toMatch(/advance-vs-full revisions/);

    const manufacturingSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'Census M3 API manufacturers shipments inventories orders new orders unfilled orders durable goods transportation equipment category_code data_type_code',
        limit: 5,
      },
    });

    expect(manufacturingSearch.ok).toBe(true);
    expect(manufacturingSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'census-manufacturers-shipments-inventories-orders-api',
      evidenceMode: 'official-manufacturing-demand-supply-series',
    });

    const droughtPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'drought', limit: 10 },
    });

    expect(droughtPack.ok).toBe(true);
    expect(droughtPack.replies[0].body.pack).toBe('drought');
    expect(droughtPack.replies[0].body.sources.map((source) => source.id)).toContain('usdm-home');
    expect(droughtPack.replies[0].body.sources.map((source) => source.id)).toContain('usdm-rest-web-service-info');
    expect(droughtPack.replies[0].body.sources.find((source) => source.id === 'usdm-rest-web-service-info')).toMatchObject({
      evidenceMode: 'official-weekly-drought-classification-series',
    });
    expect(droughtPack.replies[0].body.conversationHints.join(' ')).toMatch(/weekly drought-classification/);

    const droughtSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'USDM DSCI D0 D1 D2 D3 D4 drought severity statistics GeoJSON agriculture water utility',
        limit: 5,
      },
    });

    expect(droughtSearch.ok).toBe(true);
    expect(droughtSearch.replies[0].body.sources[0]).toMatchObject({
      evidenceMode: 'official-weekly-drought-classification-series',
    });

    const realtorSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'Realtor.com median listing price active listings market hotness zip code',
        limit: 5,
      },
    });

    expect(realtorSearch.ok).toBe(true);
    expect(realtorSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'realtor-com-research-data-library',
      evidenceMode: 'listing-market-not-completed-sales',
    });

    const redfinSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'Redfin homes sold median sale price sale-to-list ratio zip county city',
        limit: 5,
      },
    });

    expect(redfinSearch.ok).toBe(true);
    expect(redfinSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'redfin-data-center',
      evidenceMode: 'completed-sales-local-market',
    });

    const safetyPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'safety', limit: 10 },
    });

    expect(safetyPack.ok).toBe(true);
    expect(safetyPack.replies[0].body.pack).toBe('safety');
    expect(safetyPack.replies[0].body.sources.map((source) => source.id)).toContain('cpsc-consumer-product-recalls-api');
    expect(safetyPack.replies[0].body.sources.map((source) => source.id)).toContain('openfda-food-enforcement-api');
    expect(safetyPack.replies[0].body.sources.map((source) => source.id)).toContain('usda-fsis-recalls-public-health-alerts');
    expect(safetyPack.replies[0].body.sources.map((source) => source.id)).toContain('nhtsa-recalls-by-vehicle-api');
    expect(safetyPack.replies[0].body.sources.find((source) => source.id === 'cpsc-consumer-product-recalls-api')).toMatchObject({
      evidenceMode: 'official-consumer-product-recall-risk',
    });
    expect(safetyPack.replies[0].body.sources.find((source) => source.id === 'openfda-food-enforcement-api')).toMatchObject({
      evidenceMode: 'official-food-recall-enforcement-risk',
    });
    expect(safetyPack.replies[0].body.sources.find((source) => source.id === 'usda-fsis-recalls-public-health-alerts')).toMatchObject({
      evidenceMode: 'official-meat-poultry-egg-recall-risk',
    });
    expect(safetyPack.replies[0].body.sources.find((source) => source.id === 'nhtsa-recalls-by-vehicle-api')).toMatchObject({
      evidenceMode: 'official-vehicle-recall-risk',
    });
    expect(safetyPack.replies[0].body.conversationHints.join(' ')).toMatch(/CPSC recall records/);
    expect(safetyPack.replies[0].body.conversationHints.join(' ')).toMatch(/FDA food enforcement/);
    expect(safetyPack.replies[0].body.conversationHints.join(' ')).toMatch(/USDA FSIS/);
    expect(safetyPack.replies[0].body.conversationHints.join(' ')).toMatch(/NHTSA vehicle/);

    const cpscSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'CPSC consumer product recalls manufacturer retailer hazard injury remedy affected units',
        limit: 5,
      },
    });

    expect(cpscSearch.ok).toBe(true);
    expect(cpscSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'cpsc-consumer-product-recalls-api',
      evidenceMode: 'official-consumer-product-recall-risk',
    });

    const foodRecallSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'openFDA food enforcement recalling firm product description classification distribution pattern product quantity',
        limit: 5,
      },
    });

    expect(foodRecallSearch.ok).toBe(true);
    expect(foodRecallSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'openfda-food-enforcement-api',
      evidenceMode: 'official-food-recall-enforcement-risk',
    });

    const fsisSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'USDA FSIS meat poultry egg recalls establishment number pounds recalled geographic distribution health risk retail distribution',
        limit: 5,
      },
    });

    expect(fsisSearch.ok).toBe(true);
    expect(fsisSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'usda-fsis-recalls-public-health-alerts',
      evidenceMode: 'official-meat-poultry-egg-recall-risk',
    });

    const nhtsaSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'NHTSA recallsByVehicle campaign number manufacturer component defect summary consequence remedy vehicles affected completion analysis',
        limit: 5,
      },
    });

    expect(nhtsaSearch.ok).toBe(true);
    expect(nhtsaSearch.replies[0].body.sources[0]).toMatchObject({
      id: 'nhtsa-recalls-by-vehicle-api',
      evidenceMode: 'official-vehicle-recall-risk',
    });

    const vehicleSalesSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'BEA FRED TOTALSA ALTSALES DAUTOSAAR vehicle sales aggregate auto demand',
        limit: 6,
      },
    });

    expect(vehicleSalesSearch.ok).toBe(true);
    expect(vehicleSalesSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'bea-api',
      'fred-vehicle-total-sales',
      'fred-vehicle-light-sales',
      'fred-vehicle-domestic-auto-sales',
    ]));
    expect(vehicleSalesSearch.replies[0].body.sources[0].evidenceMode).toBe('official-vehicle-sales-aggregate-series');

    const marketScreenerPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'market-screener', limit: 36 },
    });

    expect(marketScreenerPack.ok).toBe(true);
    expect(marketScreenerPack.replies[0].body.pack).toBe('market-screener');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('finviz-screener');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('finviz-unusual-volume');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('tradingview-stock-screener');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('tradingview-us-premarket-gainers');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('yahoo-finance-equity-screener');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('yahoo-finance-analyst-ratings-screener');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('nasdaq-market-activity');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('nasdaq-earnings-calendar');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('nasdaq-company-insider-activity');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('marketbeat-analyst-ratings');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('marketbeat-price-target-changes');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('wallstreetzen-stock-screener');
    expect(marketScreenerPack.replies[0].body.sources.map((source) => source.id)).toContain('wallstreetzen-ticker-analysis');
    expect(marketScreenerPack.replies[0].body.sources.find((source) => source.id === 'finviz-screener')).toMatchObject({
      evidenceMode: 'scraped-market-screener-verify-before-trading',
    });
    expect(marketScreenerPack.replies[0].body.sources.find((source) => source.id === 'tradingview-stock-screener')).toMatchObject({
      evidenceMode: 'scraped-market-screener-verify-before-trading',
    });
    expect(marketScreenerPack.replies[0].body.sources.find((source) => source.id === 'yahoo-finance-equity-screener')).toMatchObject({
      evidenceMode: 'scraped-market-screener-verify-before-trading',
    });
    expect(marketScreenerPack.replies[0].body.sources.find((source) => source.id === 'nasdaq-earnings-calendar')).toMatchObject({
      evidenceMode: 'scraped-market-screener-verify-before-trading',
    });
    expect(marketScreenerPack.replies[0].body.sources.find((source) => source.id === 'marketbeat-analyst-ratings')).toMatchObject({
      evidenceMode: 'scraped-market-screener-verify-before-trading',
    });
    expect(marketScreenerPack.replies[0].body.sources.find((source) => source.id === 'wallstreetzen-stock-screener')).toMatchObject({
      evidenceMode: 'scraped-market-screener-verify-before-trading',
    });
    expect(marketScreenerPack.replies[0].body.conversationHints.join(' ')).toMatch(/FINVIZ, TradingView, Yahoo Finance, Nasdaq, MarketBeat, and WallStreetZen/);
    expect(marketScreenerPack.replies[0].body.conversationHints.join(' ')).toMatch(/FINRA fixed-income/);

    const consumerGoodsPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'consumer-goods-industry', limit: 10 },
    });

    expect(consumerGoodsPack.ok).toBe(true);
    expect(consumerGoodsPack.replies[0].body.pack).toBe('consumer-goods-industry');
    expect(consumerGoodsPack.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'stockanalysis-household-personal-products-industry',
      'yahoo-finance-household-personal-products-industry',
      'companiesmarketcap-consumer-goods-revenue',
      'fortune-500-revenue-ranking',
    ]));
    expect(consumerGoodsPack.replies[0].body.sources.find((source) => source.id === 'companiesmarketcap-consumer-goods-revenue')).toMatchObject({
      evidenceMode: 'scraped-consumer-goods-industry-discovery',
    });
    expect(consumerGoodsPack.replies[0].body.conversationHints.join(' ')).toMatch(/consumer-goods/);
    expect(consumerGoodsPack.replies[0].body.conversationHints.join(' ')).toMatch(/SEC filings/);

    const creditRiskPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'credit-risk', limit: 10 },
    });

    expect(creditRiskPack.ok).toBe(true);
    expect(creditRiskPack.replies[0].body.pack).toBe('credit-risk');
    expect(creditRiskPack.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'finra-data-portal',
      'finra-fixed-income',
      'finra-corp-agency-bonds',
      'finra-corp-agency-trade-activity',
    ]));
    expect(creditRiskPack.replies[0].body.sources[0].evidenceMode).toBe('official-fixed-income-credit-market-risk');

    const ownershipPack = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.pack',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'ownership', limit: 10 },
    });

    expect(ownershipPack.ok).toBe(true);
    expect(ownershipPack.replies[0].body.pack).toBe('ownership');
    expect(ownershipPack.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'sec-current-13f-hr-atom',
      'sec-current-sc-13d-atom',
      'sec-current-sc-13g-atom',
    ]));
    expect(ownershipPack.replies[0].body.sources[0].evidenceMode).toBe('official-sec-ownership-filing-signal');
    expect(ownershipPack.replies[0].body.conversationHints.join(' ')).toMatch(/13F holdings are delayed/);

    const finvizSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'FINVIZ unusual volume analyst upgrades latest insider buys quality growth screener',
        limit: 8,
      },
    });

    expect(finvizSearch.ok).toBe(true);
    expect(finvizSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'finviz-unusual-volume',
      'finviz-analyst-upgrades',
      'finviz-insider-latest-buys',
    ]));
    expect(finvizSearch.replies[0].body.sources[0].evidenceMode).toBe('scraped-market-screener-verify-before-trading');

    const tradingViewSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'TradingView pre-market gainers all time highs sector leadership relative strength',
        limit: 8,
      },
    });

    expect(tradingViewSearch.ok).toBe(true);
    expect(tradingViewSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'tradingview-us-premarket-gainers',
      'tradingview-us-all-time-highs',
      'tradingview-us-sectors',
    ]));
    expect(tradingViewSearch.replies[0].body.sources[0].evidenceMode).toBe('scraped-market-screener-verify-before-trading');

    const yahooFinanceSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'Yahoo Finance analyst ratings gainers losers most active trending quote financials cash flow',
        limit: 10,
      },
    });

    expect(yahooFinanceSearch.ok).toBe(true);
    expect(yahooFinanceSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'yahoo-finance-analyst-ratings-screener',
      'yahoo-finance-stock-gainers',
      'yahoo-finance-company-cash-flow',
    ]));
    expect(yahooFinanceSearch.replies[0].body.sources[0].evidenceMode).toBe('scraped-market-screener-verify-before-trading');

    const nasdaqSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'Nasdaq earnings calendar IPO calendar analyst research institutional holdings insider activity',
        limit: 10,
      },
    });

    expect(nasdaqSearch.ok).toBe(true);
    expect(nasdaqSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'nasdaq-earnings-calendar',
      'nasdaq-ipo-calendar',
      'nasdaq-company-institutional-holdings',
    ]));
    expect(nasdaqSearch.replies[0].body.sources[0].evidenceMode).toBe('scraped-market-screener-verify-before-trading');

    const gdacsSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'GDACS RSS GeoRSS global disaster alert earthquake tropical cyclone population exposure geometry',
        limit: 8,
      },
    });

    expect(gdacsSearch.ok).toBe(true);
    expect(gdacsSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'gdacs-home',
      'gdacs-rss-24h',
      'gdacs-rss-georss-feed-reference',
    ]));
    expect(gdacsSearch.replies[0].body.sources[0].evidenceMode).toBe('official-global-disaster-alert-series');

    const eonetSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'NASA EONET natural event satellite imagery wildfires severe storms volcanoes floods drought geometry magnitude',
        limit: 8,
      },
    });

    expect(eonetSearch.ok).toBe(true);
    expect(eonetSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'nasa-eonet-main',
      'nasa-eonet-current-open-events',
      'nasa-eonet-categories',
    ]));
    expect(eonetSearch.replies[0].body.sources[0].evidenceMode).toBe('official-natural-event-satellite-metadata-series');

    const reliefWebSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'ReliefWeb humanitarian reports disasters casualty displacement aid requirements situation reports conflict emergencies',
        limit: 8,
      },
    });

    expect(reliefWebSearch.ok).toBe(true);
    expect(reliefWebSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'reliefweb-main',
      'reliefweb-disasters-api',
      'reliefweb-reports-api',
    ]));
    expect(reliefWebSearch.replies[0].body.sources[0].evidenceMode).toBe('curated-humanitarian-disaster-report-series');

    const unhcrSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'UNHCR Refugee Data Finder refugees asylum seekers IDPs stateless country of origin host country trends',
        limit: 10,
      },
    });

    expect(unhcrSearch.ok).toBe(true);
    expect(unhcrSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'unhcr-refugee-data-finder',
      'unhcr-population-api',
      'unhcr-refugee-statistics-api-docs',
    ]));
    expect(unhcrSearch.replies[0].body.sources[0].evidenceMode).toBe('official-forced-displacement-population-series');

    const emdatSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'EM-DAT CRED historical disaster database economic losses deaths injuries affected displaced HDX package search',
        limit: 8,
      },
    });

    expect(emdatSearch.ok).toBe(true);
    expect(emdatSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'emdat-main',
      'emdat-hdx-package-search-api',
      'emdat-docs',
    ]));
    expect(emdatSearch.replies[0].body.sources[0].evidenceMode).toBe('historical-disaster-impact-loss-series');

    const usgsSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'USGS Earthquake Catalog FDSN GeoJSON PAGER MMI CDI tsunami seismic risk',
        limit: 8,
      },
    });

    expect(usgsSearch.ok).toBe(true);
    expect(usgsSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'usgs-earthquake-catalog-docs',
      'usgs-earthquake-query-api',
      'usgs-earthquake-m25-day-geojson-feed',
    ]));
    expect(usgsSearch.replies[0].body.sources[0].evidenceMode).toBe('official-earthquake-catalog-seismic-risk-series');

    const nwsSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'NWS active weather alerts Tornado Warning area point event severity urgency certainty User-Agent',
        limit: 8,
      },
    });

    expect(nwsSearch.ok).toBe(true);
    expect(nwsSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'nws-active-alerts-api',
      'nws-active-alerts-area-mo',
      'nws-active-alerts-event-tornado-warning',
    ]));
    expect(nwsSearch.replies[0].body.sources[0].evidenceMode).toBe('official-nws-weather-alert-risk');

    const nuclearSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'NRC power reactor status event notification scram shutdown current power CFR Part 21',
        limit: 8,
      },
    });

    expect(nuclearSearch.ok).toBe(true);
    expect(nuclearSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'nrc-event-notification-reports',
      'nrc-event-notification-lastmonth-raw',
      'nrc-power-reactor-status-last365-raw',
    ]));
    expect(nuclearSearch.replies[0].body.sources[0].evidenceMode).toBe('official-nuclear-facility-event-status-series');

    const wildfireSearch = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'NIFC WFIGS current fire perimeters acres containment preparedness level InciWeb',
        limit: 8,
      },
    });

    expect(wildfireSearch.ok).toBe(true);
    expect(wildfireSearch.replies[0].body.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'nifc-fire-information',
      'nifc-wfigs-current-interagency-fire-perimeters',
      'nifc-wfigs-current-perimeters-featureserver',
    ]));
    expect(wildfireSearch.replies[0].body.sources[0].evidenceMode).toBe('official-wildfire-incident-perimeter-preparedness-series');

    const share = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'source.catalog.share',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { pack: 'discovery', query: 'issuer paid press release verification', limit: 8 },
    });

    expect(share.ok).toBe(true);
    expect(share.replies[0].body.shared).toBe(true);
    expect(share.replies[0].body.pack.sources.some((source) => source.evidenceMode === 'issuer-paid-verify-before-scoring')).toBe(true);
  });

  it('exposes compact EIA energy/fuel snapshots over BMCL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `
        <h2>U.S. Regular Gasoline Prices</h2>
        <p>Gasoline Release Date: July 13, 2026</p>
        <table><tr><td>U.S.</td><td>3.475</td><td>3.445</td><td>3.512</td><td>NA</td><td>NA</td><td>0.067</td></tr></table>
        <h2>U.S. On-Highway Diesel Fuel Prices</h2>
        <table><tr><td>U.S.</td><td>4.020</td><td>4.080</td><td>4.175</td><td>NA</td><td>NA</td><td>0.095</td></tr></table>
        <h2>Residential Propane</h2>
      `,
      headers: { get: () => 'text/html' },
    });
    const user = userRepo.createUser({
      email: `mesh-eia-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'eia-energy-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'energy.eia.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      apiConfigured: false,
      fallbackUsed: true,
    });
    expect(result.replies[0].body.momentum).toMatch(/^energy-cost-pressure-/);
    expect(result.replies[0].body.latestSeries.map((item) => item.metric)).toEqual(expect.arrayContaining(['gasolinePrice', 'dieselPrice']));
    expect(result.replies[0].body.bmclUse).toMatch(/official EIA/);
  });

  it('exposes compact BEA/FRED vehicle-sales snapshots over BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => {
        const target = String(url);
        if (target.includes('TOTALSA')) {
          return 'observation_date,TOTALSA\n2025-06-01,15.4\n2026-05-01,15.8\n2026-06-01,16.2\n';
        }
        if (target.includes('ALTSALES')) {
          return 'observation_date,ALTSALES\n2025-06-01,14.6\n2026-05-01,15.0\n2026-06-01,15.5\n';
        }
        if (target.includes('DAUTOSAAR')) {
          return 'observation_date,DAUTOSAAR\n2025-06-01,2.7\n2026-05-01,2.9\n2026-06-01,3.1\n';
        }
        return '';
      },
      headers: { get: () => 'text/csv' },
    }));
    const user = userRepo.createUser({
      email: `mesh-vehicle-sales-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'vehicle-sales-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'vehicle.sales.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      beaApiConfigured: false,
      fredCsvUsed: true,
    });
    expect(result.replies[0].body.momentum).toMatch(/^vehicle-demand-/);
    expect(result.replies[0].body.latestSeries.map((item) => item.metric)).toEqual(expect.arrayContaining(['totalVehicleSales', 'lightVehicleSales', 'domesticAutoSales']));
    expect(result.replies[0].body.bmclUse).toMatch(/BEA\/FRED aggregate vehicle-sales/);
  });

  it('exposes compact BLS pricing snapshots over BMCL', async () => {
    let body = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          Results: {
            series: [
              {
                seriesID: 'CUUR0000SA0',
                data: [
                  { year: '2026', period: 'M06', periodName: 'June', value: '320.000', footnotes: [{}] },
                  { year: '2026', period: 'M05', periodName: 'May', value: '318.000', footnotes: [{}] },
                  { year: '2025', period: 'M06', periodName: 'June', value: '310.000', footnotes: [{}] },
                ],
              },
              {
                seriesID: 'WPUFD4',
                data: [
                  { year: '2026', period: 'M06', periodName: 'June', value: '145.000', footnotes: [{}] },
                  { year: '2026', period: 'M05', periodName: 'May', value: '143.000', footnotes: [{}] },
                  { year: '2025', period: 'M06', periodName: 'June', value: '139.000', footnotes: [{}] },
                ],
              },
            ],
          },
        }),
      };
    });
    const user = userRepo.createUser({
      email: `mesh-bls-pricing-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    providerCredentialRepo.save({
      userId: user.id,
      providerType: 'data-source',
      providerKey: 'bls',
      displayName: 'BLS Public Data API',
      fields: { apiKey: 'bls-key' },
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'bls-pricing-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'pricing.bls.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { startYear: 2025, endYear: 2026, seriesIds: ['CUUR0000SA0', 'WPUFD4'] },
    });

    expect(body.registrationkey).toBe('bls-key');
    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'bls-pricing',
      available: true,
      apiKeyConfigured: true,
      seriesCount: 2,
    });
    expect(result.replies[0].body.scores.marginPressure).toBeGreaterThan(50);
    expect(result.replies[0].body.bmclUse).toMatch(/official BLS/);
    expect(result.replies[0].body.caveat).toMatch(/not unit-sales volume/);
  });

  it('exposes compact GDACS disaster snapshots over BMCL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:gdacs="http://www.gdacs.org" xmlns:georss="http://www.georss.org/georss">
          <channel>
            <item>
              <title>Orange tropical cyclone in Philippines</title>
              <link>https://www.gdacs.org/report.aspx?eventtype=TC&amp;eventid=1001</link>
              <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
              <gdacs:eventtype>TC</gdacs:eventtype>
              <gdacs:alertlevel>Orange</gdacs:alertlevel>
              <gdacs:eventid>1001</gdacs:eventid>
              <geo:Point><geo:lat>13.4</geo:lat><geo:long>122.5</geo:long></geo:Point>
              <georss:point>13.4 122.5</georss:point>
              <gdacs:severity unit="km/h" value="165">Wind 165km/h</gdacs:severity>
              <gdacs:population unit="people" value="1500000">1.5 million people</gdacs:population>
              <gdacs:country>Philippines</gdacs:country>
              <gdacs:iso3>PHL</gdacs:iso3>
            </item>
          </channel>
        </rss>`,
      headers: { get: () => 'application/xml' },
    });
    const user = userRepo.createUser({
      email: `mesh-gdacs-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'gdacs-disaster-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'disaster.gdacs.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      eventCount: 1,
      highImpactCount: 1,
    });
    expect(result.replies[0].body.momentum).toMatch(/^global-disaster-risk-/);
    expect(result.replies[0].body.topEvents[0]).toMatchObject({ eventType: 'TC', alertLevel: 'Orange', iso3: 'PHL' });
    expect(result.replies[0].body.bmclUse).toMatch(/official GDACS/);
  });

  it('exposes compact NASA EONET natural-event snapshots over BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => String(url).includes('/categories')
        ? JSON.stringify({
          categories: [
            { id: 'wildfires', title: 'Wildfires', description: 'Fire events.' },
            { id: 'severeStorms', title: 'Severe Storms', description: 'Storm events.' },
          ],
        })
        : JSON.stringify({
          title: 'EONET Events',
          events: [
            {
              id: 'EONET_2001',
              title: 'Wildfire in California',
              closed: null,
              categories: [{ id: 'wildfires', title: 'Wildfires' }],
              sources: [{ id: 'InciWeb', url: 'https://inciweb.wildfire.gov/incident/2001' }],
              geometry: [{
                magnitudeValue: 9500,
                magnitudeUnit: 'acres',
                date: '2026-07-13T00:00:00Z',
                type: 'Point',
                coordinates: [-121.5, 39.4],
              }],
            },
          ],
        }),
      headers: { get: () => 'application/rss+xml; charset=utf-8' },
    }));
    const user = userRepo.createUser({
      email: `mesh-eonet-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'eonet-natural-event-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'disaster.eonet.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500, days: 30, limit: 25 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      eventCount: 1,
      openEventCount: 1,
    });
    expect(result.replies[0].body.momentum).toMatch(/^earth-natural-event-risk-/);
    expect(result.replies[0].body.topEvents[0]).toMatchObject({ id: 'EONET_2001', categoryIds: ['wildfires'] });
    expect(result.replies[0].body.bmclUse).toMatch(/NASA EONET/);
  });

  it('exposes compact ReliefWeb humanitarian snapshots over BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => String(url).includes('/disasters')
        ? JSON.stringify({
          data: [{
            id: 'DR-1001',
            href: 'https://api.reliefweb.int/v2/disasters/1001',
            fields: {
              name: 'Conflict and displacement in Country B',
              status: 'ongoing',
              type: [{ id: 4628, name: 'Conflict' }],
              country: [{ id: 2, name: 'Country B' }],
              date: { changed: '2026-07-13T00:00:00+00:00' },
              url: 'https://reliefweb.int/disaster/conflict-country-b',
            },
          }],
        })
        : JSON.stringify({
          data: [{
            id: 'RP-2001',
            href: 'https://api.reliefweb.int/v2/reports/2001',
            fields: {
              title: 'Country B situation report: displaced people need aid and health services',
              body: 'Humanitarian response reports displaced families, casualties, damaged roads, aid requirements, and emergency shelter needs.',
              url: 'https://reliefweb.int/report/country-b/situation-report',
              source: [{ id: 10, name: 'OCHA' }],
              country: [{ id: 2, name: 'Country B' }],
              disaster: [{ id: 'DR-1001', name: 'Conflict and displacement in Country B' }],
              theme: [{ id: 100, name: 'Coordination' }],
              format: [{ id: 8, name: 'Situation Report' }],
              date: { original: '2026-07-13T05:00:00+00:00' },
            },
          }],
        }),
      headers: { get: () => 'application/json' },
    }));
    const user = userRepo.createUser({
      email: `mesh-reliefweb-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    providerCredentialRepo.save({
      userId: user.id,
      providerType: 'data-source',
      providerKey: 'reliefweb',
      displayName: 'ReliefWeb',
      fields: { appName: 'approved-test-app' },
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'reliefweb-humanitarian-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'disaster.reliefweb.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500, limit: 10 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      appConfigured: true,
      disasterCount: 1,
      reportCount: 1,
    });
    expect(result.replies[0].body.momentum).toMatch(/^humanitarian-crisis-risk-/);
    expect(result.replies[0].body.topReports[0].title).toMatch(/situation report/i);
    expect(result.replies[0].body.bmclUse).toMatch(/ReliefWeb/);
  });

  it('exposes compact UNHCR refugee statistics snapshots over BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('/years/')) return jsonResponse({ items: [{ year: '2026' }, { year: '2025' }] });
      if (target.includes('/countries/')) return jsonResponse({ items: [{ code: 'SYR', iso: 'SYR', iso2: 'SY', name: 'Syrian Arab Republic', region: 'Western Asia' }] });
      if (target.includes('year=2026')) return jsonResponse({ items: [] });
      if (target.includes('coo_all=true')) {
        return jsonResponse({ items: [{ year: '2025', coo: 'SYR', coo_name: 'Syrian Arab Republic', coo_iso: 'SYR', refugees: '6500000', asylum_seekers: '100000', idps: '7200000' }] });
      }
      if (target.includes('coa_all=true')) {
        return jsonResponse({ items: [{ year: '2025', coa: 'TUR', coa_name: 'Turkiye', coa_iso: 'TUR', refugees: '3200000', asylum_seekers: '90000', stateless: '1000' }] });
      }
      if (target.includes('year=2025')) {
        return jsonResponse({ items: [{ year: '2025', refugees: '28461306', asylum_seekers: '8998097', idps: '64239352', stateless: '4477220', ooc: '2957025', oip: '7177473', hst: '26670162' }] });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });
    const user = userRepo.createUser({
      email: `mesh-unhcr-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'unhcr-refugee-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'humanitarian.unhcr.refugees.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500, limit: 50 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      latestYear: 2025,
    });
    expect(result.replies[0].body.totals.refugees).toBe(28461306);
    expect(result.replies[0].body.topOriginCountries[0].originName).toBe('Syrian Arab Republic');
    expect(result.replies[0].body.bmclUse).toMatch(/UNHCR Refugee Statistics/);
  });

  it('exposes compact EM-DAT historical disaster snapshots over BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => String(url).includes('package_search')
        ? JSON.stringify({
          success: true,
          result: {
            results: [{
              id: 'pkg-1',
              name: 'emdat-country-profile',
              title: 'EM-DAT historical disaster country profile',
              notes: 'Historical disasters with deaths, injuries, affected people, displaced people, economic damage, floods, storms, drought, earthquake, and international assistance.',
              dataset_date: '1900-01-01/2026-07-01',
              metadata_modified: '2026-07-11T00:00:00',
              dataset_source: 'Centre for Research on the Epidemiology of Disasters',
              license_other: 'Open for non-commercial use subject to EM-DAT terms. Registration may be required for detailed downloads.',
              isopen: true,
              resources: [{ id: 'res-1', name: 'EM-DAT CSV', format: 'CSV', url: 'https://data.humdata.org/download/emdat.csv' }],
            }],
          },
        })
        : JSON.stringify({
          success: true,
          result: {
            id: 'cred',
            name: 'cred',
            title: 'Centre for Research on the Epidemiology of Disasters',
            package_count: 135,
          },
        }),
      headers: { get: () => 'application/json' },
    }));
    const user = userRepo.createUser({
      email: `mesh-emdat-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'emdat-historical-disaster-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'disaster.emdat.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500, limit: 10 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      datasetCount: 1,
      registeredAccessRequired: true,
    });
    expect(result.replies[0].body.momentum).toMatch(/^historical-disaster-impact-modeling-/);
    expect(result.replies[0].body.topDatasets[0].title).toMatch(/historical disaster/i);
    expect(result.replies[0].body.bmclUse).toMatch(/EM-DAT\/CRED historical disaster-impact/);
  });

  it('exposes compact USGS earthquake snapshots over BMCL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          id: 'us7000abcd',
          properties: {
            mag: 7.1,
            place: 'near Honshu, Japan',
            time: Date.parse('2026-07-13T10:00:00Z'),
            updated: Date.parse('2026-07-13T10:15:00Z'),
            url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd',
            detail: 'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us7000abcd&format=geojson',
            felt: 240,
            cdi: 6.2,
            mmi: 7.1,
            alert: 'orange',
            tsunami: 1,
            sig: 980,
            magType: 'mww',
            type: 'earthquake',
            title: 'M 7.1 - near Honshu, Japan',
          },
          geometry: { type: 'Point', coordinates: [142.1, 38.2, 32] },
        }],
      }),
      headers: { get: () => 'application/geo+json' },
    });
    const user = userRepo.createUser({
      email: `mesh-usgs-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'usgs-earthquake-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'disaster.usgs.earthquake.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500, days: 30, minMagnitude: 4.5, limit: 10 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      eventCount: 1,
      highMagnitudeCount: 1,
      tsunamiCount: 1,
      maxMagnitude: 7.1,
    });
    expect(result.replies[0].body.momentum).toMatch(/^seismic-risk-/);
    expect(result.replies[0].body.scores.earthquakeRisk).toBeGreaterThan(60);
    expect(result.replies[0].body.bmclUse).toMatch(/USGS earthquake catalog/);
  });

  it('exposes compact NWS active weather alert snapshots over BMCL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        type: 'FeatureCollection',
        features: [{
          id: 'https://api.weather.gov/alerts/urn:oid:test-tornado',
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[[-90.8, 38.3], [-90.7, 38.3], [-90.7, 38.4], [-90.8, 38.4], [-90.8, 38.3]]],
          },
          properties: {
            id: 'urn:oid:test-tornado',
            '@id': 'https://api.weather.gov/alerts/urn:oid:test-tornado',
            areaDesc: 'St. Louis County',
            sent: '2026-07-13T15:00:00-05:00',
            effective: '2026-07-13T15:05:00-05:00',
            expires: '2026-07-13T15:45:00-05:00',
            status: 'Actual',
            messageType: 'Alert',
            category: 'Met',
            severity: 'Extreme',
            certainty: 'Observed',
            urgency: 'Immediate',
            event: 'Tornado Warning',
            headline: 'Tornado Warning issued for St. Louis County',
            description: 'A severe thunderstorm capable of producing a tornado was located near St. Louis.',
            instruction: 'Take shelter now.',
          },
        }],
      }),
      headers: { get: () => 'application/geo+json' },
    });
    const user = userRepo.createUser({
      email: `mesh-nws-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    providerCredentialRepo.save({
      userId: user.id,
      providerType: 'data-source',
      providerKey: 'nws-weather',
      displayName: 'NOAA/NWS Weather',
      fields: { userAgent: '(autotrader.test, ops@example.com)' },
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'nws-weather-alert-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'weather.nws.alerts.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500, area: 'MO', limit: 10 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      userAgentConfigured: true,
      alertCount: 1,
      severeAlertCount: 1,
    });
    expect(result.replies[0].body.momentum).toMatch(/^us-weather-alert-risk-/);
    expect(result.replies[0].body.scores.weatherAlertRisk).toBeGreaterThan(70);
    expect(result.replies[0].body.bmclUse).toMatch(/National Weather Service active alert/);
  });

  it('exposes compact NRC nuclear event snapshots over BMCL', async () => {
    const eventText = `Event Desc|En No|Site Name|Licensee Name|Region No|City Name|State Cd|County Name|License No|Agreement State Ind|Docket No|Notification Dt|Notification Time|Event Dt|Event Time|Time Zone|Last Updated Dt|Emergency Class|Cfr Cd1|Cfr Descr1|Scram Code 1|RX CRIT 1|Initial PWR 1|Current PWR 1|Event Text|
| Power Reactor|58001|Example Nuclear Station|Example Utility|2|Example City|GA|Example County|NPF-1|N|05000111|07/13/2026|11:05|07/13/2026|10:45|EDT|07/13/2026|Alert|50.72|Immediate notification|Y|Y|100|0|AUTOMATIC REACTOR SCRAM DUE TO TURBINE TRIP.`;
    const reactorText = `ReportDt|Unit|Power
7/13/2026 12:00:00 AM|Example Nuclear Station 1|0
7/13/2026 12:00:00 AM|Example Nuclear Station 2|82`;

    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('event-notification-rpt-lastmonth')) return textResponse(eventText);
      if (target.includes('PowerReactorStatusForLast365Days')) return textResponse(reactorText);
      throw new Error(`Unexpected fetch: ${target}`);
    });
    const user = userRepo.createUser({
      email: `mesh-nrc-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'nrc-nuclear-event-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'nuclear.nrc.events.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500, eventLimit: 10, reactorLimit: 10 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      eventCount: 1,
      offlineUnitCount: 1,
      deratedUnitCount: 1,
    });
    expect(result.replies[0].body.momentum).toMatch(/^nrc-nuclear-event-risk-/);
    expect(result.replies[0].body.scores.reactorOutage).toBeGreaterThan(40);
    expect(result.replies[0].body.bmclUse).toMatch(/NRC nuclear event\/status evidence/);
  });

  it('exposes compact NIFC wildfire snapshots over BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('/FeatureServer/0/query')) {
        return jsonResponse({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [[[-121.2, 38.4], [-121.0, 38.4], [-121.0, 38.6], [-121.2, 38.6], [-121.2, 38.4]]],
            },
            properties: {
              OBJECTID: 1,
              poly_IncidentName: 'Quartz Ridge',
              poly_IRWINID: '{IRWIN-1}',
              poly_GISAcres: 42000,
              poly_FeatureStatus: 'Active',
              poly_DateCurrent: 1783968000000,
              attr_IncidentTypeCategory: 'WF',
              attr_PercentContained: 22,
              attr_POOState: 'CA',
              attr_POOCounty: 'El Dorado',
            },
          }],
        });
      }
      if (target.includes('/api/feed/dcat-us/1.1.json')) {
        return jsonResponse({
          dataset: [{
            identifier: 'current-perimeters',
            title: 'WFIGS Current Interagency Fire Perimeters',
            landingPage: 'https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-interagency-fire-perimeters/about',
            keyword: ['WFIGS', 'wildfire', 'perimeter'],
            distribution: [{ title: 'GeoJSON', format: 'GeoJSON', accessURL: 'https://example.com/wfigs.geojson' }],
          }],
        });
      }
      if (target === 'https://www.nifc.gov/fire-information') {
        return { ok: true, text: async () => '<html><body>Current Preparedness Level PL 4</body></html>' };
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const user = userRepo.createUser({
      email: `mesh-nifc-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'nifc-wildfire-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'wildfire.nifc.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500, limit: 10 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      incidentCount: 1,
      largeFireCount: 1,
      preparednessLevel: 4,
    });
    expect(result.replies[0].body.scores.wildfireRisk).toBeGreaterThan(70);
    expect(result.replies[0].body.topIncidents[0]).toMatchObject({ name: 'Quartz Ridge', state: 'CA' });
    expect(result.replies[0].body.bmclUse).toMatch(/NIFC\/WFIGS/);
  });

  it('exposes compact U.S. Drought Monitor snapshots over BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('GetDroughtSeverityStatisticsByAreaPercent')) {
        return jsonResponse([
          { mapDate: '2026-07-07T00:00:00', areaOfInterest: 'CONUS', none: 33.1, d0: 66.9, d1: 47.2, d2: 29.99, d3: 11.23, d4: 0.96, statisticFormatID: 1 },
          { mapDate: '2026-06-30T00:00:00', areaOfInterest: 'CONUS', none: 34.3, d0: 65.7, d1: 45.8, d2: 27.2, d3: 10.1, d4: 0.8, statisticFormatID: 1 },
        ]);
      }
      if (target.includes('GetDSCI')) {
        return jsonResponse([
          { name: 'CONUS', mapDate: '2026-06-30T00:00:00', dsci: 151 },
          { name: 'CONUS', mapDate: '2026-07-07T00:00:00', dsci: 156 },
        ]);
      }
      if (target === 'https://droughtmonitor.unl.edu/') {
        return { ok: true, text: async () => '<html><body>Map released July 9, 2026 Data valid July 7, 2026 Data Cutoff is Tuesday at 8 a.m. EDT.</body></html>' };
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const user = userRepo.createUser({
      email: `mesh-usdm-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'usdm-drought-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'drought.usdm.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { timeoutMs: 2500, aoi: 'us', startDate: '7/1/2026', endDate: '7/7/2026' },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      available: true,
      areaOfInterest: 'CONUS',
      dsci: 156,
      mapReleaseDate: '2026-07-09',
    });
    expect(result.replies[0].body.droughtClassifications).toMatchObject({ d0: 66.9, d2: 29.99, d4: 0.96 });
    expect(result.replies[0].body.scores.agricultureRisk).toBeGreaterThan(50);
    expect(result.replies[0].body.bmclUse).toMatch(/Drought Monitor/);
  });

  it('lets agents invoke bounded crawler search and crawl requests over BMCL', async () => {
    const user = userRepo.createUser({
      email: `mesh-crawler-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'crawler-mesh' });
    const crawlSpy = vi.spyOn(crawleeCrawler, 'crawlAutonomousResearch').mockResolvedValue({
      pages: [{
        url: 'https://example.com/markets/ai-chip-earnings',
        title: 'AI chip earnings outlook',
        excerpt: 'Nvidia supplier revenue guidance improved after new product demand.',
        score: { relevance: 8, tags: ['earnings', 'revenue'] },
        userData: { type: 'bing-fallback-search', searchProvider: 'bing' },
      }],
      failures: [{
        url: 'https://www.google.com/search?q=AI+chip+earnings',
        error: 'request failed after 2 retries',
        userData: { searchProvider: 'google', query: 'AI chip earnings' },
      }],
      discovered: [],
      entityLeads: [{ name: 'Nvidia', symbol: 'NVDA', score: 4.2, evidence: [] }],
    });

    const search = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'crawler.search',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        query: 'AI chip earnings',
        maxRequests: 99,
        maxWaves: 9,
      },
    });

    expect(search.ok).toBe(true);
    expect(crawlSpy).toHaveBeenCalledWith(expect.objectContaining({
      queries: ['AI chip earnings'],
      maxRequests: 36,
      maxWaves: 4,
    }));
    expect(search.replies[0].body).toMatchObject({
      ok: true,
      mode: 'search',
      pageCount: 1,
      failureCount: 1,
    });
    expect(search.replies[0].body.pages[0]).toMatchObject({
      searchProvider: 'bing',
      title: 'AI chip earnings outlook',
    });

    const crawl = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'crawler.crawl',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        url: 'https://example.com/company',
        maxRequests: 1,
      },
    });

    expect(crawl.ok).toBe(true);
    expect(crawlSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      seedSources: [{ url: 'https://example.com/company', title: 'https://example.com/company', tags: ['bmcl-crawl'] }],
      maxRequests: 1,
    }));
    expect(crawl.replies[0].body.mode).toBe('crawl');
  });

  it('exposes FINVIZ screener snapshots over BMCL for agent market discovery', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(textResponse(`
      <table class="screener_table">
        <tr><th>No.</th><th>Ticker</th><th>Company</th><th>Sector</th><th>Industry</th><th>Country</th><th>Market Cap</th><th>P/E</th><th>Price</th><th>Change</th><th>Volume</th></tr>
        <tr><td>1</td><td><a href="quote.ashx?t=FNVZ&p=d">FNVZ</a></td><td>Finviz Signal Corp</td><td>Technology</td><td>Software</td><td>USA</td><td>3B</td><td>22</td><td>12.30</td><td>8.40%</td><td>2.1M</td></tr>
      </table>
    `));
    const user = userRepo.createUser({
      email: `mesh-finviz-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'finviz-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'market.finviz.screener.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { presetIds: ['top-gainers'], includeFundamental: false, limit: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'finviz',
      available: true,
      signalCount: 1,
    });
    expect(result.replies[0].body.topBullish[0]).toMatchObject({
      symbol: 'FNVZ',
      signal: 'Top Gainers',
    });
    expect(result.replies[0].body.bmclUse).toMatch(/scraped\/delayed/);
  });

  it('exposes TradingView screener snapshots over BMCL for agent momentum and sector discovery', async () => {
    vi.spyOn(global, 'fetch').mockImplementation((url) => Promise.resolve(textResponse(String(url).includes('sectorandindustry-sector')
      ? `
        <table>
          <tr><th>Sector</th><th>Market cap</th><th>Dividend yield</th><th>Change %</th><th>Volume</th><th>Industries</th><th>Stocks</th></tr>
          <tr><td><a href="/markets/stocks-usa/sectorandindustry-sector/electronic-technology/">Electronic Technology</a></td><td>24.3T USD</td><td>0.54%</td><td>2.21%</td><td>5.8B</td><td>12</td><td>814</td></tr>
        </table>
      `
      : `
        <table>
          <tr><th>Symbol</th><th>Name</th><th>Pre-mkt chg %</th><th>Pre-mkt price</th><th>Pre-mkt vol</th><th>Mkt cap</th></tr>
          <tr><td><a href="/symbols/NASDAQ-TVTX/">TVTX</a></td><td><a href="/symbols/NASDAQ-TVTX/">TradingView Test Corp</a></td><td>9.10%</td><td>4.20 USD</td><td>1.1M</td><td>88M USD</td></tr>
        </table>
      `)));
    const user = userRepo.createUser({
      email: `mesh-tradingview-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'tradingview-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'market.tradingview.screener.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { screenIds: ['pre-market-gainers'], includeSectors: true, limit: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'tradingview',
      available: true,
      signalCount: 1,
      sectorCount: 1,
    });
    expect(result.replies[0].body.topPreMarketGainers[0]).toMatchObject({
      symbol: 'TVTX',
      signal: 'Pre-market Gainers',
    });
    expect(result.replies[0].body.sectorLeaders[0]).toMatchObject({
      name: 'Electronic Technology',
    });
    expect(result.replies[0].body.bmclUse).toMatch(/TradingView market-screener/);
  });

  it('exposes Yahoo Finance screener snapshots over BMCL for agent market discovery', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(textResponse(`
      <table>
        <tr><th>Symbol</th><th>Name</th><th>Price</th><th>Change</th><th>Change %</th><th>Volume</th><th>Market Cap</th></tr>
        <tr><td><a href="/quote/YBM/">YBM</a></td><td><a href="/quote/YBM/">Yahoo BMCL Markets</a></td><td>9.90</td><td>+0.80</td><td>8.79%</td><td>1.4M</td><td>340M</td></tr>
      </table>
    `));
    const user = userRepo.createUser({
      email: `mesh-yahoo-finance-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'yahoo-finance-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'market.yahoo.screener.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { screenIds: ['gainers'], limit: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'yahoo-finance',
      available: true,
      signalCount: 1,
    });
    expect(result.replies[0].body.topGainers[0]).toMatchObject({
      symbol: 'YBM',
      signal: 'Stock Gainers',
    });
    expect(result.replies[0].body.bmclUse).toMatch(/Yahoo Finance market-screener/);
  });

  it('exposes Nasdaq market research snapshots over BMCL for agent catalyst discovery', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(textResponse(`
      <table>
        <tr><th>Symbol</th><th>Name</th><th>Price</th><th>Change %</th><th>Volume</th><th>Market Cap</th></tr>
        <tr><td><a href="/market-activity/stocks/nqbm">NQBM</a></td><td><a href="/market-activity/stocks/nqbm">Nasdaq BMCL Markets</a></td><td>$15.20</td><td>6.40%</td><td>1.6M</td><td>420M USD</td></tr>
      </table>
    `));
    const user = userRepo.createUser({
      email: `mesh-nasdaq-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'nasdaq-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'market.nasdaq.research.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { screenIds: ['earnings-calendar'], limit: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'nasdaq',
      available: true,
      signalCount: 1,
      earningsCatalystCount: 1,
    });
    expect(result.replies[0].body.earningsCatalysts[0]).toMatchObject({
      symbol: 'NQBM',
      signal: 'Earnings Calendar',
    });
    expect(result.replies[0].body.bmclUse).toMatch(/Nasdaq market research/);
  });

  it('exposes MarketBeat analyst snapshots over BMCL for agent broker-action research', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(textResponse(`
      <table>
        <tr><th>Ticker</th><th>Firm</th><th>Action</th><th>Rating</th><th>Target</th><th>Date</th></tr>
        <tr><td><a href="/stocks/NASDAQ/MBCL/forecast/">MBCL</a></td><td>BMCL Capital</td><td>upgraded</td><td>Hold to Buy</td><td>$12.00 to $18.00</td><td>2026-07-14</td></tr>
      </table>
    `));
    const user = userRepo.createUser({
      email: `mesh-marketbeat-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'marketbeat-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'market.marketbeat.analyst.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { screenIds: ['upgrades'], limit: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'marketbeat',
      available: true,
      signalCount: 1,
      bullishCount: 1,
    });
    expect(result.replies[0].body.topPositive[0]).toMatchObject({
      symbol: 'MBCL',
      action: 'upgrade',
      analystFirm: 'BMCL Capital',
    });
    expect(result.replies[0].body.bmclUse).toMatch(/MarketBeat analyst/);
  });

  it('exposes WallStreetZen snapshots over BMCL for agent quantitative-rating research', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(textResponse(`
      <table>
        <tr><th>Ticker</th><th>Company</th><th>Exchange</th><th>Industry</th><th>Zen Rating</th><th>Market Cap</th><th>Price</th><th>1d %</th><th>P/E</th><th>D/E</th></tr>
        <tr><td><a href="/stocks/us/nasdaq/wsza">WSZA</a></td><td>WALL ZEN ALPHA INC</td><td>NASDAQ</td><td>Software</td><td>A Strong Buy</td><td>$2.40B</td><td>$11.20</td><td>3.30%</td><td>21.20x</td><td>0.40</td></tr>
      </table>
    `));
    const user = userRepo.createUser({
      email: `mesh-wallstreetzen-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'wallstreetzen-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'market.wallstreetzen.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { screenIds: ['stock-screener'], limit: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'wallstreetzen',
      available: true,
      signalCount: 1,
      bullishCount: 1,
      ratedCount: 1,
    });
    expect(result.replies[0].body.topRated[0]).toMatchObject({
      symbol: 'WSZA',
      zenRating: 'A',
      recommendation: 'Strong Buy',
    });
    expect(result.replies[0].body.bmclUse).toMatch(/WallStreetZen quantitative-rating/);
  });

  it('exposes FINRA fixed-income snapshots over BMCL for credit-risk research', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(textResponse(`
      <main>
        <p>FINRA Fixed Income Data includes corporate bond trade activity and market statistics.</p>
        <table>
          <tr><th>Ticker</th><th>Issuer</th><th>CUSIP</th><th>Price</th><th>Yield</th><th>Spread</th><th>Trades</th><th>Rating</th></tr>
          <tr><td>ACME</td><td>Acme Capital Corp</td><td>123456AA1</td><td>Price 82.50</td><td>Yield 9.4%</td><td>Spread 475 bps</td><td>Trades 42</td><td>Rating B+ Watch Negative</td></tr>
        </table>
      </main>
    `));
    const user = userRepo.createUser({
      email: `mesh-finra-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'finra-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'market.finra.fixed-income.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { sourceIds: ['finra-corp-agency-trade-activity'], limit: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'finra',
      available: true,
      tradeSignalCount: 1,
      stressedCount: 1,
    });
    expect(result.replies[0].body.topCreditWeakness[0]).toMatchObject({
      symbol: 'ACME',
      creditStance: 'stressed',
      spreadBps: 475,
    });
    expect(result.replies[0].body.bmclUse).toMatch(/FINRA fixed-income/);
  });

  it('exposes SEC ownership snapshots over BMCL for institutional-holdings research', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(textResponse(`<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>SC 13D - Acme Activist Fund LP for Acme Robotics Inc</title>
          <updated>2026-07-14T12:00:00-04:00</updated>
          <link href="https://www.sec.gov/Archives/edgar/data/1234567/0001234567-26-000001-index.htm" />
          <summary>Form SC 13D CIK 1234567 Issuer: Acme Robotics Inc Ticker: ACME Percent Owned: 9.8% activist board proposal accession number 0001234567-26-000001</summary>
        </entry>
      </feed>`));
    const user = userRepo.createUser({
      email: `mesh-sec-ownership-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    providerCredentialRepo.save({
      userId: user.id,
      providerType: 'data-source',
      providerKey: 'sec-edgar',
      displayName: 'SEC EDGAR',
      fields: {
        userAgent: 'AutoTrader test test@example.com',
      },
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'sec-ownership-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'market.sec.ownership.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { feedTypes: ['SC 13D'], limit: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'sec-edgar-ownership',
      available: true,
      entryCount: 1,
      activistSignalCount: 1,
    });
    expect(result.replies[0].body.topActivistSignals[0]).toMatchObject({
      symbol: 'ACME',
      formType: 'SC 13D',
      percentOwned: 9.8,
    });
    expect(result.replies[0].body.caveat).toMatch(/13F holdings are delayed/);
    expect(result.replies[0].body.bmclUse).toMatch(/13F\/13D\/13G/);
  });

  it('exposes USAspending award snapshots over BMCL for government-contract research', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      json: async () => String(url).includes('spending_by_award_count')
        ? { results: [{ awardType: 'contracts', count: 1 }] }
        : {
            page_metadata: { total: 1 },
            results: [{
              'Award ID': 'CONT_AWD_BMCL',
              'Recipient Name': 'Lockheed Martin Corporation',
              'Award Amount': 99000000,
              'Start Date': '2026-07-01',
              'End Date': '2027-07-01',
              'Awarding Agency': 'Department of Defense',
              'Funding Agency': 'Department of Defense',
              'Description': 'Missile defense support for Ukraine security assistance',
              'Place of Performance Country Code': 'UKR',
              PSC: '1410',
              NAICS: '336414',
            }],
          },
      text: async () => '',
    }));
    const user = userRepo.createUser({
      email: `mesh-usaspending-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'usaspending-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'government.usaspending.awards.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        recipientNames: ['Lockheed Martin'],
        awardingAgency: 'Department of Defense',
        placeOfPerformanceCountry: 'UKR',
        limit: 1,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'usaspending',
      available: true,
      returnedAwardCount: 1,
      defenseAwardCount: 1,
      inferredConflictAwardCount: 1,
    });
    expect(result.replies[0].body.topAwards[0]).toMatchObject({
      recipientName: 'Lockheed Martin Corporation',
      demandType: 'defense-government-demand',
    });
    expect(result.replies[0].body.topAwards[0].conflictInference).toMatchObject({
      inferred: true,
      confidence: 'medium',
    });
    expect(result.replies[0].body.bmclUse).toMatch(/USAspending federal award/);
  });

  it('exposes DoD daily contract snapshots over BMCL for government-contract research', async () => {
    const rss = `<?xml version="1.0"?><rss><channel><item><title>Contracts for July 14, 2026</title><link>https://www.war.gov/News/Contracts/Contract/Article/1/contracts-for-july-14-2026/</link><description>Daily contracts</description><pubDate>Tue, 14 Jul 2026 21:00:00 GMT</pubDate></item></channel></rss>`;
    const html = `<main><h1>Contracts for July 14, 2026</h1><time datetime="2026-07-14T21:00:00Z"></time><div class="body"><p>Lockheed Martin Corp., Bethesda, Maryland, is awarded a $145,000,000 firm-fixed-price contract for missile defense software and tactical aircraft support. Work will be performed in Orlando, Florida, and Ukraine, and is expected to be completed by July 2028. Fiscal 2026 research, development, test and evaluation funds in the amount of $145,000,000 are being obligated at the time of award. Air Force Life Cycle Management Center, Wright-Patterson Air Force Base, Ohio, is the contracting activity.</p><p>Boeing Co., Arlington, Virginia, is awarded a $32.5 million modification for aircraft sustainment. Work will be performed in St. Louis, Missouri, and is expected to be completed by March 2027. Naval Air Systems Command, Patuxent River, Maryland, is the contracting activity.</p></div></main>`;
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => String(url).includes('/Article/1/') ? html : rss,
    }));
    const user = userRepo.createUser({
      email: `mesh-dod-contracts-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'dod-contracts-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'government.dod.contracts.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { limit: 2, includeDetails: true },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'dod-daily-contracts',
      available: true,
      contractCount: 2,
    });
    expect(result.replies[0].body.topContracts[0]).toMatchObject({
      contractorName: 'Lockheed Martin Corp.',
      awardValue: 145000000,
    });
    expect(result.replies[0].body.bmclUse).toMatch(/DoD\/War.gov/);
    expect(result.replies[0].body.caveat).toMatch(/USAspending/);
  });

  it('exposes SIPRI defense geopolitical snapshots over BMCL with measure guardrails', async () => {
    const fixtures = {
      'https://www.sipri.org/databases': '<main><h1>SIPRI Databases</h1><p>Arms Transfers Database, Arms Industry Database, Multilateral Peace Operations Database, Military Expenditure Database, arms embargoes and nuclear forces.</p></main>',
      'https://www.sipri.org/databases/milex': '<main><h1>Military Expenditure</h1><p>Military spending in local currency, current and constant US dollars, share of GDP, and per-capita terms.</p></main>',
      'https://www.sipri.org/databases/armstransfers': '<main><h1>Arms Transfers</h1><p>Major conventional arms transfers by supplier and recipient.</p></main>',
      'https://www.sipri.org/databases/armstransfers/sources-and-methods': '<main><h1>Sources and methods</h1><p>Trend Indicator Value TIV is a volume measure and does not represent financial value.</p></main>',
      'https://www.sipri.org/databases/armsindustry': '<main><h1>Arms Industry</h1><p>Top 100 arms-producing and military services companies based on open sources.</p></main>',
      'https://www.sipri.org/databases/financial-value-global-arms-trade': '<main><h1>Financial value</h1><p>National arms export reports use exports, licences, agreements and orders.</p></main>',
      'https://www.sipri.org/databases/embargoes': '<main><h1>Arms embargoes</h1><p>Arms embargo regulatory risk.</p></main>',
    };
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => fixtures[String(url)] || fixtures['https://www.sipri.org/databases'],
    }));
    const user = userRepo.createUser({
      email: `mesh-sipri-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'sipri-defense-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'defense.sipri.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { includePages: true },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'sipri',
      available: true,
    });
    expect(result.replies[0].body.datasets.map((dataset) => dataset.id)).toEqual(expect.arrayContaining([
      'military_expenditure',
      'arms_transfers',
      'arms_company_revenue',
    ]));
    expect(result.replies[0].body.measureDistinctions.arms_transfers).toMatch(/not a transaction price/);
    expect(result.replies[0].body.analysisRules.join(' ')).toMatch(/Use USAspending and DoD\/War\.gov/);
    expect(result.replies[0].body.bmclUse).toMatch(/measure-specific/);
  });

  it('exposes Census retail/trade snapshots over BMCL for consumer-demand research', async () => {
    const variables = {
      cell_value: { label: 'data value' },
      data_type_code: { label: 'item type' },
      category_code: { label: 'Industry list' },
      time_slot_id: { label: 'Time Slot' },
      time_slot_date: { label: 'Time Slot Date' },
      seasonally_adj: { label: 'Seasonally adjusted yes or no' },
      error_data: { label: 'Error data yes or no' },
    };
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      json: async () => String(url).includes('/variables')
        ? { variables }
        : [
          ['cell_value', 'data_type_code', 'category_code', 'time_slot_id', 'time_slot_date', 'seasonally_adj', 'error_data'],
          ['1120', 'SM', 'TOTAL', '202502', '2025-02', 'yes', 'no'],
          ['1000', 'SM', 'TOTAL', '202501', '2025-01', 'yes', 'no'],
        ],
    }));
    const user = userRepo.createUser({
      email: `mesh-census-retail-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    providerCredentialRepo.save({
      userId: user.id,
      providerType: 'data-source',
      providerKey: 'census-retail',
      displayName: 'Census Retail/Trade',
      fields: { apiKey: 'census-key' },
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'census-retail-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'commerce.census.retail.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { startTime: '2025-01', datasets: ['mrts', 'marts', 'mtis'] },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'census-retail-trade',
      available: true,
      apiKeyConfigured: true,
    });
    expect(result.replies[0].body.datasets.map((dataset) => dataset.id)).toEqual(['mrts', 'marts', 'mtis']);
    expect(result.replies[0].body.retailDemandScore).toBeGreaterThan(50);
    expect(result.replies[0].body.bmclUse).toMatch(/category-level retail/);
    expect(result.replies[0].body.caveat).toMatch(/individual products/);
  });

  it('exposes Amazon bestseller product-rank snapshots over BMCL for retail demand discovery', async () => {
    const html = `
      <div id="gridItemRoot" data-asin="B0AAAA1111">
        <span>#1</span>
        <a href="/dp/B0AAAA1111"><span class="_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">SparkleHome Microfiber Cleaning Cloths</span></a>
        <span>$12.99</span>
        <span>4.7 out of 5 stars</span>
        <span>12,345 ratings</span>
      </div>
      <div id="gridItemRoot" data-asin="B0BBBB2222">
        <span>#2</span>
        <a href="/dp/B0BBBB2222">KitchenPro Silicone Spatula Set</a>
        <span>300% increase in sales rank</span>
      </div>`;
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => html,
    });
    const user = userRepo.createUser({
      email: `mesh-amazon-bestsellers-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'amazon-bestseller-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'commerce.amazon.bestsellers.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { sourceIds: ['home-kitchen', 'movers-shakers'], limit: 2 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'amazon-bestsellers',
      available: true,
      signalCount: 4,
    });
    expect(result.replies[0].body.topProducts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        asin: 'B0AAAA1111',
        title: 'SparkleHome Microfiber Cleaning Cloths',
      }),
    ]));
    expect(result.replies[0].body.bmclUse).toMatch(/product-rank/);
    expect(result.replies[0].body.caveat).toMatch(/not absolute sales volume/);
  });

  it('exposes Walmart retail demand snapshots over BMCL for storefront demand discovery', async () => {
    const html = `
      <div data-item-id="12345">
        <span>#1</span>
        <a href="/ip/FreshClean-Microfiber-Sponges/12345"><span data-automation-id="product-title">FreshClean Microfiber Sponges</span></a>
        <span>$4.98</span>
        <span>$0.42/count</span>
        <span>4.6 out of 5 stars</span>
        <span>2,345 reviews</span>
        <span>1K+ bought since yesterday</span>
        <span>Best seller</span>
        <span>Low stock</span>
      </div>
      <div data-us-item-id="67890">
        <span>#2</span>
        <a href="/ip/HomeGlow-Storage-Bins/67890"><span data-testid="product-title">HomeGlow Storage Bins</span></a>
        <span>$19.97</span>
        <span>500+ bought since yesterday</span>
        <span>Available for pickup and delivery</span>
      </div>`;
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => html,
    });
    const user = userRepo.createUser({
      email: `mesh-walmart-retail-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'walmart-retail-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'commerce.walmart.retail.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { sourceIds: ['household-supply-bestsellers', 'top-100-home-trending'], limit: 2 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'walmart-retail-demand',
      available: true,
    });
    expect(result.replies[0].body.signalCount).toBeGreaterThan(0);
    expect(result.replies[0].body.topProducts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: '12345',
        title: 'FreshClean Microfiber Sponges',
        boughtSinceYesterday: 1000,
      }),
    ]));
    expect(result.replies[0].body.bmclUse).toMatch(/Walmart/);
    expect(result.replies[0].body.caveat).toMatch(/not audited sales/i);
  });

  it('exposes consumer-goods industry snapshots over BMCL for company discovery', async () => {
    const html = `
      <table>
        <tr><th>#</th><th>Company</th><th>Symbol</th><th>Market Cap</th><th>Revenue</th><th>Profit</th><th>P/E</th><th>Dividend</th></tr>
        <tr>
          <td>1</td>
          <td><a href="/stocks/pg/">Procter & Gamble</a></td>
          <td>PG</td>
          <td>$410.5B</td>
          <td>$84.0B</td>
          <td>$15.1B</td>
          <td>26.4</td>
          <td>2.3%</td>
        </tr>
      </table>`;
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => html,
    });
    const user = userRepo.createUser({
      email: `mesh-consumer-goods-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'consumer-goods-industry-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'market.consumer-goods.industry.snapshot',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { sourceIds: ['stockanalysis-household-personal-products'], limit: 2 },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'consumer-goods-industry',
      available: true,
    });
    expect(result.replies[0].body.topCompanies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: 'PG',
        companyName: 'Procter & Gamble',
      }),
    ]));
    expect(result.replies[0].body.bmclUse).toMatch(/consumer-goods/);
    expect(result.replies[0].body.caveat).toMatch(/not primary filings/i);
  });

  it('exposes Alpaca symbol eligibility over BMCL before Finnhub enrichment', async () => {
    const user = userRepo.createUser({
      email: `mesh-alpaca-eligibility-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    providerCredentialRepo.save({
      userId: user.id,
      providerType: 'broker',
      providerKey: 'alpaca',
      displayName: 'Alpaca',
      fields: { keyId: 'key', secretKey: 'secret', paper: 'true' },
    });
    alpacaAssetClient.__setClientFactoryForTests(() => ({
      getAsset: async () => ({ symbol: 'AAPL', name: 'Apple Inc.', status: 'active', tradable: true, exchange: 'NASDAQ' }),
    }));
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'alpaca-symbol-eligibility-mesh' });

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.research.source',
      op: 'market.alpaca.symbol.eligibility',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { symbol: 'AAPL', companyName: 'Apple' },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'alpaca',
      version: 'alpaca-asset-eligibility-v1',
      eligibility: {
        eligible: true,
        symbol: 'AAPL',
        companyName: 'Apple Inc.',
      },
    });
    expect(result.replies[0].body.bmclUse).toMatch(/Finnhub/);
  });

  it('invokes a registered handler when tell() dispatches to it, so fire-and-forget events actually do something', async () => {
    let received = null;
    brainMesh.registerHandler('agent.test.tell-target', 'test.signal.reported', (envelope) => {
      received = envelope.body;
      return { acknowledged: true };
    });

    brainMesh.tell({
      from: 'agent.test.tell-source',
      to: ['agent.test.tell-target'],
      kind: 'event',
      op: 'test.signal.reported',
      ctx: {},
      body: { value: 42 },
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual({ value: 42 });
  });

  it('returns the handler return value via reply() when using ask()', async () => {
    brainMesh.registerHandler('agent.test.ask-target', 'test.question.asked', (envelope) => ({
      answer: envelope.body.question === 'ping' ? 'pong' : 'unknown',
    }));

    const result = await brainMesh.ask({
      from: 'agent.test.ask-source',
      to: ['agent.test.ask-target'],
      op: 'test.question.asked',
      ctx: {},
      body: { question: 'ping' },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toEqual({ answer: 'pong' });
  });
});

function jsonResponse(data) {
  return {
    ok: true,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function textResponse(text) {
  return {
    ok: true,
    text: async () => text,
  };
}
