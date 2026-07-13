const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');

const DOC_API_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const PROJECT_URL = 'https://www.gdeltproject.org/';

const SEARCH_PACKS = [
  {
    id: 'business-news',
    name: 'GDELT business news',
    query: 'business',
    timespan: '24h',
    maxrecords: 250,
    tags: ['business-news', 'global-news'],
  },
  {
    id: 'new-company',
    name: 'GDELT new company discovery',
    query: '"new company" OR startup OR "launched company"',
    timespan: '7d',
    maxrecords: 100,
    tags: ['new-company', 'startup'],
  },
  {
    id: 'funding',
    name: 'GDELT funding rounds',
    query: '(startup OR company) ("raised funding" OR "funding round" OR "series A")',
    timespan: '7d',
    maxrecords: 100,
    tags: ['funding', 'startup'],
  },
  {
    id: 'ipo',
    name: 'GDELT IPO watch',
    query: '(IPO OR "initial public offering" OR "filed to go public")',
    timespan: '7d',
    maxrecords: 100,
    tags: ['ipo', 'public-markets'],
  },
  {
    id: 'acquisition',
    name: 'GDELT acquisition watch',
    query: '(acquisition OR acquires OR merger) sourcecountry:US',
    timespan: '24h',
    maxrecords: 100,
    tags: ['acquisition', 'merger'],
  },
];

async function collectGdeltResearch({ userId, timeoutMs = 8000, onEvent = () => {} } = {}) {
  const settings = getSettings(userId);
  if (!settings.enabled) {
    return unavailableContext('GDELT DOC research is disabled.', []);
  }

  const packs = SEARCH_PACKS.map((pack) => ({
    ...pack,
    maxrecords: Math.min(settings.maxRecords, pack.maxrecords),
  }));
  const settled = await Promise.allSettled(
    packs.map((pack) => fetchSearchPack(pack, { timeoutMs }))
  );
  const articles = [];
  const sources = [];
  const failures = [];
  const entityLeads = [];

  settled.forEach((result, index) => {
    const pack = packs[index];
    if (result.status === 'fulfilled') {
      const normalized = normalizeArticles(result.value, pack);
      articles.push(...normalized);
      sources.push({
        name: pack.name,
        type: 'gdelt-doc-api',
        url: buildDocUrl(pack),
        query: pack.query,
        timespan: pack.timespan,
        maxrecords: pack.maxrecords,
      });
      entityLeads.push(...extractEntityLeads(normalized, pack));
      emit(onEvent, 'gdelt-doc', 21, 'debug', `${pack.name} returned global news articles.`, {
        pack: pack.id,
        articles: normalized.length,
      });
    } else {
      failures.push({ pack: pack.id, error: result.reason.message });
      emit(onEvent, 'gdelt-doc', 21, 'warn', `${pack.name} unavailable; continuing with remaining GDELT searches.`, {
        pack: pack.id,
        error: result.reason.message,
      });
    }
  });

  const dedupedArticles = dedupeArticles(articles);
  return {
    available: dedupedArticles.length > 0,
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(),
    sources,
    failures,
    articles: dedupedArticles,
    entityLeads: dedupeEntityLeads(entityLeads),
    summary: `GDELT DOC collected ${dedupedArticles.length} global business/news articles across ${sources.length} successful search packs.`,
  };
}

async function fetchSearchPack(pack, { timeoutMs = 8000 } = {}) {
  const url = buildDocUrl(pack);
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`GDELT DOC request failed with ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    const text = await res.text();
    throw new Error(`GDELT DOC returned non-JSON response: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  return res.json();
}

function buildDocUrl({ query, timespan = '24h', maxrecords = 100, mode = 'artlist', format = 'json', sort = 'datedesc' }) {
  const url = new URL(DOC_API_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('mode', mode);
  url.searchParams.set('format', format);
  url.searchParams.set('sort', sort);
  url.searchParams.set('timespan', timespan);
  url.searchParams.set('maxrecords', String(maxrecords));
  return url.toString().replace(/\+/g, '%20');
}

function normalizeArticles(payload, pack = {}) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  return articles
    .map((article) => {
      const url = article.url || article.url_mobile || '';
      const title = cleanText(article.title);
      if (!url || !title) return null;
      return {
        source: pack.name || 'GDELT DOC',
        sourceType: 'gdelt-doc',
        region: article.sourcecountry || 'global',
        title,
        link: url,
        url,
        publishedAt: article.seendate || article.seendatetime || article.datetime || null,
        description: cleanText(article.description || `${article.domain || 'global source'} ${pack.query || ''}`),
        domain: article.domain || safeHost(url),
        language: article.language || null,
        sourceCountry: article.sourcecountry || null,
        tone: parseNumber(article.tone),
        gdeltPack: pack.id,
        gdeltTags: pack.tags || [],
      };
    })
    .filter(Boolean);
}

