const { resilientFetch } = require('../utils/resilientFetch');
const cheerio = require('cheerio');

const YAHOO_FINANCE_HOME_URL = 'https://finance.yahoo.com/';
const YAHOO_SCREENER_HUB_URL = 'https://finance.yahoo.com/research-hub/screener/';
const YAHOO_EQUITY_SCREENER_URL = 'https://finance.yahoo.com/research-hub/screener/equity/';
const YAHOO_ANALYST_RATINGS_URL = 'https://finance.yahoo.com/research-hub/screener/analyst_ratings/';
const YAHOO_GAINERS_URL = 'https://finance.yahoo.com/markets/stocks/gainers/';
const YAHOO_LOSERS_URL = 'https://finance.yahoo.com/markets/stocks/losers/';
const YAHOO_MOST_ACTIVE_URL = 'https://finance.yahoo.com/markets/stocks/most-active/';
const YAHOO_TRENDING_URL = 'https://finance.yahoo.com/markets/stocks/trending/';

const YAHOO_SCREENS = [
  {
    id: 'equity-screener',
    label: 'Equity Screener',
    url: YAHOO_EQUITY_SCREENER_URL,
    stance: 'attention',
    weight: 0.62,
    category: 'equity-screening',
  },
  {
    id: 'analyst-ratings',
    label: 'Analyst Ratings Screener',
    url: YAHOO_ANALYST_RATINGS_URL,
    stance: 'bullish',
    weight: 0.72,
    category: 'analyst-ratings',
  },
  {
    id: 'gainers',
    label: 'Stock Gainers',
    url: YAHOO_GAINERS_URL,
    stance: 'bullish',
    weight: 0.84,
    category: 'market-movers',
  },
  {
    id: 'losers',
    label: 'Stock Losers',
    url: YAHOO_LOSERS_URL,
    stance: 'bearish',
    weight: 0.84,
    category: 'market-movers',
  },
  {
    id: 'most-active',
    label: 'Most Active Stocks',
    url: YAHOO_MOST_ACTIVE_URL,
    stance: 'attention',
    weight: 0.58,
    category: 'liquidity-attention',
  },
  {
    id: 'trending',
    label: 'Trending Stocks',
    url: YAHOO_TRENDING_URL,
    stance: 'attention',
    weight: 0.62,
    category: 'attention-trends',
  },
];

const COMPANY_PAGE_TYPES = [
  { id: 'analysis', label: 'Analysis', path: 'analysis', focus: 'analyst estimates and earnings growth' },
  { id: 'financials', label: 'Financials', path: 'financials', focus: 'income statement and revenue/profit trends' },
  { id: 'cash-flow', label: 'Cash Flow', path: 'cash-flow', focus: 'operating/free cash flow and financing activity' },
  { id: 'balance-sheet', label: 'Balance Sheet', path: 'balance-sheet', focus: 'assets, liabilities, debt, and liquidity' },
];

