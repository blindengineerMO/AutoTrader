const researchRepo = require('../db/repositories/researchRepo');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const finnhub = require('./marketData/finnhubClient');
const webScrapeClient = require('./marketData/webScrapeClient');
const sourceLearning = require('./researchSourceLearningService');
const brainModelService = require('./brainModelService');
const ensembleService = require('./models/ensembleService');
const companyIntelligence = require('./companyIntelligenceService');
const investorPlaybook = require('./investorPlaybookService');
const jsonDatasetIndicators = require('./jsonDatasetIndicatorService');
const companyDiscovery = require('./companyDiscoveryService');
const chatResearch = require('./chatResearchService');
const financialEventWeights = require('./financialEventWeightingService');
const brainMesh = require('./brainMeshService');
const watcherAgentService = require('./watcherAgentService');
const crawleeCrawler = require('./crawleeResearchCrawlerService');
const { config } = require('../config');
const logger = require('../utils/logger');

const DEFAULT_UNIVERSE = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'AMD', 'META', 'SPY', 'QQQ'];
const PRICE_TIER_BONUS_THRESHOLD = watcherAgentService.PRICE_TIER_THRESHOLD;
const PRICE_TIER_BONUS_POINTS = 5;
const WATCHER_SIGNAL_BONUS_POINTS = 4;
const WATCHER_SIGNAL_MIN_AGREEING = 2;

const MAX_WATCHER_SIGNALS_PER_USER = 40;
const recentWatcherSignalsByUser = new Map();

// watcher.research.reported is broadcast via tell() from every watcher's hourly
// cycle; without this handler the top-level research agent showed "handlers":0
// and the signal was logged but never fed back into the next scoring pass.
brainMesh.registerHandler('agent.research.top-level', 'watcher.research.reported', (envelope) => {
  const userId = envelope.ctx?.userId;
  if (!userId || !envelope.body?.symbol) return { acknowledged: false };
  const list = recentWatcherSignalsByUser.get(userId) || [];
  list.push({
    symbol: envelope.body.symbol,
    predictedAction: envelope.body.predictedAction,
    localAiScore: envelope.body.localAiScore,
    receivedAt: new Date().toISOString(),
  });
  recentWatcherSignalsByUser.set(userId, list.slice(-MAX_WATCHER_SIGNALS_PER_USER));
  return { acknowledged: true };
});

function listRecentWatcherSignals(userId, symbol) {
  const signals = recentWatcherSignalsByUser.get(userId) || [];
  return symbol ? signals.filter((signal) => signal.symbol === symbol) : signals;
}

