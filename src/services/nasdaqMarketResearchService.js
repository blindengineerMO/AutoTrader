const { resilientFetch } = require('../utils/resilientFetch');
const cheerio = require('cheerio');

const NASDAQ_HOME_URL = 'https://www.nasdaq.com/';
const NASDAQ_MARKET_ACTIVITY_URL = 'https://www.nasdaq.com/market-activity';
const NASDAQ_STOCKS_URL = 'https://www.nasdaq.com/market-activity/stocks';
const NASDAQ_EARNINGS_URL = 'https://www.nasdaq.com/market-activity/earnings';
const NASDAQ_IPOS_URL = 'https://www.nasdaq.com/market-activity/ipos';

const NASDAQ_SCREENS = [
  {
    id: 'market-activity',
    label: 'Market Activity',
    url: NASDAQ_MARKET_ACTIVITY_URL,
    stance: 'attention',
    weight: 0.58,
    category: 'market-overview',
  },
  {
    id: 'stocks',
    label: 'Stocks',
    url: NASDAQ_STOCKS_URL,
    stance: 'attention',
    weight: 0.6,
    category: 'stock-directory-discovery',
  },
  {
    id: 'earnings-calendar',
    label: 'Earnings Calendar',
    url: NASDAQ_EARNINGS_URL,
    stance: 'attention',
    weight: 0.66,
    category: 'earnings-catalyst',
  },
  {
    id: 'ipo-calendar',
    label: 'IPO Calendar',
    url: NASDAQ_IPOS_URL,
    stance: 'bullish',
    weight: 0.7,
    category: 'ipo-catalyst',
  },
];

const COMPANY_PAGE_TYPES = [
  {
    id: 'analyst-research',
    label: 'Analyst Research',
    path: 'analyst-research',
    focus: 'analyst ratings, targets, and estimate sentiment',
    stance: 'attention',
  },
  {
    id: 'institutional-holdings',
    label: 'Institutional Holdings',
    path: 'institutional-holdings',
    focus: 'institutional ownership and fund-flow confidence',
    stance: 'bullish',
  },
  {
    id: 'insider-activity',
    label: 'Insider Activity',
    path: 'insider-activity',
    focus: 'insider buying/selling and ownership signal',
    stance: 'attention',
  },
];

async function collectNasdaqMarketResearchContext({
  timeoutMs = 8000,
  limit = 12,
  screenIds,
  includeCompanyPages = false,
  companySymbols = [],
  onEvent = () => {},
} = {}) {
  const selectedIds = new Set((Array.isArray(screenIds) ? screenIds : []).filter(Boolean));
  const screens = selectedIds.size
    ? NASDAQ_SCREENS.filter((screen) => selectedIds.has(screen.id))
    : NASDAQ_SCREENS;
  const boundedLimit = clampInt(limit, 1, 50);

  const settled = await Promise.allSettled(screens.map(async (screen) => {
    const html = await fetchHtml(screen.url, timeoutMs);
    const rows = parseMarketRows(html, screen).slice(0, boundedLimit);
    emit(onEvent, 'nasdaq-market-research', 36, 'debug', 'Fetched Nasdaq market research page.', {
      screen: screen.id,
      rows: rows.length,
      url: screen.url,
    });
    return { screen, rows };
  }));

  const screenResults = [];
  const failures = [];
  settled.forEach((result, index) => {
    const screen = screens[index];
    if (result.status === 'fulfilled') {
      screenResults.push(result.value);
    } else {
      failures.push({ screen: screen.id, url: screen.url, error: result.reason.message });
      emit(onEvent, 'nasdaq-market-research', 36, 'warn', 'Nasdaq page unavailable; continuing with remaining screens.', {
        screen: screen.id,
        url: screen.url,
        error: result.reason.message,
      });
    }
  });

  let companyPages = [];
  if (includeCompanyPages) {
    const symbols = [...new Set([
      ...normalizeSymbolList(companySymbols),
      ...screenResults.flatMap((result) => (result.rows || []).map((row) => row.symbol)),
    ])].slice(0, Math.min(boundedLimit, 12));
    companyPages = await collectCompanyPages({ symbols, timeoutMs, onEvent, failures });
  }

  return evaluateNasdaqContext({ screenResults, companyPages, failures });
}