async function collectYahooFinanceScreenerContext({
  timeoutMs = 8000,
  limit = 12,
  screenIds,
  includeCompanyPages = false,
  companySymbols = [],
  onEvent = () => {},
} = {}) {
  const selectedIds = new Set((Array.isArray(screenIds) ? screenIds : []).filter(Boolean));
  const screens = selectedIds.size
    ? YAHOO_SCREENS.filter((screen) => selectedIds.has(screen.id))
    : YAHOO_SCREENS;
  const boundedLimit = clampInt(limit, 1, 50);

  const settled = await Promise.allSettled(screens.map(async (screen) => {
    const html = await fetchHtml(screen.url, timeoutMs);
    const rows = parseMarketRows(html, screen).slice(0, boundedLimit);
    emit(onEvent, 'yahoo-finance-screener', 35, 'debug', 'Fetched Yahoo Finance screener page.', {
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
      emit(onEvent, 'yahoo-finance-screener', 35, 'warn', 'Yahoo Finance screener page unavailable; continuing with remaining screens.', {
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

  return evaluateYahooFinanceContext({ screenResults, companyPages, failures });
}

function parseMarketRows(html, screen = {}) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();

  $('a[href*="/quote/"]').each((_, anchor) => {
    const href = $(anchor).attr('href') || '';
    const symbol = cleanSymbol(extractTickerFromHref(href) || $(anchor).text());
    if (!symbol || seen.has(`${screen.id}:${symbol}`)) return;
    const rowText = nearestRecordText($, anchor, symbol);
    const companyName = findCompanyName($, anchor, href, symbol, rowText);
    const metrics = extractMarketMetrics(rowText);
    rows.push({
      symbol,
      companyName,
      price: metrics.price,
      changePct: metrics.changePct,
      volumeRaw: metrics.volumeRaw,
      volume: parseAbbreviatedNumber(metrics.volumeRaw),
      marketCapRaw: metrics.marketCapRaw,
      pe: metrics.pe,
      analystRating: metrics.analystRating,
      screenId: screen.id,
      signal: screen.label,
      stance: screen.stance,
      signalScore: scoreScreenRecord(screen, metrics.changePct, metrics),
      quoteUrl: absolutize(href),
      sourceUrl: screen.url,
      rowText: rowText.slice(0, 650),
      reason: `${screen.label} Yahoo Finance ${screen.category || 'market'} signal${Number.isFinite(metrics.changePct) ? ` with ${metrics.changePct}% visible move` : ''}.`,
    });
    seen.add(`${screen.id}:${symbol}`);
  });

  return rows;
}

function evaluateYahooFinanceContext({ screenResults = [], companyPages = [], failures = [] } = {}) {
  const records = screenResults.flatMap((result) => result.rows || []);
  const bullish = records.filter((item) => ['bullish', 'attention'].includes(item.stance));
  const bearish = records.filter((item) => item.stance === 'bearish');
  const analystSignals = records.filter((item) => item.screenId === 'analyst-ratings');
  const gainers = records.filter((item) => item.screenId === 'gainers');
  const losers = records.filter((item) => item.screenId === 'losers');
  const uniqueSymbols = [...new Set(records.map((item) => item.symbol))];
  const bullishScore = average(bullish.map((item) => item.signalScore));
  const bearishPressure = average(bearish.map((item) => 100 - item.signalScore));
  const analystScore = average(analystSignals.map((item) => item.signalScore));
  const breadthScore = clampScore(48 + uniqueSymbols.length * 1.05 + bullish.length * 0.55 - bearish.length * 0.35);
  const opportunityScore = clampScore(48 + (bullishScore - 50) * 0.36 + (analystScore - 50) * 0.22 + breadthScore * 0.17 + companyPages.length * 0.5);
  const riskScore = clampScore(50 + (bearishPressure - 50) * 0.5 + losers.length * 1.1 + failures.length * 2 - gainers.length * 0.35);
  const momentum = opportunityScore >= 64 ? 'yahoo-risk-on'
    : riskScore >= 62 ? 'yahoo-risk-off'
      : 'yahoo-mixed';

  return {
    available: records.length > 0 || companyPages.length > 0,
    fetchedAt: new Date().toISOString(),
    provider: 'yahoo-finance',
    quoteDelayNote: 'Yahoo Finance consumer pages are scraped/unsupported and may include delayed data; verify with broker/Finnhub/SEC/news before trading.',
    sourceList: sourceList(),
    failures,
    screenCount: screenResults.length,
    signalCount: records.length,
    uniqueSymbolCount: uniqueSymbols.length,
    bullishCount: bullish.length,
    bearishCount: bearish.length,
    analystSignalCount: analystSignals.length,
    companyPageCount: companyPages.length,
    opportunityScore,
    riskScore,
    breadthScore,
    momentum,
    records,
    companyPages,
    topMomentum: bullish.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    topGainers: gainers.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    topLosers: losers.sort((a, b) => a.signalScore - b.signalScore).slice(0, 12),
    topAnalyst: analystSignals.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    mostActive: records.filter((item) => item.screenId === 'most-active').slice(0, 12),
    trending: records.filter((item) => item.screenId === 'trending').slice(0, 12),
    narrative: records.length || companyPages.length
      ? `Yahoo Finance ${momentum}: ${records.length} visible screener/mover rows, ${analystSignals.length} analyst-rating rows, ${gainers.length} gainers, ${losers.length} losers, ${companyPages.length} company-page snippets. Opportunity ${opportunityScore}, risk ${riskScore}.`
      : 'Yahoo Finance screener context unavailable; public consumer pages may be blocked, throttled, or changed.',
  };
}

function scoreCandidate({ candidate, yahooFinanceContext }) {
  if (!yahooFinanceContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, signals: [], companyPages: [], explanation: 'Yahoo Finance screener context unavailable.' };
  }
  const symbol = cleanSymbol(candidate?.symbol);
  const signals = (yahooFinanceContext.records || []).filter((item) => item.symbol === symbol);
  const companyPages = (yahooFinanceContext.companyPages || []).filter((item) => item.symbol === symbol);
  if (!signals.length && !companyPages.length) {
    return {
      normalized: 0.5,
      compositeScore: 50,
      exposure: 10,
      signals: [],
      companyPages: [],
      explanation: `${symbol || 'Candidate'} did not appear in current Yahoo Finance screener/mover rows or requested company-page snippets.`,
    };
  }
  const bullishSignals = signals.filter((item) => ['bullish', 'attention'].includes(item.stance));
  const bearishSignals = signals.filter((item) => item.stance === 'bearish');
  const analystSignals = signals.filter((item) => item.screenId === 'analyst-ratings');
  const signalAverage = average(signals.map((item) => item.signalScore));
  const pageBonus = Math.min(0.08, companyPages.length * 0.02);
  const exposure = clamp01(0.34 + signals.length * 0.13 + analystSignals.length * 0.08 + companyPages.length * 0.03);
  const raw = 0.5
    + ((signalAverage - 50) / 100) * exposure
    + (bullishSignals.length - bearishSignals.length) * 0.03
    + analystSignals.length * 0.035
    + pageBonus;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    signals: signals.slice(0, 8),
    companyPages: companyPages.slice(0, 8),
    explanation: `Yahoo Finance signals for ${symbol || candidate?.companyName || 'candidate'}: ${signals.map((item) => item.signal).join(', ') || 'no direct ticker row'}${companyPages.length ? `; company pages ${companyPages.map((page) => page.pageType).join(', ')}` : ''}. Verify scraped/unsupported Yahoo Finance output before live orders.`,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'yahoo-finance',
    fetchedAt: context.fetchedAt,
    momentum: context.momentum,
    opportunityScore: context.opportunityScore,
    riskScore: context.riskScore,
    signalCount: context.signalCount || 0,
    bullishCount: context.bullishCount || 0,
    bearishCount: context.bearishCount || 0,
    analystSignalCount: context.analystSignalCount || 0,
    companyPageCount: context.companyPageCount || 0,
    topMomentum: (context.topMomentum || []).slice(0, 8).map(compactRecord),
    topGainers: (context.topGainers || []).slice(0, 8).map(compactRecord),
    topLosers: (context.topLosers || []).slice(0, 8).map(compactRecord),
    topAnalyst: (context.topAnalyst || []).slice(0, 8).map(compactRecord),
    mostActive: (context.mostActive || []).slice(0, 8).map(compactRecord),
    trending: (context.trending || []).slice(0, 8).map(compactRecord),
    companyPages: (context.companyPages || []).slice(0, 12).map(compactCompanyPage),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.quoteDelayNote || 'Scraped Yahoo Finance screener data should be verified with primary market and filing sources before trading.',
    bmclUse: 'Use as scraped/unsupported Yahoo Finance market-screener discovery and self-improvement evidence. Share compact ticker/signal/company-page rows for gainers, losers, most-active, trending, analyst-rating, analysis, financials, cash-flow, and balance-sheet debate, then corroborate with broker quotes, Finnhub/company research, SEC filings, GDELT/Google News, and official sources before scoring live trades.',
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
    emit(onEvent, 'yahoo-finance-company-page', 36, 'debug', 'Fetched Yahoo Finance company page.', {
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
      emit(onEvent, 'yahoo-finance-company-page', 36, 'warn', 'Yahoo Finance company page unavailable; continuing with remaining pages.', {
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
    'User-Agent': 'Mozilla/5.0 AutoTrader Yahoo Finance research bot; contact=local',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers, redirect: 'follow' }, { bucket: 'yahoo-finance', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return [
    { name: 'Yahoo Finance home', type: 'yahoo-finance-home', url: YAHOO_FINANCE_HOME_URL },
    { name: 'Yahoo Finance screener hub', type: 'yahoo-finance-screener-hub', url: YAHOO_SCREENER_HUB_URL },
    ...YAHOO_SCREENS.map((screen) => ({ name: `Yahoo Finance ${screen.label}`, type: `yahoo-finance-${screen.category}`, url: screen.url, screenId: screen.id })),
    ...COMPANY_PAGE_TYPES.map((page) => ({ name: `Yahoo Finance quote ${page.label}`, type: `yahoo-finance-company-${page.id}`, url: `https://finance.yahoo.com/quote/{ticker}/${page.path}/`, urlPattern: `https://finance.yahoo.com/quote/{ticker}/${page.path}/`, focus: page.focus })),
  ];
}

function compactRecord(record) {
  return {
    symbol: record.symbol,
    companyName: record.companyName,
    signal: record.signal,
    stance: record.stance,
    signalScore: record.signalScore,
    price: record.price,
    changePct: record.changePct,
    volumeRaw: record.volumeRaw,
    marketCapRaw: record.marketCapRaw,
    analystRating: record.analystRating,
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
    snippet: page.snippet,
  };
}

function extractTickerFromHref(href = '') {
  try {
    const parsed = new URL(href, YAHOO_FINANCE_HOME_URL);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const quoteIndex = parts.indexOf('quote');
    if (quoteIndex === -1) return '';
    return cleanSymbol(parts[quoteIndex + 1] || '');
  } catch {
    return '';
  }
}

function findCompanyName($, anchor, href, symbol, rowText) {
  const siblingText = $(anchor).closest('tr,li,div').find(`a[href="${href}"]`).toArray()
    .map((link) => cleanText($(link).text()))
    .filter((text) => text && cleanSymbol(text) !== symbol);
  if (siblingText[0]) return siblingText[0];
  const tokens = cleanText(rowText).split(/\s{2,}| \| /).filter(Boolean);
  return tokens.find((token) => token.length > symbol.length + 2 && !/[-+]?\d/.test(token) && cleanSymbol(token) !== symbol) || '';
}

function nearestRecordText($, anchor, needle) {
  let current = $(anchor);
  for (let depth = 0; depth < 8; depth += 1) {
    current = current.parent();
    if (!current.length) break;
    const text = nodeText($, current);
    if (text.includes(needle) && text.length <= 2600 && (/%|\bVolume\b|\bMarket Cap\b|\bAvg Vol\b|\bPE\b|\d/.test(text))) {
      return text;
    }
  }
  return nodeText($, $(anchor).closest('tr'));
}

function extractMarketMetrics(text) {
  const normalized = cleanText(text).replace(/\u2212/g, '-');
  const percents = [...normalized.matchAll(/[-+]?\d+(?:\.\d+)?%/g)].map((match) => parseNumber(match[0]));
  const rating = firstMatch(normalized, /\b(strong buy|buy|outperform|hold|neutral|underperform|sell)\b/i);
  const abbreviatedNumbers = [...normalized.matchAll(/\b\d+(?:\.\d+)?\s*[KMBT]\b/g)].map((match) => cleanText(match[0]));
  return {
    changePct: firstFinite(percents),
    price: firstFinite([...normalized.matchAll(/\$?\b(\d+(?:,\d{3})*(?:\.\d+)?)\b/g)].map((match) => parsePriceLike(match[1]))),
    volumeRaw: abbreviatedNumbers[0] || '',
    marketCapRaw: abbreviatedNumbers.length > 1 ? abbreviatedNumbers.at(-1) : '',
    pe: firstFinite([...normalized.matchAll(/\bP\/?E\s*(?:Ratio)?\s*(\d+(?:\.\d+)?)/gi)].map((match) => parseNumber(match[1]))),
    analystRating: rating ? cleanText(rating).toLowerCase() : '',
  };
}

function extractCompanyPageSnippet(html) {
  const $ = cheerio.load(String(html || ''));
  $('script,style,noscript,svg').remove();
  return cleanText($('body').text()).slice(0, 1400);
}

function scoreScreenRecord(screen, changePct, metrics = {}) {
  const base = screen.stance === 'bearish' ? 36 : screen.stance === 'bullish' ? 64 : 54;
  const direction = screen.stance === 'bearish' ? -1 : 1;
  const move = Number.isFinite(changePct) ? Math.abs(changePct) : 0;
  const analystBoost = /strong buy|buy|outperform/i.test(metrics.analystRating || '') ? 6
    : /sell|underperform/i.test(metrics.analystRating || '') ? -6
      : 0;
  return clampScore(base + direction * Math.min(18, move * 0.48) + (Number(screen.weight) - 0.6) * 18 + analystBoost);
}

function companyPageUrl(symbol, path) {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(cleanSymbol(symbol))}/${path}/`;
}

function absolutize(href) {
  try {
    return new URL(href, YAHOO_FINANCE_HOME_URL).toString();
  } catch {
    return YAHOO_FINANCE_HOME_URL;
  }
}

function normalizeSymbolList(symbols) {
  return (Array.isArray(symbols) ? symbols : [])
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

function nodeText($, element) {
  return cleanText($.html(element).replace(/<[^>]+>/g, ' '));
}

function parseNumber(value) {
  const parsed = Number(String(value || '').replace(/[$,%]/g, '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePriceLike(value) {
  const parsed = parseNumber(value);
  return parsed > 0 && parsed < 100000 ? parsed : null;
}

function parseAbbreviatedNumber(value) {
  const match = String(value || '').replace(/\s+/g, '').replace(/,/g, '').match(/^([-+]?\d+(?:\.\d+)?)([KMBT])?$/i);
  if (!match) return null;
  const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 };
  return Number(match[1]) * (multipliers[match[2]?.toUpperCase()] || 1);
}

function firstMatch(text, pattern) {
  const match = String(text || '').match(pattern);
  return match?.[0] || '';
}

function firstFinite(values) {
  return values.find((value) => Number.isFinite(value)) ?? null;
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
  YAHOO_FINANCE_HOME_URL,
  YAHOO_SCREENER_HUB_URL,
  YAHOO_EQUITY_SCREENER_URL,
  YAHOO_ANALYST_RATINGS_URL,
  YAHOO_GAINERS_URL,
  YAHOO_LOSERS_URL,
  YAHOO_MOST_ACTIVE_URL,
  YAHOO_TRENDING_URL,
  YAHOO_SCREENS,
  COMPANY_PAGE_TYPES,
  collectYahooFinanceScreenerContext,
  parseMarketRows,
  evaluateYahooFinanceContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
