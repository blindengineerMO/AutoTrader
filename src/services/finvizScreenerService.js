const { resilientFetch } = require('../utils/resilientFetch');
const cheerio = require('cheerio');

const FINVIZ_HOME_URL = 'https://finviz.com/';
const FINVIZ_SCREENER_URL = 'https://finviz.com/screener';
const FINVIZ_SCREENER_LEGACY_URL = 'https://finviz.com/screener.ashx';

const FINVIZ_PRESETS = [
  { id: 'top-gainers', signal: 'ta_topgainers', label: 'Top Gainers', url: 'https://finviz.com/screener.ashx?v=111&s=ta_topgainers', stance: 'bullish', weight: 0.86 },
  { id: 'top-losers', signal: 'ta_toplosers', label: 'Top Losers', url: 'https://finviz.com/screener.ashx?v=111&s=ta_toplosers', stance: 'bearish', weight: 0.84 },
  { id: 'new-high', signal: 'ta_newhigh', label: 'New High', url: 'https://finviz.com/screener.ashx?v=111&s=ta_newhigh', stance: 'bullish', weight: 0.78 },
  { id: 'new-low', signal: 'ta_newlow', label: 'New Low', url: 'https://finviz.com/screener.ashx?v=111&s=ta_newlow', stance: 'bearish', weight: 0.8 },
  { id: 'most-active', signal: 'ta_mostactive', label: 'Most Active', url: 'https://finviz.com/screener.ashx?v=111&s=ta_mostactive', stance: 'neutral', weight: 0.56 },
  { id: 'unusual-volume', signal: 'ta_unusualvolume', label: 'Unusual Volume', url: 'https://finviz.com/screener.ashx?v=111&s=ta_unusualvolume', stance: 'attention', weight: 0.62 },
  { id: 'analyst-upgrades', signal: 'n_upgrades', label: 'Analyst Upgrades', url: 'https://finviz.com/screener.ashx?v=111&s=n_upgrades', stance: 'bullish', weight: 0.72 },
  { id: 'analyst-downgrades', signal: 'n_downgrades', label: 'Analyst Downgrades', url: 'https://finviz.com/screener.ashx?v=111&s=n_downgrades', stance: 'bearish', weight: 0.72 },
  { id: 'insider-latest-buys', signal: 'it_latestbuys', label: 'Latest Insider Buys', url: 'https://finviz.com/screener.ashx?v=111&s=it_latestbuys', stance: 'bullish', weight: 0.7 },
];

const FINVIZ_FUNDAMENTAL_SCREEN = {
  id: 'quality-growth-value',
  label: 'Quality/Growth Fundamental Screen',
  url: 'https://finviz.com/screener.ashx?v=111&f=cap_midover,fa_debteq_u1,fa_roe_o15,fa_sales5years_pos,sh_avgv',
  stance: 'bullish',
  weight: 0.74,
  filters: ['cap_midover', 'fa_debteq_u1', 'fa_roe_o15', 'fa_sales5years_pos', 'sh_avgv'],
};