function parseMarketRows(html, screen = {}) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();

  $('a[href*="/market-activity/stocks/"]').each((_, anchor) => {
    const href = $(anchor).attr('href') || '';
    const symbol = cleanSymbol(extractTickerFromHref(href) || $(anchor).text());
    if (!symbol || seen.has(`${screen.id}:${symbol}`)) return;
    const rowText = nearestRecordText($, anchor, symbol);
    const companyName = findCompanyName($, anchor, href, symbol, rowText);
    const metrics = extractMarketMetrics(rowText);
    const signalScore = scoreScreenRecord(screen, metrics);
    rows.push({
      symbol,
      companyName,
      price: metrics.price,
      changePct: metrics.changePct,
      volumeRaw: metrics.volumeRaw,
      volume: parseAbbreviatedNumber(metrics.volumeRaw),
      marketCapRaw: metrics.marketCapRaw,
      screenId: screen.id,
      signal: screen.label,
      category: screen.category,
      stance: screen.stance,
      signalScore,
      quoteUrl: stockUrl(symbol),
      sourceUrl: screen.url,
      rowText: rowText.slice(0, 650),
      reason: `${screen.label} Nasdaq ${screen.category || 'market'} signal${Number.isFinite(metrics.changePct) ? ` with ${metrics.changePct}% visible move` : ''}.`,
    });
    seen.add(`${screen.id}:${symbol}`);
  });

  return rows;
}

function evaluateNasdaqContext({ screenResults = [], companyPages = [], failures = [] } = {}) {
  const records = screenResults.flatMap((result) => result.rows || []);
  const earnings = records.filter((item) => item.screenId === 'earnings-calendar');
  const ipos = records.filter((item) => item.screenId === 'ipo-calendar');
  const attention = records.filter((item) => ['attention', 'bullish'].includes(item.stance));
  const analystPages = companyPages.filter((item) => item.pageType === 'analyst-research');
  const institutionalPages = companyPages.filter((item) => item.pageType === 'institutional-holdings');
  const insiderPages = companyPages.filter((item) => item.pageType === 'insider-activity');
  const uniqueSymbols = [...new Set(records.map((item) => item.symbol))];
  const attentionScore = average(attention.map((item) => item.signalScore));
  const companyResearchScore = clampScore(50 + analystPages.length * 2 + institutionalPages.length * 2.2 + insiderPages.length * 1.8);
  const catalystScore = clampScore(48 + earnings.length * 1.3 + ipos.length * 2.2 + uniqueSymbols.length * 0.7);
  const opportunityScore = clampScore(46 + (attentionScore - 50) * 0.34 + (companyResearchScore - 50) * 0.28 + catalystScore * 0.18);
  const riskScore = clampScore(48 + failures.length * 2.2 - (opportunityScore - 50) * 0.16);
  const momentum = ipos.length >= 3 || opportunityScore >= 64 ? 'nasdaq-catalyst-rich'
    : earnings.length >= 3 ? 'nasdaq-earnings-watch'
      : 'nasdaq-mixed';

  return {
    available: records.length > 0 || companyPages.length > 0,
    fetchedAt: new Date().toISOString(),
    provider: 'nasdaq',
    quoteDelayNote: 'Nasdaq public market research pages can be rendered, delayed, or markup-variable; verify with broker quotes, SEC filings, Nasdaq Trader/security-master data, Finnhub, and independent news before trading.',
    sourceList: sourceList(),
    failures,
    screenCount: screenResults.length,
    signalCount: records.length,
    uniqueSymbolCount: uniqueSymbols.length,
    earningsCatalystCount: earnings.length,
    ipoCatalystCount: ipos.length,
    companyPageCount: companyPages.length,
    analystPageCount: analystPages.length,
    institutionalHoldingPageCount: institutionalPages.length,
    insiderActivityPageCount: insiderPages.length,
    opportunityScore,
    riskScore,
    catalystScore,
    companyResearchScore,
    momentum,
    records,
    companyPages,
    topSignals: attention.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    earningsCatalysts: earnings.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    ipoCatalysts: ipos.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    analystResearch: analystPages.slice(0, 12),
    institutionalHoldings: institutionalPages.slice(0, 12),
    insiderActivity: insiderPages.slice(0, 12),
    narrative: records.length || companyPages.length
      ? `Nasdaq ${momentum}: ${records.length} visible market/catalyst rows, ${earnings.length} earnings rows, ${ipos.length} IPO rows, ${companyPages.length} company research snippets. Opportunity ${opportunityScore}, risk ${riskScore}.`
      : 'Nasdaq market research context unavailable; public pages may be blocked, rendered client-side, throttled, or changed.',
  };
}

