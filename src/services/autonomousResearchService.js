const researchRepo = require('../db/repositories/researchRepo');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const finnhub = require('./marketData/finnhubClient');
const webScrapeClient = require('./marketData/webScrapeClient');
const sourceLearning = require('./researchSourceLearningService');
const brainModelService = require('./brainModelService');
const companyIntelligence = require('./companyIntelligenceService');
const investorPlaybook = require('./investorPlaybookService');
const jsonDatasetIndicators = require('./jsonDatasetIndicatorService');
const companyDiscovery = require('./companyDiscoveryService');
const chatResearch = require('./chatResearchService');
const { config } = require('../config');
const logger = require('../utils/logger');

const DEFAULT_UNIVERSE = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'AMD', 'META', 'SPY', 'QQQ'];

const NEWS_FEEDS = [
  { name: 'Yahoo Finance', region: 'US markets', url: 'https://finance.yahoo.com/news/rssindex' },
  { name: 'CNBC Economy', region: 'US economy', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { name: 'BBC Business', region: 'world business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { name: 'Google News World Business', region: 'world news', url: 'https://news.google.com/rss/search?q=world+economy+markets&hl=en-US&gl=US&ceid=US:en' },
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

  const initialDiscoveredCompanies = companyDiscovery.discoverCompanies({ news, learned });
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
  const prePlan = buildPrePlan({ watchlist, news, macro, consumer, learned, jsonDatasets, chatResearch: chatResearchResult, discoveredCompanies: initialDiscoveredCompanies });
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
    onEvent,
  });
  const investorPlaybookSummary = investorPlaybook.getPlaybookSummary();
  const scored = scoreCandidates({ userId, candidates: prePlan.candidates, quotes, news, macro, consumer, learned, companyIntel, jsonDatasets, onEvent });

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

  logger.info('Autonomous research complete', { userId, snapshotId: snapshot.id, signalCount: scored.length });
  return snapshot;
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
    const input = {
      momentum: clamp01((changePct + 8) / 16),
      volatility: clamp01(volatilityPct / 8),
      news: clamp01((sentiment + 4) / 8),
      theme: clamp01((candidate.themeHits || 0) / 8),
      macroRisk,
      consumer: consumerStrength,
      brokerFactors: factorIntel.normalized,
      investorPlaybook: playbookIntel.normalized,
      jsonDatasets: datasetIntel.normalized,
    };
    const output = net.run(input);
    const localAiScore = Number(((output.score || output[0] || 0) * 100).toFixed(1));
    const actionBias = localAiScore >= 66 && changePct > -2 ? 'buy-candidate' : localAiScore <= 36 ? 'sell-or-avoid' : 'hold-watch';
    scored.push({
      symbol: candidate.symbol,
      price: quote.current,
      changePct,
      volatilityPct,
      momentum: changePct > 1 ? 'bullish' : changePct < -1 ? 'bearish' : 'neutral',
      actionBias,
      localAiScore,
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
          `News and learned-source sentiment score ${sentiment}`,
          `Theme ${candidate.theme} with ${candidate.themeHits || 0} hits`,
          ...(candidate.discovery?.evidence?.slice(0, 2).map((item) => `Crawled discovery: ${item.reason}`) || []),
          ...(candidate.chatResearch?.reasons?.slice(0, 2).map((reason) => `Chat research: ${reason}`) || []),
          `Macro bias ${macro.riskBias}`,
          `Consumer bias ${consumer.consumerBias}`,
          `Broker factor intelligence ${factorIntel.compositeScore}`,
          `Investor playbook score ${playbookIntel.compositeScore}`,
          `Public JSON dataset score ${datasetIntel.compositeScore}`,
          ...datasetIntel.explanations,
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
        discovery: candidate.discovery || null,
        chatResearch: candidate.chatResearch || null,
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

function buildBrainScorer(userId) {
  return brainModelService.loadOrTrain({
    userId,
    modelKey: 'candidate-factor-scorer-v4-json-datasets',
    hiddenLayers: [9, 6],
    iterations: 100,
    metadata: {
      purpose: 'Scores trade candidates using market signals, broker-style factor intelligence, high-earning investor playbooks, and public JSON dataset context.',
      exportedFormat: 'brain.js toJSON',
      inputFeatures: ['momentum', 'volatility', 'news', 'theme', 'macroRisk', 'consumer', 'brokerFactors', 'investorPlaybook', 'jsonDatasets'],
    },
    trainingData: [
      { input: { momentum: 0.9, volatility: 0.25, news: 0.85, theme: 0.8, macroRisk: 0.15, consumer: 0.8, brokerFactors: 0.9, investorPlaybook: 0.9, jsonDatasets: 0.85 }, output: { score: 0.95 } },
      { input: { momentum: 0.75, volatility: 0.35, news: 0.65, theme: 0.55, macroRisk: 0.35, consumer: 0.6, brokerFactors: 0.75, investorPlaybook: 0.78, jsonDatasets: 0.72 }, output: { score: 0.78 } },
      { input: { momentum: 0.55, volatility: 0.45, news: 0.5, theme: 0.35, macroRisk: 0.45, consumer: 0.5, brokerFactors: 0.55, investorPlaybook: 0.55, jsonDatasets: 0.5 }, output: { score: 0.52 } },
      { input: { momentum: 0.25, volatility: 0.8, news: 0.25, theme: 0.2, macroRisk: 0.75, consumer: 0.35, brokerFactors: 0.25, investorPlaybook: 0.24, jsonDatasets: 0.22 }, output: { score: 0.13 } },
      { input: { momentum: 0.75, volatility: 0.9, news: 0.4, theme: 0.4, macroRisk: 0.8, consumer: 0.4, brokerFactors: 0.35, investorPlaybook: 0.34, jsonDatasets: 0.3 }, output: { score: 0.27 } },
      { input: { momentum: 0.35, volatility: 0.2, news: 0.7, theme: 0.65, macroRisk: 0.25, consumer: 0.75, brokerFactors: 0.7, investorPlaybook: 0.74, jsonDatasets: 0.76 }, output: { score: 0.68 } },
      { input: { momentum: 0.65, volatility: 0.3, news: 0.45, theme: 0.35, macroRisk: 0.4, consumer: 0.45, brokerFactors: 0.85, investorPlaybook: 0.82, jsonDatasets: 0.7 }, output: { score: 0.72 } },
    ],
  });
}

function buildResearchNarrative({ scored, news, macro, consumer, learned, investorPlaybookSummary, jsonDatasets }) {
  const leaders = scored.slice(0, 3).map((s) => `${s.symbol} (${s.localAiScore})`).join(', ') || 'none';
  return {
    summary: `Autonomous scan ranked ${leaders} highest after blending news, learned web sources, macro, consumer-sales, quote momentum, company factors, investor playbook indicators, and public JSON dataset signals.`,
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

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  runAutonomousResearch,
  DEFAULT_UNIVERSE,
  buildPrePlan,
  scoreCandidates,
};
