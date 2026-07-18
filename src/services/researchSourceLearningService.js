const researchSourceRepo = require('../db/repositories/researchSourceRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const crawleeResearchCrawler = require('./crawleeResearchCrawlerService');
const brainMesh = require('./brainMeshService');
const semanticResearchMemory = require('./semanticResearchMemoryService');
const {
  SPEC_DISCOVERY_QUERIES,
  SPEC_RELEVANCE_TERMS,
  toResearchSeedSources,
} = require('./spec/specDataSourceCatalog');
const logger = require('../utils/logger');

const DUCKDUCKGO_DISCOVERY_TIMEOUT_MS = 3500;

const BASE_SEED_SOURCES = [
  {
    url: 'https://library.bu.edu/bizdata/free-data',
    title: 'Boston University Free Business Data Resources',
    tags: ['seed', 'business-data', 'macro'],
    credibilityScore: 72,
  },
  {
    url: 'https://www.aeaweb.org/about-aea/committees/economic-statistics/data-resources',
    title: 'AEA Data Resources for Economists',
    tags: ['seed', 'economics', 'macro'],
    credibilityScore: 86,
  },
  {
    url: 'https://www.topdowncharts.com/post/2018/05/12/8-free-macro-and-market-data-sources',
    title: 'Topdown Charts Free Macro and Market Data Sources',
    tags: ['seed', 'market-data', 'macro'],
    credibilityScore: 66,
  },
  {
    url: 'https://yougov.com/en-us/ratings/news-websites',
    title: 'YouGov Popular News Websites',
    tags: ['seed', 'news', 'consumer'],
    credibilityScore: 62,
  },
  { url: 'https://fred.stlouisfed.org/', title: 'FRED Economic Data', tags: ['macro', 'market-data'], credibilityScore: 92 },
  { url: 'https://www.bea.gov/data', title: 'BEA Data', tags: ['macro', 'consumer'], credibilityScore: 88 },
  { url: 'https://www.bls.gov/data/', title: 'BLS Data', tags: ['labor', 'inflation'], credibilityScore: 88 },
  { url: 'https://data.worldbank.org/', title: 'World Bank Open Data', tags: ['global', 'macro'], credibilityScore: 88 },
  { url: 'https://www.imf.org/en/Data', title: 'IMF Data', tags: ['global', 'macro'], credibilityScore: 86 },
  { url: 'https://stats.oecd.org/', title: 'OECD Data Explorer', tags: ['global', 'macro'], credibilityScore: 84 },
  { url: 'https://www.bis.org/statistics/', title: 'BIS Statistics', tags: ['credit', 'global'], credibilityScore: 84 },
  { url: 'https://www.eia.gov/', title: 'EIA Energy Data', tags: ['energy', 'commodities'], credibilityScore: 84 },
  { url: 'https://www.census.gov/retail/index.html', title: 'Census Retail Sales', tags: ['consumer', 'sales'], credibilityScore: 84 },
  { url: 'https://www.commoncrawl.org/', title: 'Common Crawl', tags: ['web-index', 'discovery'], credibilityScore: 70 },
  ...crawleeResearchCrawler.CURATED_MARKET_NEWS_SITES.map((source) => ({
    url: source.url,
    title: source.name,
    tags: ['seed', ...source.tags],
    credibilityScore: source.credibilityScore,
    relevanceScore: 82,
    notes: 'Curated market-news source for autonomous scraping and site-scoped searches around new companies, existing companies, product launches, company announcements, earnings, acquisitions, and investor-impact news.',
  })),
];

const SEED_SOURCES = dedupeSources([...BASE_SEED_SOURCES, ...toResearchSeedSources()]);

const DISCOVERY_QUERIES = [
  'Whats in the news today',
  'free macro market data sources investment research',
  'US retail sales consumer spending data free',
  'global economic data market indicators free',
  'stock market sector news earnings macro data free',
  'company announcements new products launches earnings acquisitions stock market impact',
  'new public companies startups product launch funding partnership stock ticker',
  'existing company announces product expansion guidance revenue contract acquisition',
  ...SPEC_DISCOVERY_QUERIES,
];

const RELEVANCE_TERMS = [
  'market',
  'stock',
  'equity',
  'macro',
  'economy',
  'inflation',
  'consumer',
  'retail',
  'sales',
  'earnings',
  'rates',
  'gdp',
  'labor',
  'energy',
  'commodities',
  'financial',
  'data',
  ...SPEC_RELEVANCE_TERMS,
];

async function seedSources(userId) {
  return SEED_SOURCES.map((source) =>
    researchSourceRepo.upsert({
      userId,
      ...source,
      sourceType: 'seed',
      discoveryMethod: 'curated-seed',
      relevanceScore: source.relevanceScore || 70,
    })
  );
}

async function collectLearnedResearch({ userId, researchRunId, onEvent = () => {} }) {
  const settings = settingsRepo.get(userId);
  if (settings?.source_learning_enabled === 0) {
    emit(onEvent, 'source-learning', 12, 'warn', 'Source learning is disabled in Settings.');
    return { observations: [], learnedSources: researchSourceRepo.listActiveByUser(userId, 20), discovered: [] };
  }

  seedSources(userId);
  emit(onEvent, 'source-learning', 12, 'debug', 'Seeded and loaded research source memory.', {
    seeds: SEED_SOURCES.length,
  });

  const crawleeResult = await runCrawleeResearchDiscovery({ userId, researchRunId, onEvent });
  const discovered = [...crawleeResult.discovered.map((link) => link.url), ...(await discoverSources(userId, onEvent))];
  const sources = researchSourceRepo.listActiveByUser(userId, 8);
  const settled = await Promise.allSettled(sources.map(async (source) => {
    try {
      const observation = await scrapeSource({ userId, source, researchRunId, onEvent });
      const weightedSignal = Math.min(2, Math.abs(observation.score.weightedFinancialEvents?.aggregateScore || 0) * 0.25);
      researchSourceRepo.updateStats(source.id, {
        success: true,
        relevanceDelta: (observation.score.relevance >= 3 ? 1.2 : 0.2) + weightedSignal,
        credibilityDelta: 0.2,
      });

      for (const link of observation.links.slice(0, 6)) {
        if (link.score < 2.5) continue;
        researchSourceRepo.upsert({
          userId,
          url: link.url,
          title: link.text,
          sourceType: 'learned',
          discoveryMethod: 'followed-link',
          discoveredFromUrl: source.url,
          tags: inferTags(`${link.text} ${link.url}`),
          relevanceScore: Math.min(85, 42 + link.score * 8),
          credibilityScore: Math.max(40, source.credibility_score - 8),
        });
      }
      return observation;
    } catch (err) {
      researchSourceRepo.updateStats(source.id, { success: false, relevanceDelta: -0.8, credibilityDelta: -0.3 });
      emit(onEvent, 'source-learning', 18, 'warn', 'Learned source scrape failed; reducing source confidence.', {
        url: source.url,
        error: err.message,
      });
      return null;
    }
  }));
  const observations = [
    ...crawleeResult.observations,
    ...settled
      .filter((result) => result.status === 'fulfilled' && result.value)
      .map((result) => result.value),
  ];

  emit(onEvent, 'source-learning', 22, 'debug', 'Self-learned source scan complete.', {
    scraped: observations.length,
    discovered: discovered.length,
    entityLeads: crawleeResult.entityLeads?.length || 0,
  });

  return { observations, learnedSources: researchSourceRepo.listActiveByUser(userId, 60), discovered, entityLeads: crawleeResult.entityLeads || [] };
}

async function runCrawleeResearchDiscovery({ userId, researchRunId, onEvent }) {
  const semanticSeeds = semanticResearchMemory.buildSeedSourcesFromMemory({
    userId,
    queries: [
      ...DISCOVERY_QUERIES.slice(0, 8),
      'weather war crime housing local news company customers offices retail locations supply chain',
    ],
    limit: 10,
  });
  const seedSources = dedupeSources([...researchSourceRepo.listActiveByUser(userId, 10), ...semanticSeeds]).slice(0, 18);
  if (semanticSeeds.length) {
    emit(onEvent, 'source-learning', 13, 'debug', 'Loaded full-text/vector research memory as Crawlee seed sources.', {
      semanticSeeds: semanticSeeds.map((source) => ({
        title: source.title,
        url: source.url,
        score: source.semanticScore,
        mode: source.searchMode,
      })).slice(0, 6),
    });
  }
  const maxRuntimeMs = 8 * 60 * 1000;
  const askResult = await brainMesh.ask({
    from: 'brain.research.source',
    to: ['brain.research.source'],
    op: 'crawler.crawl',
    ctx: { userId },
    body: {
      full: true,
      urls: seedSources.map((source) => source.url),
      queries: DISCOVERY_QUERIES,
      maxFollowUps: 24,
      maxRequests: 180,
      minContinuationScore: 1.75,
      maxWaves: 10,
      maxSearchExpansions: 60,
      maxRuntimeMs,
    },
  }, { timeoutMs: maxRuntimeMs + 60_000 });
  const crawl = askResult.replies?.find((reply) => reply.kind === 'reply')?.body || {};
  for (const event of crawl.events || []) onEvent(event);

  const observations = [];
  for (const failure of crawl.failures || []) {
    const existing = researchSourceRepo.getByUrl(userId, failure.url);
    const source = existing || researchSourceRepo.upsert({
      userId,
      url: failure.url,
      title: failure.title,
      sourceType: isSearchRequestType(failure.userData?.type) ? 'search' : 'learned',
      status: 'active',
      discoveryMethod: failure.userData?.type || 'crawlee-failed-request',
      discoveredFromUrl: failure.userData?.discoveredFromUrl,
      tags: ['failed-fetch'],
      relevanceScore: 32,
      credibilityScore: 35,
      notes: `Fetch failed during autonomous research: ${failure.error}`,
    });
    const updated = researchSourceRepo.updateStats(source.id, {
      success: false,
      relevanceDelta: -1.4,
      credibilityDelta: -0.8,
    });
    emit(onEvent, 'source-learning', 17, updated.status === 'failed' ? 'warn' : 'debug', 'Tracked failed URL against source memory.', {
      url: failure.url,
      failureCount: updated.failure_count,
      status: updated.status,
      removalPolicy: updated.failure_count >= 10 ? 'removed from active research until re-learned' : 'will be retried only if future relevance warrants it',
    });
  }

  for (const link of crawl.discovered || []) {
    researchSourceRepo.upsert({
      userId,
      url: link.url,
      title: link.text,
      sourceType: 'learned',
      discoveryMethod: 'crawlee-search-follow-up',
      discoveredFromUrl: link.discoveredFromUrl,
      tags: crawleeResearchCrawler.inferTags(`${link.text} ${link.url}`),
      relevanceScore: Math.min(90, 44 + link.score * 7),
      credibilityScore: 52,
    });
  }

  for (const page of crawl.pages || []) {
    const source = researchSourceRepo.upsert({
      userId,
      url: page.url,
      title: page.title,
      sourceType: isSearchRequestType(page.sourceType) ? 'search' : 'learned',
      discoveryMethod: page.sourceType || 'crawlee-crawl',
      discoveredFromUrl: page.discoveredFromUrl,
      tags: page.tags,
      relevanceScore: Math.min(90, 40 + page.relevance * 6),
      credibilityScore: page.sourceCredibilityScore || 50,
    });
    researchSourceRepo.recordObservation({
      userId,
      sourceId: source?.id,
      researchRunId,
      url: page.url,
      title: page.title,
      excerpt: page.excerpt,
      links: page.links,
      score: {
        relevance: page.relevance,
        credibility: source?.credibility_score || 50,
        tags: page.tags,
        weightedFinancialEvents: page.weightedFinancialEvents,
        crawler: 'crawlee-cheerio',
      },
    });
    observations.push({
      userId,
      sourceId: source?.id,
      researchRunId,
      url: page.url,
      title: page.title,
      excerpt: page.excerpt,
      links: page.links,
      score: {
        relevance: page.relevance,
        credibility: source?.credibility_score || 50,
        tags: page.tags,
        weightedFinancialEvents: page.weightedFinancialEvents,
        crawler: 'crawlee-cheerio',
      },
    });
  }

  return { observations, discovered: crawl.discovered || [], entityLeads: crawl.entityLeads || [] };
}

async function discoverSources(userId, onEvent) {
  const discovered = [];
  for (const query of DISCOVERY_QUERIES.slice(0, 2)) {
    const googleLinks = await discoverFromGoogle(query).catch((err) => {
      emit(onEvent, 'source-learning', 14, 'warn', 'Google discovery was unavailable; continuing with seed/Common Crawl sources.', {
        query,
        error: err.message,
      });
      return [];
    });
    for (const link of googleLinks.slice(0, 5)) {
      const score = scoreText(`${link.title} ${link.url}`);
      if (score < 2) continue;
      discovered.push(link.url);
      researchSourceRepo.upsert({
        userId,
        url: link.url,
        title: link.title,
        sourceType: 'learned',
        discoveryMethod: 'google-search',
        tags: inferTags(`${link.title} ${link.url}`),
        relevanceScore: Math.min(82, 42 + score * 7),
        credibilityScore: 48,
      });
    }

    const duckDuckGoLinks = await discoverFromDuckDuckGo(query).catch((err) => {
      emit(onEvent, 'source-learning', 14, 'warn', 'DuckDuckGo discovery was unavailable; continuing with Google/Common Crawl sources.', {
        query,
        error: err.message,
      });
      return [];
    });
    for (const link of duckDuckGoLinks.slice(0, 5)) {
      const score = scoreText(`${link.title} ${link.url}`);
      if (score < 2) continue;
      discovered.push(link.url);
      researchSourceRepo.upsert({
        userId,
        url: link.url,
        title: link.title,
        sourceType: 'learned',
        discoveryMethod: 'duckduckgo-search',
        tags: inferTags(`${link.title} ${link.url}`),
        relevanceScore: Math.min(82, 42 + score * 7),
        credibilityScore: 48,
      });
    }
  }

  const commonCrawlLinks = await discoverFromCommonCrawl('market data sources').catch(() => []);
  for (const link of commonCrawlLinks.slice(0, 6)) {
    discovered.push(link.url);
    researchSourceRepo.upsert({
      userId,
      url: link.url,
      title: link.title || link.url,
      sourceType: 'learned',
      discoveryMethod: 'common-crawl-index',
      tags: inferTags(link.url),
      relevanceScore: 54,
      credibilityScore: 46,
    });
  }
  return [...new Set(discovered)];
}

async function discoverFromGoogle(query) {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('num', '10');
  const html = await fetchText(url.toString(), DUCKDUCKGO_DISCOVERY_TIMEOUT_MS);
  const links = [];
  const hrefMatches = [...html.matchAll(/href="([^"]+)"/g)];
  for (const match of hrefMatches) {
    let href = decodeHtml(match[1]);
    if (href.startsWith('/url?')) {
      const parsed = new URL(href, 'https://www.google.com');
      href = parsed.searchParams.get('q') || '';
    }
    if (!href.startsWith('http') || href.includes('google.com')) continue;
    links.push({ url: cleanUrl(href), title: hostnameTitle(href) });
  }
  return uniqueLinks(links);
}

async function discoverFromDuckDuckGo(query) {
  const url = new URL('https://duckduckgo.com/html/');
  url.searchParams.set('q', query);
  url.searchParams.set('kl', 'us-en');
  const html = await fetchText(url.toString(), 8000);
  if (/Unfortunately,\s+bots\s+use\s+DuckDuckGo\s+too|challenge-form|anomaly-modal/i.test(html)) {
    throw new Error('DuckDuckGo returned an anti-bot challenge page');
  }
  const links = extractLinks(html, url.toString())
    .map((link) => ({ ...link, url: unwrapDuckDuckGoRedirect(link.url) }))
    .filter((link) => link.url.startsWith('http') && !link.url.includes('duckduckgo.com/'));
  return uniqueLinks(links);
}

async function discoverFromCommonCrawl(query) {
  const indexList = await fetchJson('https://index.commoncrawl.org/collinfo.json', 8000);
  const latest = indexList?.[0]?.id;
  if (!latest) return [];
  const url = new URL(`https://index.commoncrawl.org/${latest}-index`);
  url.searchParams.set('url', `*${query.split(' ')[0]}*`);
  url.searchParams.set('output', 'json');
  url.searchParams.set('limit', '10');
  const text = await fetchText(url.toString(), 8000);
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        const row = JSON.parse(line);
        return { url: cleanUrl(row.url), title: hostnameTitle(row.url) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function scrapeSource({ userId, source, researchRunId, onEvent }) {
  const page = await crawleeResearchCrawler.crawlSingleSource({ source, onEvent });
  const title = page.title || source.title || hostnameTitle(source.url);
  const relevance = page.score.relevance;
  const links = page.links.slice(0, 20);
  const observation = {
    userId,
    sourceId: source.id,
    researchRunId,
    url: page.url || source.url,
    title,
    excerpt: page.excerpt.slice(0, 900),
    links,
    score: {
      relevance,
      credibility: source.credibility_score,
      tags: page.score.tags,
      weightedFinancialEvents: page.score.weightedFinancialEvents,
      crawler: 'crawlee-cheerio',
    },
  };
  researchSourceRepo.recordObservation(observation);
  return observation;
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 AutoTrader self-learning research bot',
        Accept: 'text/html,application/xhtml+xml,application/xml,text/plain,*/*',
      },
    });
    if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, timeoutMs) {
  const text = await fetchText(url, timeoutMs);
  return JSON.parse(text);
}