function scoreCandidate({ candidate, nasdaqContext }) {
  if (!nasdaqContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, signals: [], companyPages: [], explanation: 'Nasdaq market research context unavailable.' };
  }
  const symbol = cleanSymbol(candidate?.symbol);
  const signals = (nasdaqContext.records || []).filter((item) => item.symbol === symbol);
  const companyPages = (nasdaqContext.companyPages || []).filter((item) => item.symbol === symbol);
  if (!signals.length && !companyPages.length) {
    return {
      normalized: 0.5,
      compositeScore: 50,
      exposure: 10,
      signals: [],
      companyPages: [],
      explanation: `${symbol || 'Candidate'} did not appear in current Nasdaq market/catalyst pages or requested company research snippets.`,
    };
  }
  const signalAverage = average(signals.map((item) => item.signalScore));
  const earningsSignals = signals.filter((item) => item.screenId === 'earnings-calendar');
  const ipoSignals = signals.filter((item) => item.screenId === 'ipo-calendar');
  const institutionalPages = companyPages.filter((item) => item.pageType === 'institutional-holdings');
  const insiderPages = companyPages.filter((item) => item.pageType === 'insider-activity');
  const exposure = clamp01(0.32 + signals.length * 0.12 + companyPages.length * 0.04 + institutionalPages.length * 0.04 + insiderPages.length * 0.03);
  const raw = 0.5
    + ((signalAverage - 50) / 100) * exposure
    + earningsSignals.length * 0.025
    + ipoSignals.length * 0.04
    + institutionalPages.length * 0.025
    + insiderPages.length * 0.015;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    signals: signals.slice(0, 8),
    companyPages: companyPages.slice(0, 8),
    explanation: `Nasdaq signals for ${symbol || candidate?.companyName || 'candidate'}: ${signals.map((item) => item.signal).join(', ') || 'no direct ticker row'}${companyPages.length ? `; company pages ${companyPages.map((page) => page.pageType).join(', ')}` : ''}. Verify scraped Nasdaq public-page output with broker quotes, SEC filings, Nasdaq Trader/security-master data, Finnhub, and independent news before live orders.`,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'nasdaq',
    fetchedAt: context.fetchedAt,
    momentum: context.momentum,
    opportunityScore: context.opportunityScore,
    riskScore: context.riskScore,
    catalystScore: context.catalystScore,
    companyResearchScore: context.companyResearchScore,
    signalCount: context.signalCount || 0,
    earningsCatalystCount: context.earningsCatalystCount || 0,
    ipoCatalystCount: context.ipoCatalystCount || 0,
    companyPageCount: context.companyPageCount || 0,
    topSignals: (context.topSignals || []).slice(0, 8).map(compactRecord),
    earningsCatalysts: (context.earningsCatalysts || []).slice(0, 8).map(compactRecord),
    ipoCatalysts: (context.ipoCatalysts || []).slice(0, 8).map(compactRecord),
    analystResearch: (context.analystResearch || []).slice(0, 8).map(compactCompanyPage),
    institutionalHoldings: (context.institutionalHoldings || []).slice(0, 8).map(compactCompanyPage),
    insiderActivity: (context.insiderActivity || []).slice(0, 8).map(compactCompanyPage),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.quoteDelayNote || 'Scraped Nasdaq public market research pages should be verified with primary market, filing, and independent news sources before trading.',
    bmclUse: 'Use as scraped Nasdaq market research, earnings/IPO catalyst, analyst-research, institutional-holdings, and insider-activity discovery evidence. Share compact ticker/catalyst/company-page rows for candidate generation, self-improvement, and council debate, then corroborate with broker quotes, SEC filings, Nasdaq Trader/security-master data, Finnhub, GDELT/Google News, and official sources before scoring live trades.',
  };
}

