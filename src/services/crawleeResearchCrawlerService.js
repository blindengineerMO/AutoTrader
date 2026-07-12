const { CheerioCrawler, LogLevel, log } = require('@crawlee/cheerio');

log.setLevel(LogLevel.ERROR);

const DEFAULT_SEARCH_QUERIES = [
  'Whats in the news today',
  'world economy markets today',
  'US market news today economy consumers oil energy defense',
];

async function crawlAutonomousResearch({
  queries = DEFAULT_SEARCH_QUERIES,
  seedSources = [],
  onEvent = () => {},
  maxFollowUps = 18,
  maxRequests = 96,
  minContinuationScore = 1.85,
  maxWaves = 8,
  maxSearchExpansions = 36,
  maxRuntimeMs = 6 * 60 * 1000,
} = {}) {
  emit(onEvent, 'crawlee-search', 13, 'info', 'Starting autonomous Crawlee discovery from broad news search queries.', {
    queries: queries.slice(0, 12),
    maxRequests,
    maxWaves,
  });

  const searchRequests = queries.slice(0, 12).flatMap((query) => buildSearchRequests(query));
  const sourceRequests = seedSources.slice(0, 18).map((source) => ({
    url: source.url,
    userData: { type: 'learned-source', depth: 0, title: source.title, source },
  }));

  const pages = [];
  const failures = [];
  const discovered = [];
  const entityLeads = new Map();
  const seenUrls = new Set();
  const seenQueries = new Set(queries.map(normalizeQuery));
  let frontier = [...searchRequests, ...sourceRequests].filter((request) => rememberUrl(seenUrls, request.url));
  let requested = 0;
  let searchExpansionCount = 0;
  let wave = 0;
  const startedAt = Date.now();

  while (frontier.length && requested < maxRequests && wave < maxWaves && Date.now() - startedAt < maxRuntimeMs) {
    const remaining = maxRequests - requested;
    const batch = frontier.slice(0, remaining);
    requested += batch.length;
    emit(onEvent, 'crawlee-frontier', 15 + wave * 4, 'debug', 'Crawlee selected a relevance frontier to inspect.', {
      wave,
      requested: batch.length,
      remainingBudget: Math.max(0, maxRequests - requested),
      reason: wave === 0 ? 'Broad search and learned source seed set.' : 'Prior pages exposed high-scoring company/news/product links.',
    });

    const result = await crawlPages({
      requests: batch,
      label: wave === 0 ? 'seed/search' : `adaptive-follow-up-${wave}`,
      maxRequestsPerCrawl: batch.length,
      onEvent,
    });
    pages.push(...result.pages);
    failures.push(...result.failures);
    for (const page of result.pages) {
      for (const lead of extractEntityLeads(page)) {
        const existing = entityLeads.get(lead.key) || { ...lead, score: 0, evidence: [] };
        existing.score += lead.score;
        existing.evidence.push(...lead.evidence);
        existing.evidence = existing.evidence.slice(0, 8);
        entityLeads.set(lead.key, existing);
      }
    }

    const candidates = result.pages
      .flatMap((page) => page.links.map((link) => ({
        ...link,
        discoveredFromUrl: page.url,
        depth: (page.userData?.depth || 0) + 1,
        score: continuationScore(link, page),
      })))
      .filter((link) => link.score >= minContinuationScore)
      .sort((a, b) => b.score - a.score)
      .filter((link) => rememberUrl(seenUrls, link.url));

    const articleSearches = result.pages
      .flatMap((page) => deriveSearchQueriesFromPage(page))
      .filter((query) => {
        const normalized = normalizeQuery(query);
        if (!normalized || seenQueries.has(normalized)) return false;
        seenQueries.add(normalized);
        return true;
      })
      .slice(0, Math.max(0, maxSearchExpansions - searchExpansionCount));
    searchExpansionCount += articleSearches.length;

    const selected = candidates.slice(0, Math.min(maxFollowUps, Math.max(6, 18 - wave)));
    discovered.push(...selected);

    if (!selected.length && !articleSearches.length) {
      emit(onEvent, 'crawlee-stop', 22 + wave * 3, 'debug', 'Crawlee stopped expanding because relevance dropped below the continuation threshold.', {
        wave,
        threshold: minContinuationScore,
        inspectedPages: pages.length,
        entityLeads: entityLeads.size,
      });
      break;
    }

    emit(onEvent, 'crawlee-spawn', 18 + wave * 4, 'debug', 'Crawlee is expanding research from high-relevance links.', {
      wave,
      selected: selected.map((link) => ({
        title: link.text,
        url: link.url,
        score: link.score,
        reason: continuationReason(link),
      })).slice(0, 8),
      generatedSearches: articleSearches.slice(0, 8),
      entityLeads: [...entityLeads.values()].sort((a, b) => b.score - a.score).slice(0, 8).map((lead) => ({
        name: lead.name,
        symbol: lead.symbol,
        score: Number(lead.score.toFixed(2)),
      })),
    });

    frontier = [
      ...selected.map((link) => ({
        url: link.url,
        userData: { type: 'adaptive-follow-up', depth: link.depth, title: link.text, discoveredFromUrl: link.discoveredFromUrl },
      })),
      ...articleSearches.flatMap((query) => buildSearchRequests(query).map((request) => ({
        ...request,
        userData: { ...request.userData, type: 'article-derived-search', depth: wave + 1, parentWave: wave },
      }))),
    ].filter((request) => rememberUrl(seenUrls, request.url));
    wave += 1;
  }

  if (requested >= maxRequests) {
    emit(onEvent, 'crawlee-stop', 42, 'warn', 'Crawlee stopped because the safety request budget was reached, not because depth was fixed.', {
      requested,
      pages: pages.length,
    });
  } else if (wave >= maxWaves) {
    emit(onEvent, 'crawlee-stop', 42, 'debug', 'Crawlee stopped after exhausting adaptive research waves.', {
      waves: wave,
      pages: pages.length,
      entityLeads: entityLeads.size,
    });
  } else if (Date.now() - startedAt >= maxRuntimeMs) {
    emit(onEvent, 'crawlee-stop', 42, 'warn', 'Crawlee stopped because the runtime safety budget was reached.', {
      runtimeMs: Date.now() - startedAt,
      pages: pages.length,
      entityLeads: entityLeads.size,
    });
  }

  return {
    pages,
    discovered: discovered.filter(uniqueByUrl()),
    failures,
    entityLeads: [...entityLeads.values()]
      .map((lead) => ({ ...lead, score: Number(lead.score.toFixed(2)), evidence: lead.evidence.slice(0, 6) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 80),
  };
}

async function crawlSingleSource({ source, onEvent = () => {} }) {
  const result = await crawlPages({
    requests: [{ url: source.url, userData: { type: 'learned-source', depth: 0, title: source.title, source } }],
    label: 'learned-source',
    maxRequestsPerCrawl: 1,
    onEvent,
  });
  const [page] = result.pages;
  if (!page) throw new Error(`Crawlee did not return content for ${source.url}`);
  return page;
}

async function crawlPages({ requests, label, maxRequestsPerCrawl, onEvent }) {
  const pages = [];
  const failures = [];
  if (!requests.length) return { pages, failures };

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl,
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 20,
    navigationTimeoutSecs: 15,
    async requestHandler({ request, $, body }) {
      const title = cleanText($('title').first().text() || request.userData.title || hostnameTitle(request.loadedUrl || request.url));
      const text = cleanText($('body').text() || body?.toString?.() || '');
      const links = extractLinks($, request.loadedUrl || request.url)
        .map((link) => ({ ...link, score: scoreText(`${link.text} ${link.url}`) }))
        .filter((link) => link.url.startsWith('http'))
        .sort((a, b) => b.score - a.score)
        .slice(0, 25);
      const page = {
        url: cleanUrl(request.loadedUrl || request.url),
        title,
        excerpt: text.slice(0, 3000),
        fullText: text.slice(0, 18000),
        links,
        score: {
          relevance: scoreText(text.slice(0, 5000)),
          tags: inferTags(text.slice(0, 2000)),
        },
        userData: request.userData || {},
      };
      pages.push(page);
      emit(onEvent, request.userData.depth ? 'crawlee-follow-up' : 'crawlee-fetch', request.userData.depth ? 20 : 15, 'debug', `Crawlee analyzed ${label} page.`, {
        title: page.title,
        url: page.url,
        links: page.links.length,
        relevance: page.score.relevance,
      });
    },
    failedRequestHandler({ request, error }) {
      failures.push({
        url: cleanUrl(request.url),
        title: request.userData?.title || hostnameTitle(request.url),
        error: error.message,
        userData: request.userData || {},
      });
      emit(onEvent, 'crawlee-fetch', 16, 'warn', 'Crawlee request failed; continuing with remaining research targets.', {
        url: request.url,
        error: error.message,
      });
    },
  });

  await crawler.run(requests);
  return { pages, failures };
}