async function collectFinvizScreenerContext({
  timeoutMs = 8000,
  limit = 12,
  presetIds,
  includeFundamental = true,
  onEvent = () => {},
} = {}) {
  const selectedPresetIds = new Set((Array.isArray(presetIds) ? presetIds : []).filter(Boolean));
  const presets = selectedPresetIds.size
    ? FINVIZ_PRESETS.filter((preset) => selectedPresetIds.has(preset.id) || selectedPresetIds.has(preset.signal))
    : FINVIZ_PRESETS;
  const screens = [
    ...presets,
    ...(includeFundamental ? [FINVIZ_FUNDAMENTAL_SCREEN] : []),
  ];
  const boundedLimit = clampInt(limit, 1, 50);

  const settled = await Promise.allSettled(screens.map(async (screen) => {
    const html = await fetchHtml(screen.url, timeoutMs);
    const rows = parseScreenerRows(html, screen).slice(0, boundedLimit);
    emit(onEvent, 'finviz-screener', 34, 'debug', 'Fetched FINVIZ screener page.', {
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
      emit(onEvent, 'finviz-screener', 34, 'warn', 'FINVIZ screener page unavailable; continuing with remaining screens.', {
        screen: screen.id,
        url: screen.url,
        error: result.reason.message,
      });
    }
  });

  return evaluateFinvizContext({ screenResults, failures });
}

function parseScreenerRows(html, screen = {}) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();

  $('tr').each((_, row) => {
    const $row = $(row);
    const quoteLink = $row.find('a[href*="quote"]').toArray()
      .map((link) => ({
        text: cleanText($(link).text()),
        href: $(link).attr('href') || '',
      }))
      .find((link) => extractTickerFromHref(link.href) || isTicker(link.text));
    const symbol = cleanSymbol(extractTickerFromHref(quoteLink?.href) || quoteLink?.text);
    if (!symbol || seen.has(`${screen.id}:${symbol}`)) return;

    const cells = $row.find('td,th').toArray().map((cell) => cleanText($(cell).text())).filter(Boolean);
    const normalized = normalizeScreenerRecord({ screen, symbol, cells, href: quoteLink?.href });
    if (!normalized) return;
    rows.push(normalized);
    seen.add(`${screen.id}:${symbol}`);
  });

  return rows;
}

function normalizeScreenerRecord({ screen, symbol, cells, href }) {
  const tickerIndex = cells.findIndex((cell) => cleanSymbol(cell) === symbol);
  const values = tickerIndex >= 0 ? cells.slice(tickerIndex) : cells;
  const changeIndex = values.findIndex((cell) => /^[-+]?\d+(?:\.\d+)?%$/.test(cell));
  const price = changeIndex > 0 ? parseNumber(values[changeIndex - 1]) : firstFinite(values.map(parsePriceLike));
  const changePct = changeIndex >= 0 ? parseNumber(values[changeIndex]) : null;
  const volumeRaw = values.slice(Math.max(changeIndex + 1, 0)).find((cell) => /^[\d,.]+[KMB]?$/i.test(cell));
  const companyName = values[1] && !isTicker(values[1]) ? values[1] : '';
  const sector = values[2] && !/^[\d,.%+-]+[KMB]?$/.test(values[2]) ? values[2] : '';
  const industry = values[3] && !/^[\d,.%+-]+[KMB]?$/.test(values[3]) ? values[3] : '';
  const marketCapRaw = values.find((cell) => /^[\d,.]+[KMBT]$/i.test(cell));
  const pe = firstFinite(values.map((cell) => {
    const parsed = parseNumber(cell);
    return parsed > 0 && parsed < 500 ? parsed : null;
  }));
  const score = scoreScreenRecord(screen, changePct);

  return {
    symbol,
    companyName,
    sector,
    industry,
    price,
    changePct,
    volumeRaw: volumeRaw || '',
    volume: parseAbbreviatedNumber(volumeRaw),
    marketCapRaw: marketCapRaw || '',
    pe,
    screenId: screen.id,
    signal: screen.label,
    signalCode: screen.signal || '',
    stance: screen.stance,
    signalScore: score,
    quoteUrl: absolutize(href || `/quote.ashx?t=${symbol}`),
    sourceUrl: screen.url,
    reason: `${screen.label} FINVIZ screen ${screen.stance || 'neutral'} signal${Number.isFinite(changePct) ? ` with ${changePct}% move` : ''}.`,
  };
}

function evaluateFinvizContext({ screenResults = [], failures = [] } = {}) {
  const records = screenResults.flatMap((result) => result.rows || []);
  const bullish = records.filter((item) => ['bullish', 'attention'].includes(item.stance));
  const bearish = records.filter((item) => item.stance === 'bearish');
  const fundamentalCandidates = records.filter((item) => item.screenId === FINVIZ_FUNDAMENTAL_SCREEN.id);
  const uniqueSymbols = [...new Set(records.map((item) => item.symbol))];
  const averageBullishScore = average(bullish.map((item) => item.signalScore));
  const averageBearishScore = average(bearish.map((item) => 100 - item.signalScore));
  const breadthScore = clampScore(50 + uniqueSymbols.length * 1.1 + (bullish.length - bearish.length) * 1.3);
  const opportunityScore = clampScore(50 + (averageBullishScore - 50) * 0.45 + fundamentalCandidates.length * 1.6 + breadthScore * 0.15 - 8);
  const riskScore = clampScore(50 + (averageBearishScore - 50) * 0.55 + bearish.length * 1.2 - bullish.length * 0.45);
  const momentum = opportunityScore >= 62 ? 'screener-risk-on'
    : riskScore >= 62 ? 'screener-risk-off'
      : 'screener-mixed';

  return {
    available: records.length > 0,
    fetchedAt: new Date().toISOString(),
    provider: 'finviz',
    quoteDelayNote: 'FINVIZ public pages may include delayed quotes and scraped HTML; verify with broker/Finnhub/SEC/news before trading.',
    sourceList: sourceList(),
    failures,
    screenCount: screenResults.length,
    signalCount: records.length,
    uniqueSymbolCount: uniqueSymbols.length,
    bullishCount: bullish.length,
    bearishCount: bearish.length,
    fundamentalCount: fundamentalCandidates.length,
    opportunityScore,
    riskScore,
    breadthScore,
    momentum,
    records,
    topBullish: bullish.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    topBearish: bearish.sort((a, b) => a.signalScore - b.signalScore).slice(0, 12),
    fundamentalCandidates: fundamentalCandidates.slice(0, 12),
    narrative: records.length
      ? `FINVIZ screener ${momentum}: ${bullish.length} bullish/attention signals, ${bearish.length} bearish signals, ${fundamentalCandidates.length} quality-growth candidates. Opportunity ${opportunityScore}, risk ${riskScore}.`
      : 'FINVIZ screener context unavailable; scraped pages may be blocked or temporarily changed.',
  };
}

function scoreCandidate({ candidate, finvizContext }) {
  if (!finvizContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, signals: [], explanation: 'FINVIZ screener context unavailable.' };
  }
  const symbol = cleanSymbol(candidate?.symbol);
  const signals = (finvizContext.records || []).filter((item) => item.symbol === symbol);
  if (!signals.length) {
    return {
      normalized: 0.5,
      compositeScore: 50,
      exposure: 10,
      signals: [],
      explanation: `${symbol || 'Candidate'} did not appear in current FINVIZ preset/fundamental screens.`,
    };
  }
  const bullishSignals = signals.filter((item) => ['bullish', 'attention'].includes(item.stance));
  const bearishSignals = signals.filter((item) => item.stance === 'bearish');
  const signalAverage = average(signals.map((item) => item.signalScore));
  const exposure = clamp01(0.38 + signals.length * 0.14 + (signals.some((item) => item.screenId === FINVIZ_FUNDAMENTAL_SCREEN.id) ? 0.18 : 0));
  const raw = 0.5 + ((signalAverage - 50) / 100) * exposure + (bullishSignals.length - bearishSignals.length) * 0.035;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    signals: signals.slice(0, 8),
    explanation: `FINVIZ signals for ${symbol}: ${signals.map((item) => item.signal).join(', ')}. Bullish/attention ${bullishSignals.length}, bearish ${bearishSignals.length}; verify delayed scraped screener output before live orders.`,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'finviz',
    fetchedAt: context.fetchedAt,
    momentum: context.momentum,
    opportunityScore: context.opportunityScore,
    riskScore: context.riskScore,
    signalCount: context.signalCount || 0,
    bullishCount: context.bullishCount || 0,
    bearishCount: context.bearishCount || 0,
    topBullish: (context.topBullish || []).slice(0, 8).map(compactRecord),
    topBearish: (context.topBearish || []).slice(0, 8).map(compactRecord),
    fundamentalCandidates: (context.fundamentalCandidates || []).slice(0, 8).map(compactRecord),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.quoteDelayNote || 'Scraped FINVIZ screener data should be verified with primary market and filing sources before trading.',
    bmclUse: 'Use as scraped/delayed stock-screener discovery and self-improvement evidence. Share compact ticker/signal rows, then corroborate with broker quotes, Finnhub/company research, SEC filings, GDELT/Google News, and official sources before scoring live trades.',
  };
}