const NEWS_FEEDS = [
  { name: 'Yahoo Finance', region: 'US markets', url: 'https://finance.yahoo.com/news/rssindex' },
  { name: 'CNBC Economy', region: 'US economy', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { name: 'BBC Business', region: 'world business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { name: 'Google News World Business', region: 'world news', url: 'https://news.google.com/rss/search?q=world+economy+markets&hl=en-US&gl=US&ceid=US:en' },
  { name: 'MarketWatch Pulse', region: 'US markets', url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse' },
  { name: 'MarketWatch Top Stories', region: 'US markets', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'MarketWatch Bulletins', region: 'US markets', url: 'https://feeds.content.dowjones.io/public/rss/mw_bulletins' },
  { name: 'MarketWatch Realtime Headlines', region: 'US markets', url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines' },
  { name: 'CNBC Finance', region: 'US markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  { name: 'CNBC Economy (search feed)', region: 'US economy', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910' },
  { name: 'CNBC Earnings', region: 'US markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362' },
  { name: 'CNBC Business', region: 'US business', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768' },
  { name: 'CNBC Top News', region: 'US markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000116' },
  { name: 'WSJ Markets Main', region: 'US markets', url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain' },
  { name: 'WSJ US Business', region: 'US business', url: 'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness' },
  { name: 'Federal Reserve Press Releases', region: 'US monetary policy', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { name: 'CNBC Markets', region: 'US markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147' },
];

const THEMES = [
  { id: 'semiconductors', symbols: ['NVDA', 'AMD', 'TSM', 'SOXX'], terms: ['ai chip', 'semiconductor', 'gpu', 'datacenter', 'data center'] },
  { id: 'consumer', symbols: ['AMZN', 'WMT', 'COST', 'TGT', 'XLY'], terms: ['retail', 'consumer', 'sales', 'spending', 'holiday'] },
  { id: 'mega-cap-tech', symbols: ['AAPL', 'MSFT', 'GOOGL', 'META', 'QQQ'], terms: ['cloud', 'software', 'advertising', 'iphone', 'search'] },
  { id: 'energy', symbols: ['XLE', 'XOM', 'CVX'], terms: ['oil', 'gas', 'opec', 'energy', 'crude'] },
  { id: 'industrial-defense', symbols: ['LMT', 'RTX', 'CAT', 'XLI'], terms: ['defense', 'aerospace', 'infrastructure', 'manufacturing'] },
  { id: 'financials', symbols: ['JPM', 'BAC', 'XLF'], terms: ['bank', 'credit', 'loan', 'yield curve'] },
  { id: 'broad-market', symbols: ['SPY', 'QQQ', 'DIA', 'IWM'], terms: ['fed', 'inflation', 'rates', 'recession', 'jobs'] },
];

const POSITIVE_TERMS = ['beat', 'growth', 'surge', 'record', 'strong', 'rally', 'upbeat', 'profit', 'expand', 'accelerate'];
const NEGATIVE_TERMS = ['miss', 'fall', 'slump', 'weak', 'risk', 'warning', 'cut', 'lawsuit', 'recession', 'slowdown'];

async function runAutonomousResearch({ userId, watchlist = DEFAULT_UNIVERSE, researchRunId, onEvent = () => {} } = {}) {
  const meshConversation = brainMesh.startConversation({
    userId,
    topic: `autonomous-research${researchRunId ? `:${researchRunId}` : ''}`,
    metadata: { researchRunId, watchlist },
  });
  meshTell({
    conversation: meshConversation,
    from: 'brain.research.source',
    to: ['brain.discovery.company', 'brain.research.chat', 'brain.model.neural'],
    op: 'research.run.started',
    body: { watchlist, researchRunId },
    userId,
    researchRunId,
  });
  emit(onEvent, 'source-scan', 8, 'info', 'Collecting market, news, macro, and consumer-sales inputs.', {
    watchlist,
  });

  const [learned, news, macro, consumer, jsonDatasets] = await Promise.all([
    sourceLearning.collectLearnedResearch({ userId, researchRunId, onEvent }),
    collectNews(onEvent),
    collectMacroData(onEvent),
    collectConsumerSales(onEvent),
    jsonDatasetIndicators.collectJsonDatasetIndicators({ onEvent }),
  ]);
  meshTell({
    conversation: meshConversation,
    from: 'brain.research.source',
    to: ['brain.discovery.company', 'brain.research.chat'],
    op: 'research.collection.ready',
    body: {
      learnedObservations: learned.observations.length,
      learnedSources: learned.learnedSources.length,
      newsItems: news.items.length,
      macroIndicators: macro.indicators.length,
      consumerReports: consumer.reports.length,
      jsonDatasetSources: jsonDatasets.sourceList?.length || 0,
    },
    userId,
    researchRunId,
  });

  const valuableArticles = selectValuableArticles(news.items);
  if (valuableArticles.length) {
    emit(onEvent, 'crawlee-article-deep-crawl', 12, 'info', 'Following headline links of valuable articles for deeper research leads.', {
      articles: valuableArticles.map((article) => ({ title: article.title, url: article.link })),
    });
  }
  const deepCrawlResults = await Promise.allSettled(
    valuableArticles.map((article) => crawleeCrawler.crawlFromArticle({ article, onEvent }))
  );
  learned.entityLeads = learned.entityLeads || [];
  for (const result of deepCrawlResults) {
    if (result.status !== 'fulfilled') continue;
    learned.observations.push(
      ...result.value.pages.map((page) => ({ title: page.title, excerpt: page.excerpt, url: page.url }))
    );
    learned.entityLeads.push(...result.value.entityLeads);
  }

  const crawledDiscoveredCompanies = companyDiscovery.discoverCompanies({ news, learned, maxCandidates: 36 });
  const entityExpandedCompanies = await expandEntityLeadsWithFinnhub({
    userId,
    entityLeads: learned.entityLeads || [],
    onEvent,
  });
  const initialDiscoveredCompanies = mergeDiscoveredCompanies(crawledDiscoveredCompanies, entityExpandedCompanies).slice(0, 42);
  meshTell({
    conversation: meshConversation,
    from: 'brain.discovery.company',
    to: ['brain.research.chat', 'brain.intelligence.company'],
    op: 'candidate.discovery.ready',
    body: {
      candidates: initialDiscoveredCompanies.slice(0, 12).map((candidate) => ({
        symbol: candidate.symbol,
        companyName: candidate.companyName,
        themeHits: candidate.themeHits,
        method: candidate.discovery?.method,
        reason: candidate.discovery?.evidence?.[0]?.reason,
      })),
      entityLeads: (learned.entityLeads || []).slice(0, 12).map((lead) => ({
        name: lead.name,
        symbol: lead.symbol,
        score: lead.score,
      })),
    },
    userId,
    researchRunId,
  });
  const chatResearchResult = await chatResearch.runChatResearch({
    userId,
    news,
    learned,
    macro,
    consumer,
    jsonDatasets,
    discoveredCompanies: initialDiscoveredCompanies,
    onEvent,
  });
  meshTell({
    conversation: meshConversation,
    from: 'brain.research.chat',
    to: ['brain.research.source', 'brain.discovery.company'],
    op: 'chat.research.ready',
    body: {
      providers: chatResearchResult.providers.map((provider) => ({
        provider: provider.provider,
        available: provider.available,
        skipped: provider.skipped,
        error: provider.error,
      })),
      candidateHints: chatResearchResult.candidateHints.slice(0, 12),
      sourceHints: chatResearchResult.sourceHints.slice(0, 12),
    },
    userId,
    researchRunId,
  });
  const prePlan = buildPrePlan({ watchlist, news, macro, consumer, learned, jsonDatasets, chatResearch: chatResearchResult, discoveredCompanies: initialDiscoveredCompanies });
  meshTell({
    conversation: meshConversation,
    from: 'brain.discovery.company',
    to: ['brain.intelligence.company', 'brain.model.neural', 'brain.playbook.investor'],
    op: 'preplan.ready',
    body: {
      thesis: prePlan.thesis,
      candidates: prePlan.candidates.map((candidate) => ({
        symbol: candidate.symbol,
        theme: candidate.theme,
        themeHits: candidate.themeHits,
        fromChat: Boolean(candidate.chatResearch),
        fromCrawl: Boolean(candidate.discovery),
      })).slice(0, 30),
    },
    userId,
    researchRunId,
  });
  emit(onEvent, 'pre-plan', 38, 'debug', 'Generated first-pass opportunity map from news themes, crawled company discovery, and economic context.', {
    candidates: prePlan.candidates.map((c) => c.symbol),
    discoveredCompanies: prePlan.discoveredCompanies.map((c) => ({ symbol: c.symbol, score: c.themeHits, reason: c.discovery?.evidence?.[0]?.reason })),
    themes: prePlan.themes.slice(0, 6),
  });

  const quotes = await collectQuotes(prePlan.candidates.map((c) => c.symbol), { userId, onEvent });
  const companyIntel = await companyIntelligence.researchCompanies({
    userId,
    candidates: prePlan.candidates,
    macro,
    consumer,
    quotes,
    news,
    learned,
    onEvent,
  });
  const investorPlaybookSummary = investorPlaybook.getPlaybookSummary();
  const scored = scoreCandidates({ userId, candidates: prePlan.candidates, quotes, news, macro, consumer, learned, companyIntel, jsonDatasets, onEvent });

  for (const signal of scored) {
    try {
      const candidate = prePlan.candidates.find((c) => c.symbol === signal.symbol);
      watcherAgentService.ensureWatcherAgent(userId, {
        symbol: signal.symbol,
        companyName: candidate?.companyName,
        price: signal.price,
      });
    } catch (error) {
      logger.warn('Failed to ensure watcher agent for symbol', { symbol: signal.symbol, error: error.message });
    }
  }

  meshTell({
    conversation: meshConversation,
    from: 'brain.model.neural',
    to: ['brain.reporting', 'brain.evaluation'],
    op: 'candidate.scores.ready',
    body: {
      scored: scored.slice(0, 12).map((signal) => ({
        symbol: signal.symbol,
        localAiScore: signal.localAiScore,
        actionBias: signal.actionBias,
        theme: signal.theme,
      })),
    },
    userId,
    researchRunId,
  });

  emit(onEvent, 'financial-evaluation', 72, 'debug', 'Financial resource pass complete; ranking candidates by blended signal score.', {
    top: scored.slice(0, 6).map((s) => ({ symbol: s.symbol, score: s.localAiScore, actionBias: s.actionBias })),
  });

  const snapshot = researchRepo.create({
    userId,
    source: 'autonomous:news-macro-consumer-market',
    summary: {
      watchlist,
      fetchedAt: new Date().toISOString(),
      sourceStack: [
        ...learned.learnedSources.slice(0, 20).map((source) => ({
          name: source.title || source.url,
          type: `learned:${source.source_type}`,
          url: source.url,
          relevanceScore: source.relevance_score,
          credibilityScore: source.credibility_score,
          discoveryMethod: source.discovery_method,
        })),
        ...news.sources,
        ...macro.sources,
        ...consumer.sources,
        ...jsonDatasets.sourceList,
        {
          name: investorPlaybookSummary.title,
          type: investorPlaybookSummary.source?.type || 'local-research-artifact',
          url: investorPlaybookSummary.source?.path || 'tmp/data.json',
          investorCount: investorPlaybookSummary.investorCount,
        },
        { name: 'Finnhub quote API', type: 'market-data', url: 'https://finnhub.io/docs/api/quote' },
        { name: 'Yahoo Finance chart scrape fallback', type: 'market-data', url: 'https://query1.finance.yahoo.com/v8/finance/chart/SPY' },
        { name: 'Stooq CSV quote scrape fallback', type: 'market-data', url: 'https://stooq.com/q/l/' },
      ],
      newsBrief: news.items.slice(0, 10),
      learnedResearch: {
        observations: learned.observations.slice(0, 12).map((item) => ({
          url: item.url,
          title: item.title,
          excerpt: item.excerpt,
          score: item.score,
          followedLinks: item.links.slice(0, 5),
        })),
        discovered: learned.discovered,
        entityLeads: learned.entityLeads || [],
      },
      chatResearch: chatResearchResult,
      discoveredCompanies: prePlan.discoveredCompanies,
      macro,
      consumer,
      prePlan,
      evaluator: {
        localModel: 'brain.js NeuralNetwork via persisted JSON model',
        fallback: false,
        features: [
          'momentum',
          'volatility',
          'news sentiment',
          'theme pressure',
          'macro risk',
          'consumer strength',
          'broker factor intelligence',
          'high-earning investor indicator playbook',
          'public JSON dataset context',
        ],
      },
      jsonDatasets,
      investorPlaybook: investorPlaybookSummary,
      companyWorkspace: companyIntel.records.map((record) => ({
        symbol: record.symbol,
        companyName: record.company_name,
        compositeScore: record.summary.compositeScore,
        summary: record.summary.summary,
        factors: record.summary.factors,
      })),
      reportNarrative: buildResearchNarrative({ scored, news, macro, consumer, learned, investorPlaybookSummary, jsonDatasets }),
      evidence: quotes.map((q) => ({
        symbol: q.symbol,
        current: q.current,
        open: q.open,
        high: q.high,
        low: q.low,
        prevClose: q.prevClose,
        changePct: Number((q.changePct || 0).toFixed(2)),
      })),
    },
    signals: scored,
  });

  emit(onEvent, 'snapshot', 78, 'info', 'Persisted autonomous research snapshot.', {
    snapshotId: snapshot.id,
    signalCount: snapshot.signals.length,
  });
  meshTell({
    conversation: meshConversation,
    from: 'brain.reporting',
    to: ['brain.evaluation', 'brain.research.source'],
    op: 'research.snapshot.persisted',
    body: {
      snapshotId: snapshot.id,
      signalCount: snapshot.signals.length,
      top: snapshot.signals.slice(0, 5).map((signal) => ({ symbol: signal.symbol, score: signal.localAiScore })),
    },
    userId,
    researchRunId,
  });

  logger.info('Autonomous research complete', { userId, snapshotId: snapshot.id, signalCount: scored.length });
  return snapshot;
}

async function expandEntityLeadsWithFinnhub({ userId, entityLeads = [], onEvent }) {
  const finnhubCredentials = userId ? providerCredentialRepo.getSecret(userId, 'finnhub') : null;
  const apiKey = finnhubCredentials?.apiKey || config.finnhubApiKey;
  if (!apiKey || !entityLeads.length) {
    if (entityLeads.length) {
      emit(onEvent, 'entity-expansion', 33, 'warn', 'Crawled entity leads found, but Finnhub search is unavailable; retaining direct ticker leads only.', {
        entityLeads: entityLeads.slice(0, 10).map((lead) => ({ name: lead.name, symbol: lead.symbol, score: lead.score })),
      });
    }
    return entityLeads
      .filter((lead) => lead.symbol)
      .map((lead) => entityLeadToCandidate(lead, lead.symbol, lead.name));
  }

  const expanded = [];
  const searchable = entityLeads
    .filter((lead) => lead.name && !lead.symbol)
    .sort((a, b) => b.score - a.score)
    .slice(0, 24);
  for (const lead of searchable) {
    try {
      const matches = await finnhub.searchSymbol(lead.name, { apiKey });
      const match = matches.find((item) => item.type === 'Common Stock' && /^[A-Z.]{1,7}$/.test(item.symbol)) || matches.find((item) => /^[A-Z.]{1,7}$/.test(item.symbol));
      if (!match) continue;
      expanded.push(entityLeadToCandidate(lead, match.symbol, match.description || lead.name));
    } catch (err) {
      emit(onEvent, 'entity-expansion', 34, 'warn', 'Finnhub symbol search failed for crawled entity lead.', {
        entity: lead.name,
        error: err.message,
      });
    }
  }
  for (const lead of entityLeads.filter((item) => item.symbol).slice(0, 24)) {
    expanded.push(entityLeadToCandidate(lead, lead.symbol, lead.name));
  }
  emit(onEvent, 'entity-expansion', 35, 'debug', 'Expanded crawled entity leads into quoteable company candidates.', {
    entityLeads: entityLeads.length,
    expanded: expanded.slice(0, 12).map((item) => ({ symbol: item.symbol, companyName: item.companyName, score: item.themeHits })),
  });
  return expanded;
}

function entityLeadToCandidate(lead, symbol, companyName) {
  return {
    symbol: String(symbol || '').toUpperCase(),
    companyName: companyName || lead.name || symbol,
    theme: 'crawled-entity-expansion',
    themeHits: Math.max(2.2, Number(lead.score || 0)),
    discovery: {
      method: lead.symbol ? 'crawled-direct-ticker' : 'crawled-entity-finnhub-search',
      tags: ['entity-lead', lead.type || 'company'],
      evidence: (lead.evidence || []).slice(0, 5).map((item) => ({
        title: item.title,
        url: item.url,
        reason: `${item.reason}; mapped to ${symbol}`,
      })),
    },
    evidence: (lead.evidence || []).map((item) => item.reason).slice(0, 5),
  };
}

function mergeDiscoveredCompanies(...lists) {
  const map = new Map();
  for (const item of lists.flat()) {
    if (!item?.symbol) continue;
    const symbol = item.symbol.toUpperCase();
    const existing = map.get(symbol);
    if (!existing) {
      map.set(symbol, { ...item, symbol });
      continue;
    }
    existing.themeHits = Math.max(existing.themeHits || 0, item.themeHits || 0);
    existing.theme = existing.theme === item.theme ? existing.theme : `${existing.theme}+${item.theme}`;
    existing.discovery = existing.discovery || item.discovery;
    if (existing.discovery && item.discovery?.evidence) {
      existing.discovery.evidence = [...(existing.discovery.evidence || []), ...item.discovery.evidence].slice(0, 8);
    }
  }
  return [...map.values()].sort((a, b) => (b.themeHits || 0) - (a.themeHits || 0));
}

async function collectQuotes(symbols, { userId, onEvent }) {
  const uniqueSymbols = [...new Set(symbols)].slice(0, 30);
  const finnhubCredentials = userId ? providerCredentialRepo.getSecret(userId, 'finnhub') : null;
  const finnhubApiKey = finnhubCredentials?.apiKey || config.finnhubApiKey;
  let quotes = [];
  if (finnhubApiKey) {
    emit(onEvent, 'market-data', 48, 'debug', 'Checking Finnhub quote data before scrape fallback.', { symbols: uniqueSymbols });
    quotes = await finnhub.getQuotes(uniqueSymbols, { apiKey: finnhubApiKey });
  }
  if (!quotes.length) {
    emit(onEvent, 'market-data', 50, 'warn', 'No Finnhub credits/data available; using Yahoo/Stooq web scrape fallback.', {
      symbols: uniqueSymbols,
    });
    quotes = await webScrapeClient.getQuotes(uniqueSymbols);
  }
  return quotes;
}

async function collectNews(onEvent) {
  const settled = await Promise.allSettled(
    NEWS_FEEDS.map(async (feed) => {
      const text = await fetchText(feed.url, 7000);
      return { feed, items: parseRssItems(text, feed).slice(0, 8) };
    })
  );

  const items = [];
  const sources = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      sources.push({ name: result.value.feed.name, type: 'news-rss', region: result.value.feed.region, url: result.value.feed.url });
      items.push(...result.value.items);
    } else {
      emit(onEvent, 'news', 18, 'warn', 'News source unavailable; continuing with remaining feeds.', {
        error: result.reason.message,
      });
    }
  }
  emit(onEvent, 'news', 24, 'debug', 'News scan complete.', { articles: items.length, sources: sources.length });
  return { items, sources };
}

async function collectMacroData(onEvent) {
  const worldBankUrl = 'https://api.worldbank.org/v2/country/WLD/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=3';
  const usInflationUrl = 'https://api.worldbank.org/v2/country/US/indicator/FP.CPI.TOTL.ZG?format=json&per_page=3';
  const payload = { indicators: [], sources: [] };
  const requests = [
    { id: 'world-gdp-growth', name: 'World GDP growth', url: worldBankUrl },
    { id: 'us-cpi-inflation', name: 'US CPI inflation', url: usInflationUrl },
  ];

  for (const req of requests) {
    try {
      const data = await fetchJson(req.url, 7000);
      const latest = Array.isArray(data?.[1]) ? data[1].find((row) => row.value !== null) : null;
      if (latest) {
        payload.indicators.push({
          id: req.id,
          name: req.name,
          period: latest.date,
          value: Number(latest.value.toFixed(2)),
          source: 'World Bank',
        });
        payload.sources.push({ name: `World Bank ${req.name}`, type: 'macro-api', url: req.url });
      }
    } catch (err) {
      emit(onEvent, 'macro', 28, 'warn', 'Macro source unavailable; continuing with partial context.', {
        source: req.name,
        error: err.message,
      });
    }
  }

  payload.riskBias = inferMacroRisk(payload.indicators);
  emit(onEvent, 'macro', 31, 'debug', 'Global macro scan complete.', {
    indicators: payload.indicators.length,
    riskBias: payload.riskBias,
  });
  return payload;
}

async function collectConsumerSales(onEvent) {
  const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=RSAFS';
  const payload = { reports: [], sources: [], consumerBias: 'neutral' };
  try {
    const csv = await fetchText(url, 7000);
    const rows = csv.trim().split(/\r?\n/).slice(1).filter(Boolean);
    const latest = rows.at(-1);
    const prior = rows.at(-2);
    if (latest) {
      const [period, value] = latest.split(',');
      const [, priorValue] = prior?.split(',') || [];
      const numericValue = Number(value);
      const changePct = Number(priorValue) ? ((numericValue - Number(priorValue)) / Number(priorValue)) * 100 : 0;
      payload.reports.push({
        name: 'US advance retail and food services sales',
        period,
        value: numericValue,
        unit: 'millions USD',
        seasonallyAdjusted: true,
        monthOverMonthPct: Number(changePct.toFixed(2)),
        source: 'FRED RSAFS / US Census retail sales',
      });
      payload.sources.push({ name: 'FRED RSAFS retail and food services sales', type: 'consumer-sales-csv', url });
    }
  } catch (err) {
    emit(onEvent, 'consumer-sales', 34, 'warn', 'Consumer sales report unavailable; using news-derived consumer proxy.', {
      error: err.message,
    });
  }
  const latestChange = payload.reports[0]?.monthOverMonthPct;
  payload.consumerBias = latestChange > 0.3 ? 'constructive' : latestChange < -0.3 ? 'softening' : payload.reports.length ? 'neutral' : 'neutral';
  emit(onEvent, 'consumer-sales', 35, 'debug', 'Consumer sales scan complete.', {
    reports: payload.reports.length,
    consumerBias: payload.consumerBias,
  });
  return payload;
}

function buildPrePlan({ watchlist, news, macro, consumer, learned, jsonDatasets, chatResearch: chatResearchResult, discoveredCompanies: providedDiscoveredCompanies }) {
  const text = [
    news.items.map((item) => `${item.title} ${item.description}`).join(' '),
    learned.observations.map((item) => `${item.title} ${item.excerpt}`).join(' '),
  ].join(' ').toLowerCase();
  const themes = THEMES.map((theme) => {
    const hits = theme.terms.reduce((count, term) => count + occurrences(text, term), 0);
    return {
      id: theme.id,
      hits,
      symbols: theme.symbols,
      rationale: hits
        ? `${theme.id} appeared ${hits} time(s) in the collected news stream.`
        : `${theme.id} kept as a baseline market comparison.`,
    };
  }).sort((a, b) => b.hits - a.hits);

  const candidateMap = new Map();
  for (const symbol of watchlist) candidateMap.set(symbol, { symbol, theme: 'watchlist', themeHits: 0 });
  for (const theme of themes.slice(0, 4)) {
    for (const symbol of theme.symbols) {
      const existing = candidateMap.get(symbol);
      candidateMap.set(symbol, {
        symbol,
        theme: existing?.theme === 'watchlist' ? `${existing.theme}+${theme.id}` : theme.id,
        themeHits: Math.max(existing?.themeHits || 0, theme.hits),
      });
    }
  }
  const discoveredCompanies = providedDiscoveredCompanies || companyDiscovery.discoverCompanies({ news, learned });
  for (const discovered of discoveredCompanies) {
    const existing = candidateMap.get(discovered.symbol);
    candidateMap.set(discovered.symbol, {
      symbol: discovered.symbol,
      companyName: discovered.companyName,
      theme: existing?.theme ? `${existing.theme}+crawled-discovery` : discovered.theme,
      themeHits: Math.max(existing?.themeHits || 0, discovered.themeHits),
      discovery: discovered.discovery,
    });
  }
  for (const hint of chatResearchResult?.candidateHints || []) {
    const existing = candidateMap.get(hint.symbol);
    const discovery = {
      method: 'chat-research',
      tags: ['chat-research'],
      evidence: [{
        title: `${hint.providers?.join(', ') || 'chat'} research hint`,
        url: hint.sourceUrls?.[0],
        reason: hint.reasons?.[0] || hint.reason,
      }],
    };
    candidateMap.set(hint.symbol, {
      symbol: hint.symbol,
      companyName: hint.companyName || existing?.companyName,
      theme: existing?.theme ? `${existing.theme}+chat-research` : 'chat-research',
      themeHits: Math.max(existing?.themeHits || 0, 2 + (hint.confidence || 0.5) * 8),
      discovery: existing?.discovery || discovery,
      chatResearch: hint,
    });
  }

  return {
    thesis:
      'Start broad with US/world news, crawled web intelligence, macro risk, and consumer demand, then let discovered products/companies create quote-backed candidates.',
    macroRiskBias: macro.riskBias,
    consumerBias: consumer.consumerBias,
    jsonDatasetRiskScore: jsonDatasets?.compositeRiskScore,
    jsonDatasetOpportunityScore: jsonDatasets?.opportunityScore,
    learnedSourceCount: learned.learnedSources.length,
    learnedObservationCount: learned.observations.length,
    discoveredCompanies,
    chatResearchCandidateCount: chatResearchResult?.candidateHints?.length || 0,
    chatResearchSourceHintCount: chatResearchResult?.sourceHints?.length || 0,
    themes,
    candidates: [...candidateMap.values()]
      .sort((a, b) => {
        const aDiscovery = a.discovery ? 1 : 0;
        const bDiscovery = b.discovery ? 1 : 0;
        return bDiscovery - aDiscovery || (b.themeHits || 0) - (a.themeHits || 0);
      })
      .slice(0, 30),
  };
}

function scoreCandidates({ userId, candidates, quotes, news, macro, consumer, learned, companyIntel, jsonDatasets, onEvent }) {
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const intelBySymbol = new Map(companyIntel.records.map((record) => [record.symbol, record]));
  const newsText = [
    news.items.map((item) => `${item.title} ${item.description}`).join(' '),
    learned.observations.map((item) => `${item.title} ${item.excerpt}`).join(' '),
  ].join(' ').toLowerCase();
  const { net, record } = buildBrainScorer(userId);
  const scored = [];

  for (const candidate of candidates) {
    const quote = quoteBySymbol.get(candidate.symbol);
    if (!quote) continue;
    const changePct = Number((quote.changePct || 0).toFixed(2));
    const volatilityPct = quote.open ? Number((((quote.high - quote.low) / quote.open) * 100).toFixed(2)) : 0;
    const sentiment = sentimentFor(candidate, newsText);
    const macroRisk = macro.riskBias === 'risk-off' ? 0.75 : macro.riskBias === 'risk-on' ? 0.2 : 0.45;
    const consumerStrength = consumer.consumerBias === 'constructive' ? 0.65 : 0.45;
    const factorIntel = companyIntelligence.factorScoreForSymbol(intelBySymbol.get(candidate.symbol));
    const historicalWatchFactors = factorIntel.historicalWatchFactors || [];
    const playbookIntel = investorPlaybook.scoreCandidate({
      candidate,
      quote,
      changePct,
      volatilityPct,
      sentiment,
      macro,
      consumer,
      companyRecord: intelBySymbol.get(candidate.symbol),
      factorIntel,
    });
    const datasetIntel = jsonDatasetIndicators.scoreCandidate({
      candidate,
      companyRecord: intelBySymbol.get(candidate.symbol),
      datasetContext: jsonDatasets,
    });
    const eventWeightIntel = financialEventWeights.scoreCandidateEvidence({
      candidate,
      news,
      learned,
      chatResearch: candidate.chatResearch,
    });
    const input = {
      momentum: clamp01((changePct + 8) / 16),
      volatility: clamp01(volatilityPct / 8),
      news: clamp01((sentiment + 4) / 8),
      theme: clamp01((candidate.themeHits || 0) / 8),
      macroRisk,
      consumer: consumerStrength,
      brokerFactors: factorIntel.normalized,
      historicalWatchFactors: factorIntel.historicalWatchNormalized ?? 0.5,
      investorPlaybook: playbookIntel.normalized,
      jsonDatasets: datasetIntel.normalized,
      financialEvents: eventWeightIntel.normalized,
    };
    const output = net.run(input);
    const brainNetScore01 = clamp01(output.score || output[0] || 0);
    const ensemble = ensembleService.scoreEnsemble({
      userId,
      input,
      brainNetScore01,
      trainingData: CANDIDATE_SCORER_TRAINING_DATA,
    });
    const eventScoreAdjustment = clamp(eventWeightIntel.aggregateScore * 2.2, -18, 18);
    const baseLocalAiScore = Number(clamp(ensemble.combined * 100 + eventScoreAdjustment, 0, 100).toFixed(1));
    const priceTierBonusApplied = quote.current > 0 && quote.current < PRICE_TIER_BONUS_THRESHOLD;
    const priceTierAdjustedScore = priceTierBonusApplied
      ? Number(Math.min(100, baseLocalAiScore + PRICE_TIER_BONUS_POINTS).toFixed(1))
      : baseLocalAiScore;
    const watcherSignals = listRecentWatcherSignals(userId, candidate.symbol);
    const watcherBullish = watcherSignals.filter((signal) => signal.predictedAction === 'buy-candidate').length;
    const watcherBearish = watcherSignals.filter((signal) => signal.predictedAction === 'sell-or-avoid').length;
    const watcherSignalAdjustment = watcherBullish >= WATCHER_SIGNAL_MIN_AGREEING
      ? WATCHER_SIGNAL_BONUS_POINTS
      : watcherBearish >= WATCHER_SIGNAL_MIN_AGREEING
        ? -WATCHER_SIGNAL_BONUS_POINTS
        : 0;
    const localAiScore = Number(clamp(priceTierAdjustedScore + watcherSignalAdjustment, 0, 100).toFixed(1));
    const actionBias = localAiScore >= 66 && changePct > -2 ? 'buy-candidate' : localAiScore <= 36 ? 'sell-or-avoid' : 'hold-watch';
    scored.push({
      symbol: candidate.symbol,
      price: quote.current,
      changePct,
      volatilityPct,
      momentum: changePct > 1 ? 'bullish' : changePct < -1 ? 'bearish' : 'neutral',
      actionBias,
      localAiScore,
      baseLocalAiScore,
      priceTierBonusApplied,
      ensembleMemberScores: ensemble.memberScores,
      theme: candidate.theme,
      themeHits: candidate.themeHits,
      discovery: candidate.discovery || null,
      chatResearch: candidate.chatResearch || null,
      newsSentiment: sentiment,
      macroRisk: macro.riskBias,
      consumerBias: consumer.consumerBias,
      brokerFactorScore: factorIntel.compositeScore,
      investorPlaybookScore: playbookIntel.compositeScore,
      jsonDatasetScore: datasetIntel.compositeScore,
      financialEventScore: eventWeightIntel.aggregateScore,
      brainModelKey: record.model_key,
      evidence: {
        quote: {
          current: quote.current,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          prevClose: quote.prevClose,
        },
        featureInput: input,
        explanation: [
          `Momentum ${changePct}%`,
          `Volatility range ${volatilityPct}%`,
          ...(priceTierBonusApplied ? [`sub_20_priority_bonus: +${PRICE_TIER_BONUS_POINTS} pts for price under $${PRICE_TIER_BONUS_THRESHOLD} (base score ${baseLocalAiScore})`] : []),
          ...(watcherSignalAdjustment !== 0 ? [`watcher_agent_signal: ${watcherSignalAdjustment > 0 ? '+' : ''}${watcherSignalAdjustment} pts from ${watcherBullish} bullish / ${watcherBearish} bearish recent watcher reports`] : []),
          `News and learned-source sentiment score ${sentiment}`,
          `Theme ${candidate.theme} with ${candidate.themeHits || 0} hits`,
          ...(candidate.discovery?.evidence?.slice(0, 2).map((item) => `Crawled discovery: ${item.reason}`) || []),
          ...(candidate.chatResearch?.reasons?.slice(0, 2).map((reason) => `Chat research: ${reason}`) || []),
          `Macro bias ${macro.riskBias}`,
          `Consumer bias ${consumer.consumerBias}`,
          `Broker factor intelligence ${factorIntel.compositeScore}`,
          ...historicalWatchFactors.map((factor) => (
            `${factor.label} ${factor.score}: ${factor.stance}`
          )),
          `Investor playbook score ${playbookIntel.compositeScore}`,
          `Public JSON dataset score ${datasetIntel.compositeScore}`,
          `WEIGHT.md event score ${eventWeightIntel.aggregateScore} (${eventWeightIntel.topEvents.length} weighted events)`,
          ...datasetIntel.explanations,
          ...eventWeightIntel.topEvents.slice(0, 4).map((event) => (
            `Weighted ${event.event.direction} ${event.event.category}: ${event.event.type} => ${event.final_event_score}`
          )),
          ...playbookIntel.indicators.slice(0, 3).map((indicator) => `${indicator.indicator} ${indicator.score}: ${indicator.interpretation}`),
          ...factorIntel.explanations.slice(0, 4),
        ],
        investorPlaybook: {
          available: playbookIntel.available,
          title: playbookIntel.title,
          source: playbookIntel.source,
          score: playbookIntel.compositeScore,
          indicators: playbookIntel.indicators,
          investorMatches: playbookIntel.investorMatches,
          sellRisks: playbookIntel.sellRisks,
        },
        jsonDatasets: {
          score: datasetIntel.compositeScore,
          categoryImpacts: datasetIntel.categoryImpacts,
          compositeRiskScore: jsonDatasets?.compositeRiskScore,
          opportunityScore: jsonDatasets?.opportunityScore,
        },
        financialEvents: {
          model: eventWeightIntel.model,
          aggregateScore: eventWeightIntel.aggregateScore,
          normalized: eventWeightIntel.normalized,
          categoryImpacts: eventWeightIntel.categoryImpacts,
          topEvents: eventWeightIntel.topEvents,
          note: 'WEIGHT.md event scores update assumptions and ranking features; they do not directly authorize buy/sell orders.',
        },
        discovery: candidate.discovery || null,
        chatResearch: candidate.chatResearch || null,
        historicalWatchFactors,
      },
    });
  }

  if (!scored.length) {
    emit(onEvent, 'local-ai', 68, 'warn', 'No quote-backed candidates were available after source collection.', {});
  } else {
    emit(onEvent, 'local-ai', 66, 'debug', 'brain.js local evaluator scored quote-backed opportunities.', {
      model: 'NeuralNetwork',
      candidates: scored.length,
    });
  }

  return scored.sort((a, b) => b.localAiScore - a.localAiScore).slice(0, 12);
}

// Shared seed training set for both the brain.js net and the logistic
// regression ensemble member, so they're two independently-fit models over
// the same labeled feature space rather than one model wearing two hats.
const CANDIDATE_SCORER_TRAINING_DATA = [
  { input: { momentum: 0.9, volatility: 0.25, news: 0.85, theme: 0.8, macroRisk: 0.15, consumer: 0.8, brokerFactors: 0.9, historicalWatchFactors: 0.88, investorPlaybook: 0.9, jsonDatasets: 0.85, financialEvents: 0.92 }, output: { score: 0.95 } },
  { input: { momentum: 0.75, volatility: 0.35, news: 0.65, theme: 0.55, macroRisk: 0.35, consumer: 0.6, brokerFactors: 0.75, historicalWatchFactors: 0.72, investorPlaybook: 0.78, jsonDatasets: 0.72, financialEvents: 0.72 }, output: { score: 0.78 } },
  { input: { momentum: 0.55, volatility: 0.45, news: 0.5, theme: 0.35, macroRisk: 0.45, consumer: 0.5, brokerFactors: 0.55, historicalWatchFactors: 0.52, investorPlaybook: 0.55, jsonDatasets: 0.5, financialEvents: 0.5 }, output: { score: 0.52 } },
  { input: { momentum: 0.25, volatility: 0.8, news: 0.25, theme: 0.2, macroRisk: 0.75, consumer: 0.35, brokerFactors: 0.25, historicalWatchFactors: 0.2, investorPlaybook: 0.24, jsonDatasets: 0.22, financialEvents: 0.18 }, output: { score: 0.13 } },
  { input: { momentum: 0.75, volatility: 0.9, news: 0.4, theme: 0.4, macroRisk: 0.8, consumer: 0.4, brokerFactors: 0.35, historicalWatchFactors: 0.32, investorPlaybook: 0.34, jsonDatasets: 0.3, financialEvents: 0.28 }, output: { score: 0.27 } },
  { input: { momentum: 0.35, volatility: 0.2, news: 0.7, theme: 0.65, macroRisk: 0.25, consumer: 0.75, brokerFactors: 0.7, historicalWatchFactors: 0.68, investorPlaybook: 0.74, jsonDatasets: 0.76, financialEvents: 0.76 }, output: { score: 0.68 } },
  { input: { momentum: 0.65, volatility: 0.3, news: 0.45, theme: 0.35, macroRisk: 0.4, consumer: 0.45, brokerFactors: 0.85, historicalWatchFactors: 0.8, investorPlaybook: 0.82, jsonDatasets: 0.7, financialEvents: 0.68 }, output: { score: 0.72 } },
];

function buildBrainScorer(userId) {
  return brainModelService.loadOrTrain({
    userId,
    modelKey: 'candidate-factor-scorer-v6-history-watch-factors',
    hiddenLayers: [10, 6],
    iterations: 100,
    metadata: {
      purpose: 'Scores trade candidates using market signals, broker-style factor intelligence, historical watch factors, high-earning investor playbooks, public JSON dataset context, and WEIGHT.md financial-event multipliers.',
      exportedFormat: 'brain.js toJSON',
      inputFeatures: ['momentum', 'volatility', 'news', 'theme', 'macroRisk', 'consumer', 'brokerFactors', 'historicalWatchFactors', 'investorPlaybook', 'jsonDatasets', 'financialEvents'],
    },
    trainingData: CANDIDATE_SCORER_TRAINING_DATA,
  });
}

function buildResearchNarrative({ scored, news, macro, consumer, learned, investorPlaybookSummary, jsonDatasets }) {
  const leaders = scored.slice(0, 3).map((s) => `${s.symbol} (${s.localAiScore})`).join(', ') || 'none';
  return {
    summary: `Autonomous scan ranked ${leaders} highest after blending news, learned web sources, macro, consumer-sales, quote momentum, company factors, historical growth/value/split watch factors, investor playbook indicators, public JSON dataset signals, and WEIGHT.md event multipliers.`,
    newsItemCount: news.items.length,
    learnedSourceCount: learned.learnedSources.length,
    learnedObservationCount: learned.observations.length,
    investorPlaybook: investorPlaybookSummary,
    jsonDatasets,
    macroIndicators: macro.indicators,
    consumerReports: consumer.reports,
    topCandidates: scored.slice(0, 5).map((s) => ({
      symbol: s.symbol,
      score: s.localAiScore,
      bias: s.actionBias,
      financialEventScore: s.financialEventScore,
      historicalWatchFactors: s.evidence.historicalWatchFactors,
      reasons: s.evidence.explanation,
    })),
  };
}

function sentimentFor(candidate, text) {
  const themeLabel = candidate.theme || '';
  const terms = [candidate.symbol.toLowerCase(), ...(THEMES.find((theme) => themeLabel.includes(theme.id))?.terms || [])];
  const relevantText = terms.some((term) => text.includes(term)) ? text : '';
  const scope = relevantText || text.slice(0, 2000);
  const positive = POSITIVE_TERMS.reduce((count, term) => count + occurrences(scope, term), 0);
  const negative = NEGATIVE_TERMS.reduce((count, term) => count + occurrences(scope, term), 0);
  return Math.max(-4, Math.min(4, positive - negative));
}

function selectValuableArticles(newsItems, { maxArticles = 6 } = {}) {
  return (newsItems || [])
    .filter((item) => item && item.link)
    .map((item) => {
      const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
      const themeHits = THEMES.reduce((count, theme) => count + theme.terms.reduce((c, term) => c + occurrences(text, term), 0), 0);
      const positive = POSITIVE_TERMS.reduce((count, term) => count + occurrences(text, term), 0);
      const negative = NEGATIVE_TERMS.reduce((count, term) => count + occurrences(text, term), 0);
      const score = themeHits * 2 + positive + negative;
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxArticles)
    .map(({ item }) => item);
}

function inferMacroRisk(indicators) {
  const inflation = indicators.find((item) => item.id === 'us-cpi-inflation')?.value;
  const worldGrowth = indicators.find((item) => item.id === 'world-gdp-growth')?.value;
  if (inflation > 4 || worldGrowth < 1.5) return 'risk-off';
  if (inflation < 3 && worldGrowth > 2.5) return 'risk-on';
  return 'mixed';
}

async function fetchJson(url, timeoutMs) {
  const res = await fetchWithTimeout(url, timeoutMs, { Accept: 'application/json,text/plain,*/*' });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.json();
}

async function fetchText(url, timeoutMs) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'application/rss+xml,application/xml,text/xml,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader autonomous research bot',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseRssItems(xml, feed) {
  const matches = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)];
  return matches.map((match) => {
    const item = match[0];
    return {
      source: feed.name,
      region: feed.region,
      title: decodeXml(pickTag(item, 'title')),
      link: decodeXml(pickTag(item, 'link')),
      publishedAt: decodeXml(pickTag(item, 'pubDate')),
      description: stripTags(decodeXml(pickTag(item, 'description'))).slice(0, 280),
    };
  });
}

function pickTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return (match?.[1] || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function occurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  return haystack.split(needle.toLowerCase()).length - 1;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

function meshTell({ conversation, from, to, op, body, userId, researchRunId }) {
  try {
    brainMesh.tell({
      from,
      to,
      kind: 'event',
      op,
      body,
      ctx: { userId, researchRunId },
      conv: conversation.id,
      trace: conversation.metadata?.trace,
      qos: { durable: true, priority: 'normal' },
    });
  } catch (err) {
    logger.warn('BrainMesh event failed', { op, error: err.message });
  }
}

module.exports = {
  runAutonomousResearch,
  DEFAULT_UNIVERSE,
  buildPrePlan,
  scoreCandidates,
  collectQuotes,
  NEWS_FEEDS,
  selectValuableArticles,
  listRecentWatcherSignals,
};
