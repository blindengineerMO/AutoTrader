const { CheerioCrawler, LogLevel, log } = require('@crawlee/cheerio');
const financialWeights = require('./financialEventWeightingService');
const textVector = require('../utils/textVector');

log.setLevel(LogLevel.ERROR);

const DEFAULT_SEARCH_QUERIES = [
  'Whats in the news today',
  'world economy markets today',
  'US market news today economy consumers oil energy defense',
];

const DUCKDUCKGO_PREFLIGHT_TIMEOUT_MS = 3500;

const CURATED_MARKET_NEWS_SITES = [
  { domain: 'bloomberg.com', name: 'Bloomberg', url: 'https://www.bloomberg.com/', tags: ['market-news', 'macro', 'company-news'], credibilityScore: 82 },
  { domain: 'wsj.com', name: 'Wall Street Journal', url: 'https://www.wsj.com/', tags: ['market-news', 'business-news', 'company-news'], credibilityScore: 84 },
  { domain: 'reuters.com', name: 'Reuters Business Finance', url: 'https://www.reuters.com/business/finance/', tags: ['market-news', 'wire-news', 'company-news'], credibilityScore: 88 },
  { domain: 'finance.yahoo.com', name: 'Yahoo Finance', url: 'https://finance.yahoo.com/', tags: ['market-news', 'quotes', 'company-news'], credibilityScore: 76 },
  { domain: 'cnbc.com', name: 'CNBC', url: 'https://www.cnbc.com/', tags: ['market-news', 'business-news', 'television-news'], credibilityScore: 74 },
  { domain: 'marketwatch.com', name: 'MarketWatch', url: 'https://www.marketwatch.com/', tags: ['market-news', 'stocks', 'company-news'], credibilityScore: 74 },
  { domain: 'kiplinger.com', name: 'Kiplinger', url: 'https://www.kiplinger.com/', tags: ['investor-education', 'market-news', 'personal-finance'], credibilityScore: 70 },
  { domain: 'investopedia.com', name: 'Investopedia', url: 'https://www.investopedia.com/', tags: ['investor-education', 'company-news', 'market-explainers'], credibilityScore: 70 },
  { domain: 'economist.com', name: 'The Economist', url: 'https://www.economist.com/', tags: ['global-macro', 'market-news', 'geopolitics'], credibilityScore: 82 },
  { domain: 'forbes.com', name: 'Forbes', url: 'https://www.forbes.com/', tags: ['business-news', 'company-news', 'founders'], credibilityScore: 66 },
];

async function crawlAutonomousResearch({
  queries = DEFAULT_SEARCH_QUERIES,
  seedSources = [],
  onEvent = () => {},
  maxFollowUps = 18,
  maxSubLinksPerPage = 6,
  maxDepth = 5,
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
    searchProviders: ['google', 'google-news', 'duckduckgo-best-effort-preflight'],
    curatedMarketNewsSites: CURATED_MARKET_NEWS_SITES.map((site) => site.domain),
  });
  const semanticContext = buildSemanticContext({ queries, seedSources });

  const broadQueries = queries.slice(0, 12);
  const duckDuckGoResultRequests = await buildDuckDuckGoResultRequests(broadQueries, { onEvent });
  const searchRequests = [
    ...broadQueries.flatMap((query) => buildSearchRequests(query)),
    ...buildMarketNewsSiteSearchRequests(broadQueries, { queryLimit: 3, siteLimit: 10 }),
    ...duckDuckGoResultRequests,
  ];
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
      .flatMap((page) => selectPageSubLinks({ page, semanticContext, maxSubLinksPerPage, maxDepth }))
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
        depth: link.depth,
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
        userData: {
          type: link.discoveryMethod || 'adaptive-follow-up',
          depth: link.depth,
          title: link.text,
          discoveredFromUrl: link.discoveredFromUrl,
          parentRelevance: link.parentRelevance,
          parentWeightedEventScore: link.parentWeightedEventScore,
        },
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