function extractEntityLeads(articles, pack = {}) {
  if (!['new-company', 'funding', 'ipo', 'acquisition'].includes(pack.id)) return [];
  const leads = [];
  for (const article of articles) {
    const text = `${article.title} ${article.description}`;
    for (const symbol of extractTickers(text)) {
      leads.push({
        key: `gdelt:${symbol.toLowerCase()}`,
        name: symbol,
        symbol,
        type: 'gdelt-direct-ticker',
        score: leadScoreForPack(pack),
        evidence: [{ title: article.title, url: article.url, reason: `GDELT ${pack.id} headline included ticker ${symbol}.` }],
      });
    }
    for (const name of extractCompanyNames(text)) {
      leads.push({
        key: `gdelt:${name.toLowerCase()}`,
        name,
        symbol: '',
        type: `gdelt-${pack.id}`,
        score: leadScoreForPack(pack),
        evidence: [{ title: article.title, url: article.url, reason: `GDELT ${pack.id} article suggests follow-up research on ${name}.` }],
      });
    }
  }
  return leads;
}

function extractTickers(text) {
  const blacklist = new Set(['IPO', 'CEO', 'CFO', 'COO', 'USA', 'USD', 'SEC', 'AI', 'EV']);
  const symbols = new Set();
  for (const match of String(text || '').matchAll(/\$([A-Z]{1,5})\b|\(([A-Z]{1,5})\)/g)) {
    const symbol = match[1] || match[2];
    if (symbol && !blacklist.has(symbol)) symbols.add(symbol);
  }
  return [...symbols];
}

function extractCompanyNames(text) {
  const names = new Set();
  const patterns = [
    /\b([A-Z][A-Za-z0-9&.\- ]{2,60}?)\s+(?:raised funding|raises funding|announced funding|closed (?:a )?funding round|series A)\b/gi,
    /\b([A-Z][A-Za-z0-9&.\- ]{2,60}?)\s+(?:files?|filed)\s+(?:for|to go public|an IPO)\b/gi,
    /\b([A-Z][A-Za-z0-9&.\- ]{2,60}?)\s+(?:acquires|acquired|buys|merges with|announces acquisition)\b/gi,
    /\b(?:startup|new company)\s+([A-Z][A-Za-z0-9&.\- ]{2,60})\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of String(text || '').matchAll(pattern)) {
      const name = cleanCompanyName(match[1]);
      if (name) names.add(name);
    }
  }
  return [...names].slice(0, 8);
}

function dedupeArticles(articles) {
  const seen = new Set();
  const deduped = [];
  for (const article of articles) {
    const key = article.url || article.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(article);
  }
  return deduped;
}

function dedupeEntityLeads(leads) {
  const map = new Map();
  for (const lead of leads) {
    const key = lead.symbol ? `symbol:${lead.symbol}` : `name:${String(lead.name || '').toLowerCase()}`;
    if (!lead.name && !lead.symbol) continue;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, lead);
      continue;
    }
    existing.score = Math.max(existing.score || 0, lead.score || 0);
    existing.evidence = [...(existing.evidence || []), ...(lead.evidence || [])].slice(0, 5);
  }
  return [...map.values()].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 24);
}

function getSettings(userId) {
  const saved = userId ? providerCredentialRepo.getSecret(userId, 'gdelt') : null;
  return {
    enabled: parseBoolean(saved?.enabled, config.gdelt.enabled),
    maxRecords: Math.max(1, Math.min(250, Number(saved?.maxRecords || config.gdelt.maxRecords || 100))),
  };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 AutoTrader GDELT DOC research bot',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return [
    { name: 'GDELT Project', type: 'global-news-open-data', url: PROJECT_URL },
    { name: 'GDELT DOC 2.0 API', type: 'gdelt-doc-api', url: DOC_API_URL },
    ...SEARCH_PACKS.map((pack) => ({
      name: pack.name,
      type: 'gdelt-doc-query',
      url: buildDocUrl(pack),
      query: pack.query,
      timespan: pack.timespan,
    })),
  ];
}

function leadScoreForPack(pack) {
  if (pack.id === 'ipo') return 7.2;
  if (pack.id === 'funding') return 6.8;
  if (pack.id === 'acquisition') return 6.4;
  return 6;
}

function cleanCompanyName(value) {
  const clean = cleanText(value)
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\b(said|says|has|have|will|that|after|as|to|for|and|or)$/i, '')
    .trim();
  if (clean.length < 3 || clean.length > 80) return '';
  if (/^(startup|company|business|firm|market|investors?|funding|ipo)$/i.test(clean)) return '';
  return clean;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  return ['1', 'true', 'yes', 'enabled', 'on'].includes(String(value).trim().toLowerCase());
}

function unavailableContext(reason, failures = []) {
  return {
    available: false,
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(),
    sources: [],
    failures,
    articles: [],
    entityLeads: [],
    summary: `GDELT DOC unavailable: ${reason}`,
    reason,
  };
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  DOC_API_URL,
  SEARCH_PACKS,
  collectGdeltResearch,
  buildDocUrl,
  normalizeArticles,
  extractEntityLeads,
  dedupeArticles,
};
