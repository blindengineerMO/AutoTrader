const { CheerioCrawler, LogLevel, log } = require('@crawlee/cheerio');

log.setLevel(LogLevel.ERROR);

const DEFAULT_SEARCH_QUERIES = [
  'Whats in the news today',
  'world economy markets today',
  'US market news today economy consumers oil energy defense',
];

async function crawlAutonomousResearch({ queries = DEFAULT_SEARCH_QUERIES, seedSources = [], onEvent = () => {}, maxFollowUps = 10 } = {}) {
  emit(onEvent, 'crawlee-search', 13, 'info', 'Starting autonomous Crawlee discovery from broad news search queries.', {
    queries: queries.slice(0, 4),
  });

  const searchRequests = queries.slice(0, 4).flatMap((query) => buildSearchRequests(query));
  const sourceRequests = seedSources.slice(0, 8).map((source) => ({
    url: source.url,
    userData: { type: 'learned-source', depth: 0, title: source.title, source },
  }));

  const firstPass = await crawlPages({
    requests: [...searchRequests, ...sourceRequests],
    label: 'seed/search',
    maxRequestsPerCrawl: searchRequests.length + sourceRequests.length,
    onEvent,
  });

  const followUps = firstPass
    .flatMap((page) => page.links.map((link) => ({ ...link, discoveredFromUrl: page.url })))
    .sort((a, b) => b.score - a.score)
    .filter((link) => link.score >= 2.5)
    .filter(uniqueByUrl())
    .slice(0, maxFollowUps);

  emit(onEvent, 'crawlee-spawn', 17, 'debug', 'Crawlee selected follow-up links from search and learned-source pages.', {
    selected: followUps.map((link) => ({ title: link.text, url: link.url, score: link.score })).slice(0, 8),
  });

  const secondPass = followUps.length
    ? await crawlPages({
        requests: followUps.map((link) => ({
          url: link.url,
          userData: { type: 'follow-up', depth: 1, title: link.text, discoveredFromUrl: link.discoveredFromUrl },
        })),
        label: 'follow-up',
        maxRequestsPerCrawl: followUps.length,
        onEvent,
      })
    : [];

  return {
    pages: [...firstPass, ...secondPass],
    discovered: followUps,
  };
}

async function crawlSingleSource({ source, onEvent = () => {} }) {
  const [page] = await crawlPages({
    requests: [{ url: source.url, userData: { type: 'learned-source', depth: 0, title: source.title, source } }],
    label: 'learned-source',
    maxRequestsPerCrawl: 1,
    onEvent,
  });
  if (!page) throw new Error(`Crawlee did not return content for ${source.url}`);
  return page;
}

async function crawlPages({ requests, label, maxRequestsPerCrawl, onEvent }) {
  const pages = [];
  if (!requests.length) return pages;

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
        excerpt: text.slice(0, 1000),
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
      emit(onEvent, 'crawlee-fetch', 16, 'warn', 'Crawlee request failed; continuing with remaining research targets.', {
        url: request.url,
        error: error.message,
      });
    },
  });

  await crawler.run(requests);
  return pages;
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

function uniqueByUrl() {
  const seen = new Set();
  return (item) => {
    const key = cleanUrl(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
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
];

module.exports = {
  DEFAULT_SEARCH_QUERIES,
  crawlAutonomousResearch,
  crawlSingleSource,
  scoreText,
  inferTags,
};
