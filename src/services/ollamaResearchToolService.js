const { config } = require('../config');

const USER_AGENT = 'Mozilla/5.0 AutoTrader Ollama research tool';
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_live_research',
      description: 'Search current web/news results for company, market, macro, product, or event research leads.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'The focused search query to run.' },
          reason: { type: 'string', description: 'Why the model needs this outside information.' },
          maxResults: { type: 'number', description: 'Maximum results to return, capped by the application.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_research_url',
      description: 'Fetch and summarize a public HTTP/HTTPS page that appeared in research evidence or search results.',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'The public URL to read.' },
          reason: { type: 'string', description: 'Why this URL may help the research decision.' },
        },
      },
    },
  },
];

function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

async function executeToolCall(call, { onEvent = () => {} } = {}) {
  const name = call?.function?.name || call?.name;
  const args = parseArguments(call?.function?.arguments || call?.arguments || {});
  emit(onEvent, 'ollama-tool', 38, 'debug', 'Ollama requested a local research tool.', {
    tool: name,
    args: sanitizeArgsForLog(args),
  });

  if (name === 'search_live_research') {
    const result = await searchLiveResearch({
      query: args.query,
      reason: args.reason,
      maxResults: args.maxResults,
    });
    emit(onEvent, 'ollama-tool', 39, 'debug', 'Ollama research search tool returned results.', {
      tool: name,
      query: args.query,
      results: result.results.length,
    });
    return result;
  }

  if (name === 'read_research_url') {
    const result = await readResearchUrl({ url: args.url, reason: args.reason });
    emit(onEvent, 'ollama-tool', 39, 'debug', 'Ollama research URL reader returned content.', {
      tool: name,
      url: result.url,
      ok: result.ok,
      title: result.title,
    });
    return result;
  }

  return { ok: false, error: `Unsupported research tool: ${name}` };
}

async function searchLiveResearch({ query, reason = '', maxResults = 5 } = {}) {
  const cleanQuery = cleanText(query).slice(0, 220);
  if (!cleanQuery) return { ok: false, tool: 'search_live_research', error: 'Missing query.', results: [] };
  const limit = Math.max(1, Math.min(Number(maxResults) || 5, 8));
  const [googleNews, duckDuckGo] = await Promise.allSettled([
    searchGoogleNews(cleanQuery, limit),
    searchDuckDuckGo(cleanQuery, limit),
  ]);
  const results = [
    ...(googleNews.status === 'fulfilled' ? googleNews.value : []),
    ...(duckDuckGo.status === 'fulfilled' ? duckDuckGo.value : []),
  ];
  return {
    ok: true,
    tool: 'search_live_research',
    query: cleanQuery,
    reason: cleanText(reason).slice(0, 300),
    results: dedupeResults(results).slice(0, limit),
  };
}

async function readResearchUrl({ url, reason = '' } = {}) {
  const clean = cleanUrl(url);
  if (!clean) return { ok: false, tool: 'read_research_url', error: 'URL must be public HTTP/HTTPS.', url: '' };
  try {
    const html = await fetchText(clean, config.ollamaToolTimeoutMs);
    const title = extractTitle(html) || clean;
    const text = htmlToText(html);
    const links = extractLinks(html, clean).slice(0, 8);
    return {
      ok: true,
      tool: 'read_research_url',
      url: clean,
      title,
      reason: cleanText(reason).slice(0, 300),
      excerpt: text.slice(0, 2400),
      links,
    };
  } catch (err) {
    return { ok: false, tool: 'read_research_url', url: clean, error: err.message };
  }
}

async function searchGoogleNews(query, limit) {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('ceid', 'US:en');
  const xml = await fetchText(url.toString(), config.ollamaToolTimeoutMs);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, limit).map((match) => {
    const item = match[1];
    return {
      title: decodeEntities(extractTag(item, 'title')),
      url: decodeEntities(extractTag(item, 'link')),
      snippet: decodeEntities(stripTags(extractTag(item, 'description'))).slice(0, 500),
      source: 'google-news-rss',
      publishedAt: decodeEntities(extractTag(item, 'pubDate')),
    };
  }).filter((item) => cleanUrl(item.url));
}

async function searchDuckDuckGo(query, limit) {
  const url = new URL('https://duckduckgo.com/html/');
  url.searchParams.set('q', query);
  url.searchParams.set('kl', 'us-en');
  const html = await fetchText(url.toString(), Math.min(config.ollamaToolTimeoutMs, 9000));
  const rows = [...html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  return rows.slice(0, limit).map((match) => ({
    title: decodeEntities(stripTags(match[2])),
    url: normalizeDuckDuckGoUrl(decodeEntities(match[1])),
    snippet: '',
    source: 'duckduckgo-html',
  })).filter((item) => cleanUrl(item.url));
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return text.slice(0, 400_000);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function dedupeResults(results) {
  const seen = new Set();
  return results.filter((item) => {
    const url = cleanUrl(item.url);
    if (!url || seen.has(url)) return false;
    seen.add(url);
    item.url = url;
    item.title = cleanText(item.title).slice(0, 220);
    item.snippet = cleanText(item.snippet).slice(0, 600);
    return true;
  });
}

function extractTag(value, tag) {
  const match = String(value || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1] : '';
}

function extractTitle(html) {
  return decodeEntities(stripTags(extractTag(html, 'title'))).slice(0, 220);
}

function htmlToText(html) {
  return decodeEntities(
    stripTags(String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' '))
  ).replace(/\s+/g, ' ').trim();
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function extractLinks(html, baseUrl) {
  const links = [];
  for (const match of String(html || '').matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
    try {
      links.push(cleanUrl(new URL(decodeEntities(match[1]), baseUrl).toString()));
    } catch {
      // Ignore malformed page links.
    }
  }
  return [...new Set(links.filter(Boolean))];
}

function normalizeDuckDuckGoUrl(value) {
  try {
    const parsed = new URL(value, 'https://duckduckgo.com');
    if (parsed.hostname.includes('duckduckgo.com') && parsed.searchParams.has('uddg')) {
      return parsed.searchParams.get('uddg') || value;
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function cleanUrl(value) {
  try {
    const parsed = new URL(cleanText(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.local') || isPrivateIpv4(hostname)) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254);
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || '{}'));
  } catch {
    return {};
  }
}

function sanitizeArgsForLog(args) {
  return {
    query: args.query ? cleanText(args.query).slice(0, 180) : undefined,
    url: args.url ? cleanText(args.url).slice(0, 240) : undefined,
    reason: args.reason ? cleanText(args.reason).slice(0, 180) : undefined,
  };
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  getToolDefinitions,
  executeToolCall,
  searchLiveResearch,
  readResearchUrl,
  cleanUrl,
};
