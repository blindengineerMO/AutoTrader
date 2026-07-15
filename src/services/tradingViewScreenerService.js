const { resilientFetch } = require('../utils/resilientFetch');
const cheerio = require('cheerio');

const TRADINGVIEW_HOME_URL = 'https://www.tradingview.com/';
const TRADINGVIEW_SCREENER_URL = 'https://www.tradingview.com/screener/';
const TRADINGVIEW_US_MARKET_URL = 'https://www.tradingview.com/markets/stocks-usa/';
const TRADINGVIEW_US_SECTORS_URL = 'https://www.tradingview.com/markets/stocks-usa/sectorandindustry-sector/';
const TRADINGVIEW_PREMARKET_GAINERS_URL = 'https://www.tradingview.com/markets/stocks-usa/market-movers-pre-market-gainers/';
const TRADINGVIEW_ALL_TIME_HIGHS_URL = 'https://www.tradingview.com/markets/stocks-usa/market-movers-ath/';

const TRADINGVIEW_SCREENS = [
  {
    id: 'us-market-overview',
    label: 'U.S. Stock Market Overview',
    url: TRADINGVIEW_US_MARKET_URL,
    stance: 'attention',
    weight: 0.58,
    category: 'market-overview',
  },
  {
    id: 'pre-market-gainers',
    label: 'Pre-market Gainers',
    url: TRADINGVIEW_PREMARKET_GAINERS_URL,
    stance: 'bullish',
    weight: 0.82,
    category: 'pre-market-momentum',
  },
  {
    id: 'all-time-highs',
    label: 'All-time Highs',
    url: TRADINGVIEW_ALL_TIME_HIGHS_URL,
    stance: 'bullish',
    weight: 0.78,
    category: 'relative-strength',
  },
];