function buildSearchRequests(query) {
  const google = new URL('https://www.google.com/search');
  google.searchParams.set('q', query);
  google.searchParams.set('num', '10');

  const googleNews = new URL('https://news.google.com/rss/search');
  googleNews.searchParams.set('q', query);
  googleNews.searchParams.set('hl', 'en-US');
  googleNews.searchParams.set('gl', 'US');
  googleNews.searchParams.set('ceid', 'US:en');

  return [
    { url: google.toString(), userData: { type: 'google-search', depth: 0, query } },
    { url: googleNews.toString(), userData: { type: 'google-news-rss', depth: 0, query } },
  ];
}

function extractLinks($, baseUrl) {
  const links = [];
  $('a[href]').each((_, element) => {
    try {
      let href = $(element).attr('href') || '';
      const text = cleanText($(element).text()) || hostnameTitle(href);
      if (href.startsWith('/url?')) {
        const parsed = new URL(href, 'https://www.google.com');
        href = parsed.searchParams.get('q') || parsed.searchParams.get('url') || '';
      }
      const url = cleanUrl(new URL(href, baseUrl).toString());
      if (!url.startsWith('http')) return;
      if (isBlockedDiscoveryUrl(url)) return;
      links.push({ url, text });
    } catch {
      // Ignore malformed links discovered on third-party pages.
    }
  });
  return links.filter(uniqueByUrl());
}