async function fetchHtml(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/html,application/xhtml+xml,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader FINVIZ research bot; contact=local',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers, redirect: 'follow' }, { bucket: 'finviz', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return [
    { name: 'FINVIZ main site', type: 'finviz-main', url: FINVIZ_HOME_URL },
    { name: 'FINVIZ screener', type: 'finviz-screener', url: FINVIZ_SCREENER_LEGACY_URL },
    { name: 'FINVIZ screener alternative', type: 'finviz-screener', url: FINVIZ_SCREENER_URL },
    ...FINVIZ_PRESETS.map((screen) => ({ name: `FINVIZ ${screen.label}`, type: 'finviz-preset-screener', url: screen.url, signal: screen.signal })),
    { name: 'FINVIZ quality/growth fundamental screen', type: 'finviz-fundamental-screener', url: FINVIZ_FUNDAMENTAL_SCREEN.url, filters: FINVIZ_FUNDAMENTAL_SCREEN.filters },
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
    sourceUrl: record.sourceUrl,
  };
}

function scoreScreenRecord(screen, changePct) {
  const base = screen.stance === 'bearish' ? 36 : screen.stance === 'bullish' ? 64 : 54;
  const direction = screen.stance === 'bearish' ? -1 : 1;
  const move = Number.isFinite(changePct) ? Math.abs(changePct) : 0;
  return clampScore(base + direction * Math.min(16, move * 0.55) + (screen.weight - 0.6) * 20);
}

function extractTickerFromHref(href = '') {
  try {
    const parsed = new URL(href, FINVIZ_HOME_URL);
    return parsed.searchParams.get('t') || parsed.pathname.split('/').pop();
  } catch {
    const match = String(href || '').match(/[?&]t=([A-Za-z0-9.-]+)/);
    return match?.[1] || '';
  }
}

function absolutize(href) {
  try {
    return new URL(href, FINVIZ_HOME_URL).toString();
  } catch {
    return FINVIZ_HOME_URL;
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

function parseNumber(value) {
  const parsed = Number(String(value || '').replace(/[$,%]/g, '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePriceLike(value) {
  if (!/^\$?\d+(?:,\d{3})*(?:\.\d+)?$/.test(String(value || ''))) return null;
  return parseNumber(value);
}

function parseAbbreviatedNumber(value) {
  const match = String(value || '').replace(/,/g, '').match(/^([-+]?\d+(?:\.\d+)?)([KMBT])?$/i);
  if (!match) return null;
  const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 };
  return Number(match[1]) * (multipliers[match[2]?.toUpperCase()] || 1);
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
  FINVIZ_HOME_URL,
  FINVIZ_SCREENER_URL,
  FINVIZ_SCREENER_LEGACY_URL,
  FINVIZ_PRESETS,
  FINVIZ_FUNDAMENTAL_SCREEN,
  collectFinvizScreenerContext,
  parseScreenerRows,
  evaluateFinvizContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