async function collectTradingViewScreenerContext({
  timeoutMs = 8000,
  limit = 12,
  screenIds,
  includeSectors = true,
  onEvent = () => {},
} = {}) {
  const selectedIds = new Set((Array.isArray(screenIds) ? screenIds : []).filter(Boolean));
  const screens = selectedIds.size
    ? TRADINGVIEW_SCREENS.filter((screen) => selectedIds.has(screen.id))
    : TRADINGVIEW_SCREENS;
  const boundedLimit = clampInt(limit, 1, 50);
  const settled = await Promise.allSettled(screens.map(async (screen) => {
    const html = await fetchHtml(screen.url, timeoutMs);
    const rows = parseMarketRows(html, screen).slice(0, boundedLimit);
    emit(onEvent, 'tradingview-screener', 35, 'debug', 'Fetched TradingView market page.', {
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
      emit(onEvent, 'tradingview-screener', 35, 'warn', 'TradingView market page unavailable; continuing with remaining screens.', {
        screen: screen.id,
        url: screen.url,
        error: result.reason.message,
      });
    }
  });

  let sectors = [];
  if (includeSectors) {
    try {
      const sectorHtml = await fetchHtml(TRADINGVIEW_US_SECTORS_URL, timeoutMs);
      sectors = parseSectorRows(sectorHtml).slice(0, boundedLimit);
      emit(onEvent, 'tradingview-screener', 35, 'debug', 'Fetched TradingView U.S. sector page.', {
        sectors: sectors.length,
        url: TRADINGVIEW_US_SECTORS_URL,
      });
    } catch (err) {
      failures.push({ screen: 'us-sector-leadership', url: TRADINGVIEW_US_SECTORS_URL, error: err.message });
      emit(onEvent, 'tradingview-screener', 35, 'warn', 'TradingView U.S. sector page unavailable; continuing without sector leadership.', {
        url: TRADINGVIEW_US_SECTORS_URL,
        error: err.message,
      });
    }
  }

  return evaluateTradingViewContext({ screenResults, sectors, failures });
}

function parseMarketRows(html, screen = {}) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();
  $('a[href*="/symbols/"]').each((_, anchor) => {
    const href = $(anchor).attr('href') || '';
    const parsed = extractSymbolFromHref(href);
    const symbol = cleanSymbol(parsed.symbol);
    if (!symbol || !parsed.exchange || !isUsEquityExchange(parsed.exchange) || seen.has(`${screen.id}:${symbol}`)) return;
    const rowText = nearestRecordText($, anchor, symbol);
    const companyName = findCompanyName($, anchor, href, symbol);
    const metrics = extractMarketMetrics(rowText);
    rows.push({
      symbol,
      exchange: parsed.exchange,
      companyName,
      price: metrics.price,
      changePct: metrics.changePct,
      preMarketChangePct: screen.id === 'pre-market-gainers' ? metrics.changePct : null,
      volumeRaw: metrics.volumeRaw,
      volume: parseAbbreviatedNumber(metrics.volumeRaw),
      marketCapRaw: metrics.marketCapRaw,
      sector: metrics.sector,
      screenId: screen.id,
      signal: screen.label,
      stance: screen.stance,
      signalScore: scoreScreenRecord(screen, metrics.changePct),
      quoteUrl: absolutize(href),
      sourceUrl: screen.url,
      rowText: rowText.slice(0, 600),
      reason: `${screen.label} TradingView ${screen.category || 'market'} signal${Number.isFinite(metrics.changePct) ? ` with ${metrics.changePct}% visible move` : ''}.`,
    });
    seen.add(`${screen.id}:${symbol}`);
  });
  return rows;
}

function parseSectorRows(html) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();
  $('a[href*="/markets/stocks-usa/sectorandindustry-sector/"]').each((_, anchor) => {
    const href = $(anchor).attr('href') || '';
    const name = cleanText($(anchor).text());
    const slug = href.split('/sectorandindustry-sector/')[1]?.split('/')[0] || '';
    if (!slug || !name || name.toLowerCase() === 'sectors' || seen.has(slug)) return;
    const rowText = nearestRecordText($, anchor, name);
    const metrics = extractSectorMetrics(rowText);
    rows.push({
      id: slug,
      name,
      marketCapRaw: metrics.marketCapRaw,
      dividendYieldPct: metrics.dividendYieldPct,
      changePct: metrics.changePct,
      volumeRaw: metrics.volumeRaw,
      industries: metrics.industries,
      stocks: metrics.stocks,
      signalScore: scoreSectorRecord(metrics),
      sourceUrl: TRADINGVIEW_US_SECTORS_URL,
      sectorUrl: absolutize(href),
      rowText: rowText.slice(0, 600),
      reason: `TradingView U.S. sector row for ${name}${Number.isFinite(metrics.changePct) ? ` shows ${metrics.changePct}% visible performance` : ''}.`,
    });
    seen.add(slug);
  });
  return rows.sort((a, b) => b.signalScore - a.signalScore);
}