async function crawlFromArticle({
  article,
  onEvent = () => {},
  maxDepth = 3,
  maxSubLinksPerPage = 6,
  maxRequests = 24,
  maxWaves = 4,
  minContinuationScore = 1.85,
  maxRuntimeMs = 90 * 1000,
}) {
  emit(onEvent, 'crawlee-article-seed', 13, 'info', 'Deep-crawling a valuable article for further leads.', {
    title: article.title,
    url: article.link,
    maxRequests,
    maxWaves,
  });
  const semanticContext = buildSemanticContext({ queries: [article.title || ''], seedSources: [] });

  const pages = [];
  const failures = [];
  const discovered = [];
  const entityLeads = new Map();
  const seenUrls = new Set();
  let frontier = [{ url: article.link, userData: { type: 'article-seed', depth: 0, title: article.title } }]
    .filter((request) => rememberUrl(seenUrls, request.url));
  let requested = 0;
  let wave = 0;
  const startedAt = Date.now();

  while (frontier.length && requested < maxRequests && wave < maxWaves && Date.now() - startedAt < maxRuntimeMs) {
    const remaining = maxRequests - requested;
    const batch = frontier.slice(0, remaining);
    requested += batch.length;

    const result = await crawlPages({
      requests: batch,
      label: wave === 0 ? 'article-seed' : `article-follow-up-${wave}`,
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
      .flatMap((page) => selectPageSubLinks({ page, semanticContext, maxSubLinksPerPage, maxDepth }))
      .filter((link) => link.score >= minContinuationScore)
      .sort((a, b) => b.score - a.score)
      .filter((link) => rememberUrl(seenUrls, link.url));

    if (!candidates.length) {
      emit(onEvent, 'crawlee-article-stop', 22, 'debug', 'Article deep-crawl stopped because relevance dropped below the continuation threshold.', {
        wave,
        inspectedPages: pages.length,
        entityLeads: entityLeads.size,
      });
      break;
    }

    discovered.push(...candidates);
    frontier = candidates.map((link) => ({
      url: link.url,
      userData: {
        type: link.discoveryMethod || 'article-follow-up',
        depth: link.depth,
        title: link.text,
        discoveredFromUrl: link.discoveredFromUrl,
        parentRelevance: link.parentRelevance,
        parentWeightedEventScore: link.parentWeightedEventScore,
      },
    }));
    wave += 1;
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
      if (isDuckDuckGoChallengePage(request, text)) {
        throw new Error('DuckDuckGo returned an anti-bot challenge page');
      }
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
          weightedFinancialEvents: financialWeights.scoreDocumentFinancialEvents({ title, text: text.slice(0, 8000), url: request.loadedUrl || request.url }),
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
        weightedEventScore: page.score.weightedFinancialEvents.aggregateScore,
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

function buildMarketNewsSiteSearchRequests(queries, { queryLimit = 3, siteLimit = 10, includeDuckDuckGo = false } = {}) {
  const selectedQueries = queries.slice(0, queryLimit);
  const selectedSites = CURATED_MARKET_NEWS_SITES.slice(0, siteLimit);
  const requests = [];
  for (const query of selectedQueries) {
    for (const site of selectedSites) {
      const scopedQuery = `site:${site.domain} ${query} company announcement new product earnings acquisition stock`;
      const google = new URL('https://www.google.com/search');
      google.searchParams.set('q', scopedQuery);
      google.searchParams.set('num', '10');

      requests.push({
        url: google.toString(),
        userData: { type: 'market-news-site-google-search', depth: 0, query: scopedQuery, site: site.domain },
      });
      if (includeDuckDuckGo) {
        const duckDuckGo = new URL('https://duckduckgo.com/html/');
        duckDuckGo.searchParams.set('q', scopedQuery);
        duckDuckGo.searchParams.set('kl', 'us-en');
        requests.push({
          url: duckDuckGo.toString(),
          userData: { type: 'market-news-site-duckduckgo-search', depth: 0, query: scopedQuery, site: site.domain },
        });
      }
    }
  }
  return requests;
}

async function buildDuckDuckGoResultRequests(queries, {
  queryLimit = 4,
  resultLimit = 8,
  timeoutMs = DUCKDUCKGO_PREFLIGHT_TIMEOUT_MS,
  onEvent = () => {},
  fetchImpl = global.fetch,
} = {}) {
  const selectedQueries = queries.slice(0, queryLimit);
  const settled = await Promise.allSettled(selectedQueries.map((query) =>
    discoverDuckDuckGoResults(query, { resultLimit, timeoutMs, fetchImpl })
  ));
  const requests = [];
  for (let index = 0; index < settled.length; index += 1) {
    const query = selectedQueries[index];
    const result = settled[index];
    if (result.status === 'rejected') {
      emit(onEvent, 'duckduckgo-search', 14, 'debug', 'DuckDuckGo preflight was skipped after a short timeout/failure.', {
        query,
        timeoutMs,
        error: result.reason?.message || String(result.reason),
      });
      continue;
    }
    emit(onEvent, 'duckduckgo-search', 14, 'debug', 'DuckDuckGo preflight returned result URLs for Crawlee to inspect.', {
      query,
      results: result.value.length,
    });
    for (const link of result.value) {
      requests.push({
        url: link.url,
        userData: {
          type: 'duckduckgo-result',
          depth: 0,
          query,
          title: link.title,
          sourceSearch: 'duckduckgo',
        },
      });
    }
  }
  return requests;
}

async function discoverDuckDuckGoResults(query, { resultLimit = 8, timeoutMs = DUCKDUCKGO_PREFLIGHT_TIMEOUT_MS, fetchImpl = global.fetch } = {}) {
  const url = new URL('https://duckduckgo.com/html/');
  url.searchParams.set('q', query);
  url.searchParams.set('kl', 'us-en');
  const html = await fetchTextWithTimeout(url.toString(), { timeoutMs, fetchImpl });
  if (isDuckDuckGoChallengeText(html)) {
    throw new Error('DuckDuckGo returned an anti-bot challenge page');
  }
  return extractDuckDuckGoResultLinks(html, url.toString()).slice(0, resultLimit);
}

function extractDuckDuckGoResultLinks(html, baseUrl) {
  const links = [];
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const href = unwrapSearchRedirect(decodeHtml(match[1]), baseUrl);
      const url = cleanUrl(new URL(href, baseUrl).toString());
      if (!url.startsWith('http') || isBlockedDiscoveryUrl(url) || url.includes('duckduckgo.com/')) continue;
      links.push({
        url,
        title: cleanText(stripTags(decodeHtml(match[2]))) || hostnameTitle(url),
      });
    } catch {
      // Ignore malformed DuckDuckGo result links.
    }
  }
  return links.filter(uniqueByUrl());
}

async function fetchTextWithTimeout(url, { timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 AutoTrader DuckDuckGo preflight research bot',
        Accept: 'text/html,application/xhtml+xml,application/xml,text/plain,*/*',
      },
    });
    if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`DuckDuckGo preflight timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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
      href = unwrapSearchRedirect(href, baseUrl);
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

function unwrapSearchRedirect(href, baseUrl) {
  try {
    const parsed = new URL(href, baseUrl);
    if (parsed.hostname.includes('duckduckgo.com') && parsed.pathname === '/l/') {
      return parsed.searchParams.get('uddg') || href;
    }
    if (parsed.hostname.includes('duckduckgo.com') && parsed.searchParams.has('uddg')) {
      return parsed.searchParams.get('uddg') || href;
    }
    return href;
  } catch {
    return href;
  }
}

function isBlockedDiscoveryUrl(url) {
  return [
    'accounts.google.com',
    'support.google.com',
    'policies.google.com',
    'maps.google.com',
    'webcache.googleusercontent.com',
    'duckduckgo.com/anomaly',
  ].some((blocked) => url.includes(blocked));
}

function isDuckDuckGoChallengePage(request, text) {
  return String(request.userData?.type || '').includes('duckduckgo')
    && isDuckDuckGoChallengeText(text);
}

function isDuckDuckGoChallengeText(text) {
  return /Unfortunately,\s+bots\s+use\s+DuckDuckGo\s+too|challenge-form|anomaly-modal/i.test(text || '');
}

function inferTags(text) {
  const lower = String(text || '').toLowerCase();
  return RELEVANCE_TERMS.filter((term) => lower.includes(term)).slice(0, 8);
}

function scoreText(text) {
  const lower = String(text || '').toLowerCase();
  const relevanceScore = RELEVANCE_TERMS.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
  const eventWeight = financialWeights.scoreDocumentFinancialEvents({ text: lower }).aggregateAbsScore;
  return Number((relevanceScore + Math.min(8, eventWeight) * 0.55).toFixed(2));
}

function buildSemanticContext({ queries = [], seedSources = [] } = {}) {
  const text = [
    queries.join(' '),
    seedSources.map((source) => `${source.title || ''} ${source.url || ''} ${(source.tags || []).join(' ')}`).join(' '),
  ].join(' ');
  return {
    vector: textVector.embedText(text),
    terms: new Set(textVector.topTerms(text, 32).map((item) => item.term)),
  };
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
  for (const query of extractLocalEventResearchQueries(page, leads).slice(0, 6)) {
    topicQueries.push(query);
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

function extractLocalEventResearchQueries(page, leads = []) {
  const text = `${page.title || ''} ${page.excerpt || ''}`;
  const event = classifyLocalEvent(text);
  if (!event) return [];
  const locations = extractLocationTerms(text);
  const queries = [];
  for (const location of locations.slice(0, 3)) {
    queries.push(`Will ${location} area be affected by ${event} company offices customers supply chain market impact`);
    for (const lead of leads.slice(0, 3)) {
      queries.push(`Will ${lead.name} customers offices retail locations in ${location} be affected by ${event}`);
    }
  }
  return queries;
}

function selectPageSubLinks({ page, semanticContext, maxSubLinksPerPage, maxDepth }) {
  const parentDepth = Number(page.userData?.depth || 0);
  const nextDepth = parentDepth + 1;
  if (nextDepth > maxDepth) return [];
  const dynamicThreshold = Math.max(0.9, 1.55 - Math.min(0.6, (page.score?.relevance || 0) * 0.05));
  return page.links
    .filter((link) => !isLowValueNavigationLink(link))
    .map((link) => ({
      ...link,
      discoveredFromUrl: page.url,
      depth: nextDepth,
      parentRelevance: page.score?.relevance || 0,
      parentWeightedEventScore: page.score?.weightedFinancialEvents?.aggregateScore || 0,
      discoveryMethod: nextDepth > 1 ? 'sub-link-follow-up' : 'adaptive-follow-up',
      score: continuationScore(link, page, semanticContext),
    }))
    .filter((link) => link.score >= dynamicThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSubLinksPerPage);
}

function isLowValueNavigationLink(link) {
  return /(privacy|terms|login|signin|subscribe|newsletter|advertise|contact|cookie|preferences|about-us|careers|help|support)/i
    .test(`${link.text || ''} ${link.url || ''}`);
}

function classifyLocalEvent(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(war|conflict|invasion|missile|attack|sanction|red sea)\b/.test(lower)) return 'war or geopolitical disruption';
  if (/\b(weather|hurricane|storm|flood|wildfire|earthquake|drought|tornado)\b/.test(lower)) return 'weather or natural disaster';
  if (/\b(crime|theft|robbery|violence|shoplifting|organized retail crime)\b/.test(lower)) return 'crime or retail theft';
  if (/\b(housing|mortgage|rent|home sales|building permits|real estate)\b/.test(lower)) return 'housing or real estate shift';
  return null;
}

function extractLocationTerms(text) {
  const terms = [
    'United States', 'North America', 'Europe', 'China', 'India', 'Japan', 'Taiwan', 'South Korea',
    'Middle East', 'Israel', 'Gaza', 'Ukraine', 'Russia', 'Red Sea', 'California', 'Texas', 'Florida',
    'New York', 'Washington', 'Georgia', 'Illinois', 'Seattle', 'Cupertino', 'Austin', 'Bentonville',
    'Atlanta', 'Chicago', 'New York City', 'Los Angeles', 'San Francisco', 'Bay Area', 'Houston',
    'Miami', 'London', 'Paris', 'Berlin', 'Shanghai', 'Beijing', 'Shenzhen', 'Taipei', 'Seoul', 'Tokyo',
  ];
  return terms.filter((term) => new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(text));
}

function addLead(map, lead) {
  const existing = map.get(lead.key) || { ...lead, score: 0, evidence: [] };
  existing.score += lead.score;
  existing.evidence.push(...lead.evidence);
  map.set(lead.key, existing);
}

function continuationScore(link, page, semanticContext = null) {
  const base = scoreText(`${link.text} ${link.url}`);
  const parentBoost = Math.min(3, (page.score?.relevance || 0) * 0.28);
  const parentEventBoost = Math.min(3, Math.abs(page.score?.weightedFinancialEvents?.aggregateScore || 0) * 0.35);
  const lower = `${link.text || ''} ${link.url || ''}`.toLowerCase();
  const linkText = `${link.text || ''} ${link.url || ''}`;
  const semanticSimilarity = semanticContext?.vector ? textVector.cosineSimilarity(textVector.embedText(linkText), semanticContext.vector) : 0;
  const semanticBoost = Math.max(0, semanticSimilarity) * 1.8;
  const fullTextBoost = semanticContext?.terms
    ? textVector.tokenize(linkText).reduce((score, term) => score + (semanticContext.terms.has(term) ? 0.12 : 0), 0)
    : 0;
  const linkEventBoost = Math.min(2, financialWeights.scoreDocumentFinancialEvents({ title: link.text, text: link.url, url: link.url }).aggregateAbsScore * 0.4);
  const companyInfoBoost = /(\$[A-Z]{1,5}\b|\bNASDAQ\b|\bNYSE\b|earnings|guidance|contract|revenue|margin|cash-flow|sec-filing|investor-relations|10-k|10-q|8-k)/i.test(`${link.text} ${link.url}`) ? 1.1 : 0;
  const eventBoost = ['launch', 'product', 'earnings', 'forecast', 'contract', 'war', 'defense', 'oil', 'energy', 'consumer', 'sales', 'startup', 'funding']
    .reduce((score, term) => score + (lower.includes(term) ? 0.45 : 0), 0);
  const marketBoost = /\/(business|markets|finance|economy|technology|investing|stocks|companies)\b/i.test(link.url) ? 0.7 : 0;
  const noisePenalty = /(privacy|terms|login|signin|subscribe|newsletter|video|podcast|advertise|contact)/i.test(link.url) ? 1.8 : 0;
  return Number(Math.max(0, base + parentBoost + parentEventBoost + semanticBoost + fullTextBoost + linkEventBoost + companyInfoBoost + eventBoost + marketBoost - noisePenalty).toFixed(2));
}

function continuationReason(link) {
  const lower = `${link.text || ''} ${link.url || ''}`.toLowerCase();
  const reasons = [];
  const financialScore = financialWeights.scoreDocumentFinancialEvents({ title: link.text, text: link.url, url: link.url }).aggregateAbsScore;
  if (financialScore >= 1) reasons.push('weighted financial event');
  if (/(\$[A-Z]{1,5}\b|\bNASDAQ\b|\bNYSE\b|investor-relations|10-k|10-q|8-k)/i.test(`${link.text} ${link.url}`)) reasons.push('company/ticker evidence');
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

function stripTags(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  'weather',
  'crime',
  'housing',
  'office',
  'offices',
  'customers',
  'locations',
  'supply chain',
];

const STOP_WORDS = new Set(['with', 'from', 'that', 'this', 'have', 'into', 'after', 'before', 'about', 'market', 'stock', 'news', 'today']);
const SYMBOL_BLACKLIST = new Set(['CEO', 'CFO', 'COO', 'SEC', 'IPO', 'ETF', 'USA', 'USD', 'AI', 'EV', 'GDP', 'CPI', 'FED']);
const ENTITY_BLACKLIST = new Set(['the company', 'news corp', 'google news']);

module.exports = {
  DEFAULT_SEARCH_QUERIES,
  CURATED_MARKET_NEWS_SITES,
  crawlAutonomousResearch,
  crawlFromArticle,
  crawlSingleSource,
  scoreText,
  inferTags,
  extractEntityLeads,
  deriveSearchQueriesFromPage,
  buildSearchRequests,
  buildMarketNewsSiteSearchRequests,
  buildDuckDuckGoResultRequests,
  discoverDuckDuckGoResults,
  extractDuckDuckGoResultLinks,
  buildSemanticContext,
  extractLinks,
  extractLocalEventResearchQueries,
  selectPageSubLinks,
  unwrapSearchRedirect,
};