async function collectCompanyPages({ symbols, timeoutMs, onEvent, failures }) {
  const pages = [];
  const tasks = [];
  for (const symbol of symbols) {
    for (const page of COMPANY_PAGE_TYPES) {
      tasks.push({ symbol, page });
    }
  }
  const settled = await Promise.allSettled(tasks.map(async ({ symbol, page }) => {
    const url = companyPageUrl(symbol, page.path);
    const html = await fetchHtml(url, timeoutMs);
    const snippet = extractCompanyPageSnippet(html);
    emit(onEvent, 'nasdaq-company-page', 37, 'debug', 'Fetched Nasdaq company research page.', {
      symbol,
      page: page.id,
      url,
      snippetLength: snippet.length,
    });
    return {
      symbol,
      pageType: page.id,
      label: page.label,
      focus: page.focus,
      stance: page.stance,
      url,
      snippet,
    };
  }));

  settled.forEach((result, index) => {
    const task = tasks[index];
    if (result.status === 'fulfilled') {
      pages.push(result.value);
    } else {
      failures.push({ screen: `company-${task.page.id}`, url: companyPageUrl(task.symbol, task.page.path), error: result.reason.message });
      emit(onEvent, 'nasdaq-company-page', 37, 'warn', 'Nasdaq company research page unavailable; continuing with remaining pages.', {
        symbol: task.symbol,
        page: task.page.id,
        error: result.reason.message,
      });
    }
  });
  return pages;
}

async function fetchHtml(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 AutoTrader Nasdaq market research bot; contact=local',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers, redirect: 'follow' }, { bucket: 'nasdaq', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return [
    { name: 'Nasdaq main site', type: 'nasdaq-main', url: NASDAQ_HOME_URL },
    ...NASDAQ_SCREENS.map((screen) => ({ name: `Nasdaq ${screen.label}`, type: `nasdaq-${screen.category}`, url: screen.url, screenId: screen.id })),
    ...COMPANY_PAGE_TYPES.map((page) => ({
      name: `Nasdaq quote ${page.label}`,
      type: `nasdaq-company-${page.id}`,
      url: companyPageUrl('{ticker}', page.path),
      urlPattern: companyPageUrl('{ticker}', page.path),
      focus: page.focus,
    })),
  ];
}

function compactRecord(record) {
  return {
    symbol: record.symbol,
    companyName: record.companyName,
    signal: record.signal,
    category: record.category,
    stance: record.stance,
    signalScore: record.signalScore,
    price: record.price,
    changePct: record.changePct,
    volumeRaw: record.volumeRaw,
    marketCapRaw: record.marketCapRaw,
    sourceUrl: record.sourceUrl,
  };
}

function compactCompanyPage(page) {
  return {
    symbol: page.symbol,
    pageType: page.pageType,
    label: page.label,
    focus: page.focus,
    url: page.url,
    snippet: cleanText(page.snippet).slice(0, 420),
  };
}