function evaluateTradingViewContext({ screenResults = [], sectors = [], failures = [] } = {}) {
  const records = screenResults.flatMap((result) => result.rows || []);
  const momentumRecords = records.filter((item) => ['bullish', 'attention'].includes(item.stance));
  const preMarket = records.filter((item) => item.screenId === 'pre-market-gainers');
  const allTimeHighs = records.filter((item) => item.screenId === 'all-time-highs');
  const uniqueSymbols = [...new Set(records.map((item) => item.symbol))];
  const preMarketMomentumScore = clampScore(average(preMarket.map((item) => item.signalScore)));
  const allTimeHighScore = clampScore(average(allTimeHighs.map((item) => item.signalScore)));
  const sectorLeadershipScore = clampScore(average(sectors.slice(0, 8).map((item) => item.signalScore)));
  const breadthScore = clampScore(48 + uniqueSymbols.length * 1.15 + momentumRecords.length * 0.6);
  const opportunityScore = clampScore(44 + (preMarketMomentumScore - 50) * 0.34 + (allTimeHighScore - 50) * 0.3 + (sectorLeadershipScore - 50) * 0.22 + breadthScore * 0.16);
  const riskScore = clampScore(58 - (opportunityScore - 50) * 0.36 + failures.length * 2);
  const momentum = opportunityScore >= 64 ? 'tradingview-risk-on'
    : sectorLeadershipScore >= 62 ? 'sector-led-momentum'
      : 'tradingview-mixed';

  return {
    available: records.length > 0 || sectors.length > 0,
    fetchedAt: new Date().toISOString(),
    provider: 'tradingview',
    quoteDelayNote: 'TradingView public pages can include delayed quotes and scraped HTML; verify with broker/Finnhub/SEC/news before trading.',
    sourceList: sourceList(),
    failures,
    screenCount: screenResults.length,
    signalCount: records.length,
    uniqueSymbolCount: uniqueSymbols.length,
    preMarketCount: preMarket.length,
    allTimeHighCount: allTimeHighs.length,
    sectorCount: sectors.length,
    opportunityScore,
    riskScore,
    breadthScore,
    preMarketMomentumScore,
    allTimeHighScore,
    sectorLeadershipScore,
    momentum,
    records,
    topMomentum: momentumRecords.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    topPreMarketGainers: preMarket.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    allTimeHighs: allTimeHighs.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    sectorLeaders: sectors.slice(0, 12),
    narrative: records.length || sectors.length
      ? `TradingView ${momentum}: ${records.length} visible screener/mover rows, ${preMarket.length} pre-market gainers, ${allTimeHighs.length} all-time-high rows, ${sectors.length} sector rows. Opportunity ${opportunityScore}, risk ${riskScore}.`
      : 'TradingView screener context unavailable; public pages may be blocked, throttled, or changed.',
  };
}

function scoreCandidate({ candidate, tradingViewContext }) {
  if (!tradingViewContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, signals: [], sectorSignals: [], explanation: 'TradingView screener context unavailable.' };
  }
  const symbol = cleanSymbol(candidate?.symbol);
  const signals = (tradingViewContext.records || []).filter((item) => item.symbol === symbol);
  const sectorSignals = findSectorSignals(candidate, tradingViewContext).slice(0, 3);
  if (!signals.length && !sectorSignals.length) {
    return {
      normalized: 0.5,
      compositeScore: 50,
      exposure: 10,
      signals: [],
      sectorSignals: [],
      explanation: `${symbol || 'Candidate'} did not appear in current TradingView mover/relative-strength rows or sector-leadership matches.`,
    };
  }
  const signalAverage = average(signals.map((item) => item.signalScore));
  const sectorAverage = average(sectorSignals.map((item) => item.signalScore));
  const exposure = clamp01((signals.length ? 0.34 + signals.length * 0.16 : 0.12) + sectorSignals.length * 0.07);
  const raw = 0.5
    + (signals.length ? ((signalAverage - 50) / 100) * exposure : 0)
    + (sectorSignals.length ? ((sectorAverage - 50) / 100) * 0.18 : 0)
    + signals.filter((item) => item.screenId === 'pre-market-gainers').length * 0.035
    + signals.filter((item) => item.screenId === 'all-time-highs').length * 0.03;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    signals: signals.slice(0, 8),
    sectorSignals,
    explanation: `TradingView signals for ${symbol || candidate?.companyName || 'candidate'}: ${signals.map((item) => item.signal).join(', ') || 'no direct ticker row'}${sectorSignals.length ? `; sector leaders ${sectorSignals.map((item) => item.name).join(', ')}` : ''}. Verify scraped/delayed TradingView output before live orders.`,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'tradingview',
    fetchedAt: context.fetchedAt,
    momentum: context.momentum,
    opportunityScore: context.opportunityScore,
    riskScore: context.riskScore,
    signalCount: context.signalCount || 0,
    preMarketCount: context.preMarketCount || 0,
    allTimeHighCount: context.allTimeHighCount || 0,
    sectorCount: context.sectorCount || 0,
    topMomentum: (context.topMomentum || []).slice(0, 8).map(compactRecord),
    topPreMarketGainers: (context.topPreMarketGainers || []).slice(0, 8).map(compactRecord),
    allTimeHighs: (context.allTimeHighs || []).slice(0, 8).map(compactRecord),
    sectorLeaders: (context.sectorLeaders || []).slice(0, 8).map(compactSector),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.quoteDelayNote || 'Scraped TradingView screener data should be verified with primary market and filing sources before trading.',
    bmclUse: 'Use as scraped/delayed TradingView market-screener discovery and self-improvement evidence. Share compact ticker/signal/sector rows for momentum, relative strength, sector leadership, volume anomalies, and pre-market movement, then corroborate with broker quotes, Finnhub/company research, SEC filings, GDELT/Google News, and official sources before scoring live trades.',
  };
}