function isBlockedDiscoveryUrl(url) {
  return [
    'accounts.google.com',
    'support.google.com',
    'policies.google.com',
    'maps.google.com',
    'webcache.googleusercontent.com',
  ].some((blocked) => url.includes(blocked));
}

function inferTags(text) {
  const lower = String(text || '').toLowerCase();
  return RELEVANCE_TERMS.filter((term) => lower.includes(term)).slice(0, 8);
}

function scoreText(text) {
  const lower = String(text || '').toLowerCase();
  return RELEVANCE_TERMS.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function deriveSearchQueriesFromPage(page) {
  const text = `${page.title || ''} ${page.excerpt || ''}`;
  const leads = extractEntityLeads(page).slice(0, 6);
  const titleTerms = cleanText(page.title)
    .replace(/[^\w\s$.-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word.toLowerCase()))
    .slice(0, 8)
    .join(' ');
  const topicQueries = [];
  if (titleTerms) topicQueries.push(`${titleTerms} stock market investment impact`);
  for (const lead of leads) {
    const target = lead.symbol ? `${lead.name} ${lead.symbol}` : lead.name;
    topicQueries.push(`${target} stock ticker ownership investment news`);
    topicQueries.push(`${target} earnings revenue deal market opportunity`);
  }
  for (const phrase of extractResearchPhrases(text).slice(0, 4)) {
    topicQueries.push(`${phrase} public company ticker investment opportunity`);
  }
  return [...new Set(topicQueries.map(cleanText).filter((query) => query.length >= 12))].slice(0, 10);
}

function extractEntityLeads(page) {
  const text = `${page.title || ''} ${page.fullText || page.excerpt || ''}`;
  const leads = new Map();
  const symbolPatterns = [
    /\$([A-Z]{1,5}(?:\.[A-Z])?)\b/g,
    /\b(?:NASDAQ|NYSE|NYSEARCA|AMEX|OTC)\s*[: ]\s*([A-Z]{1,5}(?:\.[A-Z])?)\b/g,
    /\(([A-Z]{1,5}(?:\.[A-Z])?)\)/g,
  ];
  for (const pattern of symbolPatterns) {
    for (const match of text.matchAll(pattern)) {
      const symbol = match[1];
      if (SYMBOL_BLACKLIST.has(symbol)) continue;
      addLead(leads, {
        key: `symbol:${symbol}`,
        symbol,
        name: symbol,
        type: 'ticker',
        score: 4,
        evidence: [{ title: page.title, url: page.url, reason: `Direct ticker mention ${symbol}` }],
      });
    }
  }

  const companyPattern = /\b([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4}\s+(?:Inc|Corp|Corporation|Company|Companies|Co|Ltd|PLC|Holdings|Group|Technologies|Technology|Systems|Labs|Energy|Motors|Industries|Software|Semiconductor|Pharma|Capital|Ventures|Partners))\b/g;
  for (const match of text.matchAll(companyPattern)) {
    const name = cleanText(match[1]).replace(/\s+(the|and)$/i, '');
    if (name.length < 4 || ENTITY_BLACKLIST.has(name.toLowerCase())) continue;
    addLead(leads, {
      key: `entity:${name.toLowerCase()}`,
      name,
      type: 'company-entity',
      score: 2.6,
      evidence: [{ title: page.title, url: page.url, reason: `Company-like entity mention ${name}` }],
    });
  }
  return [...leads.values()].sort((a, b) => b.score - a.score).slice(0, 18);
}

function extractResearchPhrases(text) {
  const lower = String(text || '').toLowerCase();
  const phrases = [];
  const patterns = [
    /(?:acquired|acquires|buys|bought|invests in|investment in|stake in)\s+([a-z0-9&.' -]{3,70})/g,
    /(?:launched|announced|released|unveiled)\s+([a-z0-9&.' -]{3,70})/g,
    /(?:contract with|deal with|partnership with)\s+([a-z0-9&.' -]{3,70})/g,
  ];
  for (const pattern of patterns) {
    for (const match of lower.matchAll(pattern)) {
      const phrase = cleanText(match[1]).split(/[.,;:]/)[0];
      if (phrase.length >= 8) phrases.push(phrase);
    }
  }
  return [...new Set(phrases)].slice(0, 12);
}

function addLead(map, lead) {
  const existing = map.get(lead.key) || { ...lead, score: 0, evidence: [] };
  existing.score += lead.score;
  existing.evidence.push(...lead.evidence);
  map.set(lead.key, existing);
}

function continuationScore(link, page) {
  const base = scoreText(`${link.text} ${link.url}`);
  const parentBoost = Math.min(3, (page.score?.relevance || 0) * 0.28);
  const lower = `${link.text || ''} ${link.url || ''}`.toLowerCase();
  const eventBoost = ['launch', 'product', 'earnings', 'forecast', 'contract', 'war', 'defense', 'oil', 'energy', 'consumer', 'sales', 'startup', 'funding']
    .reduce((score, term) => score + (lower.includes(term) ? 0.45 : 0), 0);
  const marketBoost = /\/(business|markets|finance|economy|technology|investing|stocks|companies)\b/i.test(link.url) ? 0.7 : 0;
  const noisePenalty = /(privacy|terms|login|signin|subscribe|newsletter|video|podcast|advertise|contact)/i.test(link.url) ? 1.8 : 0;
  return Number(Math.max(0, base + parentBoost + eventBoost + marketBoost - noisePenalty).toFixed(2));
}

function continuationReason(link) {
  const lower = `${link.text || ''} ${link.url || ''}`.toLowerCase();
  const reasons = [];
  if (/(business|markets|finance|economy|investing|stocks|companies)/i.test(link.url)) reasons.push('market/business path');
  for (const term of ['product', 'launch', 'earnings', 'contract', 'war', 'defense', 'oil', 'energy', 'consumer', 'sales', 'startup', 'funding']) {
    if (lower.includes(term)) reasons.push(term);
    if (reasons.length >= 3) break;
  }
  return reasons.join(', ') || 'high relevance score';
}

function uniqueByUrl() {
  const seen = new Set();
  return (item) => {
    const key = cleanUrl(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function rememberUrl(seen, url) {
  const key = cleanUrl(url);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

function cleanUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ocid|mc_cid|mc_eid)/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function hostnameTitle(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url || 'Untitled source');
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeQuery(query) {
  return cleanText(query).toLowerCase();
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

const RELEVANCE_TERMS = [
  'news',
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
  'oil',
  'defense',
  'war',
  'commodities',
  'financial',
  'data',
  'company',
  'revenue',
  'profit',
  'ownership',
  'stake',
  'acquisition',
  'investment',
  'startup',
  'ipo',
  'funding',
  'contract',
  'partnership',
  'launch',
  'product',
];

const STOP_WORDS = new Set(['with', 'from', 'that', 'this', 'have', 'into', 'after', 'before', 'about', 'market', 'stock', 'news', 'today']);
const SYMBOL_BLACKLIST = new Set(['CEO', 'CFO', 'COO', 'SEC', 'IPO', 'ETF', 'USA', 'USD', 'AI', 'EV', 'GDP', 'CPI', 'FED']);
const ENTITY_BLACKLIST = new Set(['the company', 'news corp', 'google news']);

module.exports = {
  DEFAULT_SEARCH_QUERIES,
  crawlAutonomousResearch,
  crawlSingleSource,
  scoreText,
  inferTags,
  extractEntityLeads,
  deriveSearchQueriesFromPage,
};