function extractTickerFromHref(href = '') {
  try {
    const parsed = new URL(href, NASDAQ_HOME_URL);
    const match = parsed.pathname.match(/\/market-activity\/stocks\/([^/]+)/i);
    return match?.[1] || '';
  } catch {
    const match = String(href || '').match(/\/market-activity\/stocks\/([^/?#]+)/i);
    return match?.[1] || '';
  }
}

function findCompanyName($, anchor, href, symbol, rowText = '') {
  const siblings = $(anchor).closest('tr,div,li').find(`a[href="${href}"]`).toArray()
    .map((link) => cleanText($(link).text()))
    .filter((text) => text && cleanSymbol(text) !== symbol);
  if (siblings[0]) return siblings[0];
  const tokens = rowText.split(/\s{2,}| \| | • /).map(cleanText).filter(Boolean);
  return tokens.find((token) => token.length > 3 && !isTicker(token) && !/^\$?\d/.test(token)) || '';
}

function nearestRecordText($, anchor, needle) {
  let current = $(anchor);
  for (let depth = 0; depth < 7; depth += 1) {
    current = current.parent();
    if (!current.length) break;
    const text = nodeText($, current);
    if (text.includes(needle) && text.length <= 2600 && (/%|\bUSD\b|\bVolume\b|\bMarket Cap\b|\bEarnings\b|\bIPO\b|\d/.test(text))) {
      return text;
    }
  }
  return nodeText($, $(anchor).closest('tr'));
}

function extractMarketMetrics(rowText) {
  const text = cleanText(rowText);
  const percentMatch = text.match(/[-+]?\d+(?:\.\d+)?%/);
  const moneyMatches = [...text.matchAll(/\$?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?USD)?/gi)]
    .map((match) => match[0])
    .filter((value) => !/%/.test(value));
  const abbreviatedMatches = [...text.matchAll(/\b\d+(?:\.\d+)?\s?[KMBT](?:\s?USD)?\b/gi)].map((match) => match[0]);
  const volumeMatch = abbreviatedMatches.find((value) => !/\bUSD\b/i.test(value)) || '';
  const marketCapMatch = abbreviatedMatches.find((value) => /\bUSD\b/i.test(value)) || abbreviatedMatches.at(-1) || '';
  return {
    price: moneyMatches.length ? parseNumber(moneyMatches[0]) : null,
    changePct: percentMatch ? parseNumber(percentMatch[0]) : null,
    volumeRaw: volumeMatch ? volumeMatch.replace(/\s+/g, '').replace(/USD/i, '') : '',
    marketCapRaw: marketCapMatch ? marketCapMatch.replace(/\s+/g, '') : '',
  };
}

function extractCompanyPageSnippet(html) {
  const $ = cheerio.load(String(html || ''));
  $('script, style, noscript, svg').remove();
  const text = cleanText($('main').text() || $('body').text());
  return text.slice(0, 1400);
}

function scoreScreenRecord(screen, metrics = {}) {
  const base = screen.stance === 'bullish' ? 62 : 54;
  const move = Number.isFinite(metrics.changePct) ? Math.min(14, Math.abs(metrics.changePct) * 0.55) : 0;
  const catalystBonus = screen.id === 'earnings-calendar' ? 5 : screen.id === 'ipo-calendar' ? 7 : 0;
  return clampScore(base + move + catalystBonus + (screen.weight - 0.6) * 20);
}

function companyPageUrl(symbol, path) {
  return `${NASDAQ_HOME_URL}market-activity/stocks/${String(symbol || '').toLowerCase()}/${path}`;
}

function stockUrl(symbol) {
  return `${NASDAQ_HOME_URL}market-activity/stocks/${String(symbol || '').toLowerCase()}`;
}

function nodeText($, node) {
  const cellTexts = $(node).find('th,td').toArray()
    .map((cell) => cleanText($(cell).text()))
    .filter(Boolean);
  if (cellTexts.length) return cleanText(cellTexts.join(' | '));
  const directTexts = $(node).children().toArray()
    .map((child) => cleanText($(child).text()))
    .filter(Boolean);
  return cleanText(directTexts.length ? directTexts.join(' | ') : $(node).text());
}

function normalizeSymbolList(symbols) {
  return (Array.isArray(symbols) ? symbols : [symbols])
    .map(cleanSymbol)
    .filter(Boolean);
}

function isTicker(value) {
  return /^[A-Z][A-Z0-9.-]{0,7}$/.test(cleanText(value));
}

function cleanSymbol(value) {
  const symbol = cleanText(value).toUpperCase().replace(/[^A-Z0-9.-]/g, '');
  return isTicker(symbol) ? symbol : '';
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseNumber(value) {
  const parsed = Number(String(value || '').replace(/[$,%]/g, '').replace(/,/g, '').replace(/\s?USD/i, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAbbreviatedNumber(value) {
  const match = String(value || '').replace(/,/g, '').match(/^([-+]?\d+(?:\.\d+)?)([KMBT])?$/i);
  if (!match) return null;
  const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 };
  return Number(match[1]) * (multipliers[match[2]?.toUpperCase()] || 1);
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return 50;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function clampScore(value) {
  return Math.round(clamp(value, 0, 100));
}

function clampInt(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  NASDAQ_HOME_URL,
  NASDAQ_MARKET_ACTIVITY_URL,
  NASDAQ_STOCKS_URL,
  NASDAQ_EARNINGS_URL,
  NASDAQ_IPOS_URL,
  NASDAQ_SCREENS,
  COMPANY_PAGE_TYPES,
  collectNasdaqMarketResearchContext,
  parseMarketRows,
  evaluateNasdaqContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