async function fetchHtml(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/html,application/xhtml+xml,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader TradingView research bot; contact=local',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers, redirect: 'follow' }, { bucket: 'tradingview', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return [
    { name: 'TradingView stock screener', type: 'tradingview-stock-screener', url: TRADINGVIEW_SCREENER_URL },
    { name: 'TradingView U.S. stock market', type: 'tradingview-us-market', url: TRADINGVIEW_US_MARKET_URL },
    { name: 'TradingView U.S. sectors', type: 'tradingview-us-sectors', url: TRADINGVIEW_US_SECTORS_URL },
    ...TRADINGVIEW_SCREENS.map((screen) => ({ name: `TradingView ${screen.label}`, type: `tradingview-${screen.category}`, url: screen.url, screenId: screen.id })),
  ];
}

function compactRecord(record) {
  return {
    symbol: record.symbol,
    exchange: record.exchange,
    companyName: record.companyName,
    signal: record.signal,
    stance: record.stance,
    signalScore: record.signalScore,
    price: record.price,
    changePct: record.changePct,
    volumeRaw: record.volumeRaw,
    marketCapRaw: record.marketCapRaw,
    sourceUrl: record.sourceUrl,
  };
}

function compactSector(sector) {
  return {
    id: sector.id,
    name: sector.name,
    signalScore: sector.signalScore,
    changePct: sector.changePct,
    marketCapRaw: sector.marketCapRaw,
    dividendYieldPct: sector.dividendYieldPct,
    volumeRaw: sector.volumeRaw,
    stocks: sector.stocks,
    sourceUrl: sector.sourceUrl,
  };
}