function extractLinks(html, baseUrl) {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = cleanUrl(new URL(decodeHtml(match[1]), baseUrl).toString());
      if (!url.startsWith('http')) continue;
      links.push({ url, text: normalizeText(stripTags(decodeHtml(match[2]))).slice(0, 140) || hostnameTitle(url) });
    } catch {
      // Ignore malformed hrefs.
    }
  }
  return uniqueLinks(links);
}

function unwrapDuckDuckGoRedirect(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('duckduckgo.com') && parsed.searchParams.has('uddg')) {
      return cleanUrl(parsed.searchParams.get('uddg'));
    }
    return cleanUrl(url);
  } catch {
    return url;
  }
}

function scoreText(text) {
  const lowered = String(text || '').toLowerCase();
  let score = 0;
  for (const term of RELEVANCE_TERMS) {
    if (lowered.includes(term)) score += 1;
  }
  if (lowered.includes('api') || lowered.includes('csv') || lowered.includes('download')) score += 1.5;
  if (lowered.includes('subscribe') && lowered.includes('premium')) score -= 1;
  return Number(score.toFixed(2));
}

function inferTags(text) {
  const lowered = String(text || '').toLowerCase();
  return RELEVANCE_TERMS.filter((term) => lowered.includes(term)).slice(0, 8);
}

function uniqueLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    if (!link.url || seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function cleanUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.startsWith('utm_') || key === 'fbclid' || key === 'gclid') parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

function pickTitle(html) {
  return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
}

function stripTags(value) {
  return String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ');
}

function normalizeText(value) {
  return decodeHtml(value).replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function hostnameTitle(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
  if (level === 'warn') logger.warn(message, data || {});
}

function isSearchRequestType(type) {
  return /google|duckduckgo|search|rss/i.test(String(type || ''));
}

function dedupeSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    if (!source.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

module.exports = {
  seedSources,
  collectLearnedResearch,
  discoverFromGoogle,
  discoverFromDuckDuckGo,
  discoverFromCommonCrawl,
  scoreText,
  SEED_SOURCES,
};