function extractSymbolFromHref(href = '') {
  try {
    const parsed = new URL(href, TRADINGVIEW_HOME_URL);
    const match = parsed.pathname.match(/\/symbols\/([^/]+)\//);
    if (!match) return { exchange: '', symbol: '' };
    const [exchange, ...symbolParts] = match[1].split('-');
    return { exchange: cleanText(exchange).toUpperCase(), symbol: cleanSymbol(symbolParts.join('-')) };
  } catch {
    return { exchange: '', symbol: '' };
  }
}

function findCompanyName($, anchor, href, symbol) {
  const siblings = $(anchor).closest('tr,div,li').find(`a[href="${href}"]`).toArray()
    .map((link) => cleanText($(link).text()))
    .filter((text) => text && cleanSymbol(text) !== symbol);
  return siblings[0] || '';
}

function nearestRecordText($, anchor, needle) {
  let current = $(anchor);
  for (let depth = 0; depth < 7; depth += 1) {
    current = current.parent();
    if (!current.length) break;
    const text = nodeText($, current);
    if (text.includes(needle) && text.length <= 2200 && (/%|\bUSD\b|\bVol\b|\bMkt cap\b|\bSector\b|\d/.test(text))) {
      return text;
    }
  }
  return nodeText($, $(anchor).closest('tr'));
}

function extractMarketMetrics(text) {
  const normalized = cleanText(text).replace(/\u2212/g, '-');
  const percents = [...normalized.matchAll(/[-+]?\d+(?:\.\d+)?%/g)].map((match) => parseNumber(match[0]));
  return {
    changePct: firstFinite(percents),
    price: firstFinite([...normalized.matchAll(/\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*USD\b/g)].map((match) => parseNumber(match[1]))),
    volumeRaw: firstMatch(normalized, /\b\d+(?:\.\d+)?\s*[KMB]\b(?!\s*USD)/i),
    marketCapRaw: firstMatch(normalized, /\b\d+(?:\.\d+)?\s*[KMBT]\s*USD\b/i),
    sector: firstMatch(normalized, /\b(Electronic Technology|Technology Services|Finance|Health Technology|Retail Trade|Consumer Services|Energy Minerals|Utilities|Transportation|Producer Manufacturing|Consumer Non-Durables|Consumer Durables|Commercial Services|Process Industries|Communications|Distribution Services|Industrial Services|Non-Energy Minerals)\b/i),
  };
}

function extractSectorMetrics(text) {
  const normalized = cleanText(text).replace(/\u2212/g, '-');
  const percents = [...normalized.matchAll(/[-+]?\d+(?:\.\d+)?%/g)].map((match) => parseNumber(match[0]));
  const integers = [...normalized.matchAll(/\b\d{1,4}\b/g)].map((match) => Number(match[0])).filter(Number.isFinite);
  return {
    marketCapRaw: firstMatch(normalized, /\b\d+(?:\.\d+)?\s*[KMBT]\s*USD\b/i),
    dividendYieldPct: firstFinite(percents),
    changePct: percents.length > 1 ? percents[1] : firstFinite(percents),
    volumeRaw: firstMatch(normalized, /\b\d+(?:\.\d+)?\s*[KMB]\b(?!\s*USD)/i),
    industries: integers.at(-2) || null,
    stocks: integers.at(-1) || null,
  };
}

function scoreScreenRecord(screen, changePct) {
  const base = screen.stance === 'bearish' ? 36 : screen.stance === 'bullish' ? 64 : 54;
  const direction = screen.stance === 'bearish' ? -1 : 1;
  const move = Number.isFinite(changePct) ? Math.abs(changePct) : 0;
  return clampScore(base + direction * Math.min(18, move * 0.5) + (Number(screen.weight) - 0.6) * 18);
}

function scoreSectorRecord(metrics = {}) {
  const changeBoost = Number.isFinite(metrics.changePct) ? clamp(metrics.changePct * 4, -14, 18) : 0;
  const stockBreadth = Number.isFinite(metrics.stocks) ? Math.min(8, Math.log10(metrics.stocks + 1) * 3) : 0;
  return clampScore(52 + changeBoost + stockBreadth);
}

function findSectorSignals(candidate, context) {
  const haystack = cleanText(`${candidate?.theme || ''} ${candidate?.companyName || ''} ${candidate?.discovery?.tags?.join(' ') || ''}`).toLowerCase();
  if (!haystack) return [];
  return (context.sectorLeaders || []).filter((sector) => {
    const normalized = sector.name.toLowerCase();
    return normalized.split(/\s+/).some((part) => part.length > 4 && haystack.includes(part));
  });
}

function isUsEquityExchange(exchange) {
  return ['NASDAQ', 'NYSE', 'AMEX', 'OTC'].includes(cleanText(exchange).toUpperCase());
}

function absolutize(href) {
  try {
    return new URL(href, TRADINGVIEW_HOME_URL).toString();
  } catch {
    return TRADINGVIEW_HOME_URL;
  }
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
  TRADINGVIEW_HOME_URL,
  TRADINGVIEW_SCREENER_URL,
  TRADINGVIEW_US_MARKET_URL,
  TRADINGVIEW_US_SECTORS_URL,
  TRADINGVIEW_PREMARKET_GAINERS_URL,
  TRADINGVIEW_ALL_TIME_HIGHS_URL,
  TRADINGVIEW_SCREENS,
  collectTradingViewScreenerContext,
  parseMarketRows,
  parseSectorRows,
  evaluateTradingViewContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
