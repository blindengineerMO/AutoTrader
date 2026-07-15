const { resilientFetch } = require('../utils/resilientFetch');
const cheerio = require('cheerio');

const MARKETBEAT_HOME_URL = 'https://www.marketbeat.com/';
const MARKETBEAT_RATINGS_URL = 'https://www.marketbeat.com/ratings/';
const MARKETBEAT_UPGRADES_URL = 'https://www.marketbeat.com/ratings/upgrades/';
const MARKETBEAT_DOWNGRADES_URL = 'https://www.marketbeat.com/ratings/downgrades/';
const MARKETBEAT_PRICE_TARGET_CHANGES_URL = 'https://www.marketbeat.com/ratings/price-target-changes/';

const MARKETBEAT_SCREENS = [
  {
    id: 'analyst-ratings',
    label: 'Analyst Ratings',
    url: MARKETBEAT_RATINGS_URL,
    stance: 'attention',
    weight: 0.64,
    category: 'analyst-ratings',
  },
  {
    id: 'upgrades',
    label: 'Analyst Upgrades',
    url: MARKETBEAT_UPGRADES_URL,
    stance: 'bullish',
    weight: 0.78,
    category: 'broker-upgrades',
  },
  {
    id: 'downgrades',
    label: 'Analyst Downgrades',
    url: MARKETBEAT_DOWNGRADES_URL,
    stance: 'bearish',
    weight: 0.78,
    category: 'broker-downgrades',
  },
  {
    id: 'price-target-changes',
    label: 'Price Target Changes',
    url: MARKETBEAT_PRICE_TARGET_CHANGES_URL,
    stance: 'attention',
    weight: 0.7,
    category: 'price-target-changes',
  },
];

async function collectMarketBeatAnalystContext({
  timeoutMs = 8000,
  limit = 12,
  screenIds,
  includeConsensusPages = false,
  companySymbols = [],
  onEvent = () => {},
} = {}) {
  const selectedIds = new Set((Array.isArray(screenIds) ? screenIds : []).filter(Boolean));
  const screens = selectedIds.size
    ? MARKETBEAT_SCREENS.filter((screen) => selectedIds.has(screen.id))
    : MARKETBEAT_SCREENS;
  const boundedLimit = clampInt(limit, 1, 50);

  const settled = await Promise.allSettled(screens.map(async (screen) => {
    const html = await fetchHtml(screen.url, timeoutMs);
    const rows = parseAnalystRows(html, screen).slice(0, boundedLimit);
    emit(onEvent, 'marketbeat-analyst-research', 38, 'debug', 'Fetched MarketBeat analyst research page.', {
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
      emit(onEvent, 'marketbeat-analyst-research', 38, 'warn', 'MarketBeat analyst page unavailable; continuing with remaining screens.', {
        screen: screen.id,
        url: screen.url,
        error: result.reason.message,
      });
    }
  });

  let consensusPages = [];
  if (includeConsensusPages) {
    const symbols = [...new Set([
      ...normalizeSymbolList(companySymbols),
      ...screenResults.flatMap((result) => (result.rows || []).map((row) => row.symbol)),
    ])].slice(0, Math.min(boundedLimit, 12));
    consensusPages = await collectConsensusPages({ symbols, timeoutMs, onEvent, failures });
  }

  return evaluateMarketBeatContext({ screenResults, consensusPages, failures });
}

function parseAnalystRows(html, screen = {}) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();

  $('a[href*="/stocks/"][href*="/forecast"]').each((_, anchor) => {
    const href = $(anchor).attr('href') || '';
    const parsed = extractStockFromHref(href);
    const symbol = cleanSymbol(parsed.symbol || $(anchor).text());
    if (!symbol || seen.has(`${screen.id}:${symbol}:${rows.length}`)) return;
    const rowText = nearestRecordText($, anchor, symbol);
    const fields = extractAnalystFields(rowText, screen);
    rows.push({
      symbol,
      exchange: parsed.exchange,
      companyName: findCompanyName($, anchor, href, symbol, rowText),
      analystFirm: fields.analystFirm,
      action: fields.action,
      previousRating: fields.previousRating,
      newRating: fields.newRating,
      previousTarget: fields.previousTarget,
      newTarget: fields.newTarget,
      publishedAt: fields.publishedAt,
      screenId: screen.id,
      signal: screen.label,
      category: screen.category,
      stance: fields.stance || screen.stance,
      signalScore: scoreAnalystRecord(screen, fields),
      quoteUrl: absolutize(href),
      sourceUrl: screen.url,
      rowText: rowText.slice(0, 800),
      reason: `${screen.label} MarketBeat broker-action signal${fields.analystFirm ? ` from ${fields.analystFirm}` : ''}${fields.action ? ` (${fields.action})` : ''}.`,
    });
    seen.add(`${screen.id}:${symbol}:${rows.length}`);
  });

  return rows;
}

function evaluateMarketBeatContext({ screenResults = [], consensusPages = [], failures = [] } = {}) {
  const records = screenResults.flatMap((result) => result.rows || []);
  const bullish = records.filter((item) => item.stance === 'bullish');
  const bearish = records.filter((item) => item.stance === 'bearish');
  const targetChanges = records.filter((item) => item.screenId === 'price-target-changes' || Number.isFinite(item.newTarget));
  const consensus = consensusPages.filter((item) => item.snippet);
  const uniqueSymbols = [...new Set(records.map((item) => item.symbol))];
  const actionScore = average(records.map((item) => item.signalScore));
  const targetScore = average(targetChanges.map((item) => targetDeltaScore(item)));
  const consensusScore = clampScore(50 + consensus.length * 2.4);
  const opportunityScore = clampScore(47 + (actionScore - 50) * 0.38 + (targetScore - 50) * 0.24 + bullish.length * 1.1 + consensus.length * 0.6);
  const riskScore = clampScore(48 + bearish.length * 2.4 + failures.length * 2 - bullish.length * 0.65 - (targetScore - 50) * 0.14);
  const momentum = bullish.length > bearish.length + 2 || opportunityScore >= 64 ? 'marketbeat-analyst-positive'
    : bearish.length > bullish.length + 1 || riskScore >= 62 ? 'marketbeat-analyst-negative'
      : 'marketbeat-mixed';

  return {
    available: records.length > 0 || consensusPages.length > 0,
    fetchedAt: new Date().toISOString(),
    provider: 'marketbeat',
    quoteDelayNote: 'MarketBeat public analyst pages are scraped and may be delayed, summarized, or markup-variable; verify broker actions with original analyst notes where available, SEC filings, broker/Finnhub quotes, Nasdaq Trader/security-master data, and independent news before trading.',
    sourceList: sourceList(),
    failures,
    screenCount: screenResults.length,
    signalCount: records.length,
    uniqueSymbolCount: uniqueSymbols.length,
    bullishCount: bullish.length,
    bearishCount: bearish.length,
    targetChangeCount: targetChanges.length,
    consensusPageCount: consensusPages.length,
    opportunityScore,
    riskScore,
    targetScore,
    consensusScore,
    momentum,
    records,
    consensusPages,
    topPositive: bullish.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    topNegative: bearish.sort((a, b) => a.signalScore - b.signalScore).slice(0, 12),
    targetChanges: targetChanges.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    consensusForecasts: consensus.slice(0, 12),
    narrative: records.length || consensusPages.length
      ? `MarketBeat ${momentum}: ${records.length} analyst/broker-action rows, ${bullish.length} positive actions, ${bearish.length} negative actions, ${targetChanges.length} price-target rows, ${consensusPages.length} consensus snippets. Opportunity ${opportunityScore}, risk ${riskScore}.`
      : 'MarketBeat analyst context unavailable; public pages may be blocked, throttled, rendered client-side, or changed.',
  };
}

function scoreCandidate({ candidate, marketBeatContext }) {
  if (!marketBeatContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, signals: [], consensusPages: [], explanation: 'MarketBeat analyst context unavailable.' };
  }
  const symbol = cleanSymbol(candidate?.symbol);
  const signals = (marketBeatContext.records || []).filter((item) => item.symbol === symbol);
  const consensusPages = (marketBeatContext.consensusPages || []).filter((item) => item.symbol === symbol);
  if (!signals.length && !consensusPages.length) {
    return {
      normalized: 0.5,
      compositeScore: 50,
      exposure: 10,
      signals: [],
      consensusPages: [],
      explanation: `${symbol || 'Candidate'} did not appear in current MarketBeat analyst action rows or requested consensus forecast snippets.`,
    };
  }

  const bullish = signals.filter((item) => item.stance === 'bullish');
  const bearish = signals.filter((item) => item.stance === 'bearish');
  const targetSignals = signals.filter((item) => Number.isFinite(item.newTarget));
  const signalAverage = average(signals.map((item) => item.signalScore));
  const exposure = clamp01(0.34 + signals.length * 0.12 + targetSignals.length * 0.05 + consensusPages.length * 0.04);
  const raw = 0.5
    + ((signalAverage - 50) / 100) * exposure
    + (bullish.length - bearish.length) * 0.035
    + targetSignals.reduce((sum, item) => sum + clamp((targetDeltaScore(item) - 50) / 100, -0.05, 0.08), 0)
    + consensusPages.length * 0.018;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    signals: signals.slice(0, 8),
    consensusPages: consensusPages.slice(0, 8),
    explanation: `MarketBeat analyst signals for ${symbol || candidate?.companyName || 'candidate'}: ${signals.map((item) => `${item.action || item.signal}${item.analystFirm ? `/${item.analystFirm}` : ''}`).join(', ') || 'no direct broker-action row'}${consensusPages.length ? '; consensus forecast page available' : ''}. Verify scraped MarketBeat output with original broker notes/quotes, SEC filings, Finnhub, broker quotes, and independent news before live orders.`,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'marketbeat',
    fetchedAt: context.fetchedAt,
    momentum: context.momentum,
    opportunityScore: context.opportunityScore,
    riskScore: context.riskScore,
    targetScore: context.targetScore,
    consensusScore: context.consensusScore,
    signalCount: context.signalCount || 0,
    bullishCount: context.bullishCount || 0,
    bearishCount: context.bearishCount || 0,
    targetChangeCount: context.targetChangeCount || 0,
    consensusPageCount: context.consensusPageCount || 0,
    topPositive: (context.topPositive || []).slice(0, 8).map(compactRecord),
    topNegative: (context.topNegative || []).slice(0, 8).map(compactRecord),
    targetChanges: (context.targetChanges || []).slice(0, 8).map(compactRecord),
    consensusForecasts: (context.consensusForecasts || []).slice(0, 8).map(compactConsensusPage),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.quoteDelayNote || 'Scraped MarketBeat analyst pages should be verified with original broker notes, market-data providers, SEC filings, and independent news before trading.',
    bmclUse: 'Use as scraped MarketBeat analyst recommendation, broker upgrade/downgrade, price-target-change, and consensus forecast discovery evidence. Share compact broker-action rows for candidate generation, self-improvement, and council debate, then corroborate with original analyst/broker sources, broker quotes, Finnhub, SEC filings, Nasdaq Trader/security-master data, GDELT/Google News, and official sources before scoring live trades.',
  };
}

async function collectConsensusPages({ symbols, timeoutMs, onEvent, failures }) {
  const pages = [];
  const settled = await Promise.allSettled(symbols.map(async (symbol) => {
    const url = consensusForecastUrl(symbol);
    const html = await fetchHtml(url, timeoutMs);
    const snippet = extractConsensusSnippet(html);
    emit(onEvent, 'marketbeat-consensus-page', 39, 'debug', 'Fetched MarketBeat consensus forecast page.', {
      symbol,
      url,
      snippetLength: snippet.length,
    });
    return { symbol, url, pageType: 'consensus-forecast', label: 'Consensus Forecast', snippet };
  }));

  settled.forEach((result, index) => {
    const symbol = symbols[index];
    if (result.status === 'fulfilled') {
      pages.push(result.value);
    } else {
      failures.push({ screen: 'consensus-forecast', url: consensusForecastUrl(symbol), error: result.reason.message });
      emit(onEvent, 'marketbeat-consensus-page', 39, 'warn', 'MarketBeat consensus forecast page unavailable; continuing with remaining pages.', {
        symbol,
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
    'User-Agent': 'Mozilla/5.0 AutoTrader MarketBeat analyst research bot; contact=local',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers, redirect: 'follow' }, { bucket: 'marketbeat', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return [
    { name: 'MarketBeat analyst ratings', type: 'marketbeat-analyst-ratings', url: MARKETBEAT_RATINGS_URL },
    { name: 'MarketBeat analyst upgrades', type: 'marketbeat-upgrades', url: MARKETBEAT_UPGRADES_URL },
    { name: 'MarketBeat analyst downgrades', type: 'marketbeat-downgrades', url: MARKETBEAT_DOWNGRADES_URL },
    { name: 'MarketBeat price-target changes', type: 'marketbeat-price-target-changes', url: MARKETBEAT_PRICE_TARGET_CHANGES_URL },
    { name: 'MarketBeat consensus forecast', type: 'marketbeat-consensus-forecast', url: consensusForecastUrl('{ticker}'), urlPattern: consensusForecastUrl('{ticker}') },
  ];
}

function compactRecord(record) {
  return {
    symbol: record.symbol,
    exchange: record.exchange,
    companyName: record.companyName,
    analystFirm: record.analystFirm,
    action: record.action,
    previousRating: record.previousRating,
    newRating: record.newRating,
    previousTarget: record.previousTarget,
    newTarget: record.newTarget,
    publishedAt: record.publishedAt,
    signal: record.signal,
    category: record.category,
    stance: record.stance,
    signalScore: record.signalScore,
    sourceUrl: record.sourceUrl,
    quoteUrl: record.quoteUrl,
  };
}

function compactConsensusPage(page) {
  return {
    symbol: page.symbol,
    pageType: page.pageType,
    label: page.label,
    url: page.url,
    snippet: cleanText(page.snippet).slice(0, 420),
  };
}

function extractStockFromHref(href = '') {
  try {
    const parsed = new URL(href, MARKETBEAT_HOME_URL);
    const match = parsed.pathname.match(/\/stocks\/([^/]+)\/([^/]+)\/forecast\/?/i);
    return { exchange: cleanText(match?.[1] || '').toUpperCase(), symbol: match?.[2] || '' };
  } catch {
    const match = String(href || '').match(/\/stocks\/([^/]+)\/([^/]+)\/forecast\/?/i);
    return { exchange: cleanText(match?.[1] || '').toUpperCase(), symbol: match?.[2] || '' };
  }
}

function findCompanyName($, anchor, href, symbol, rowText = '') {
  const linkTexts = $(anchor).closest('tr,div,li').find(`a[href="${href}"]`).toArray()
    .map((link) => cleanText($(link).text()))
    .filter((text) => text && cleanSymbol(text) !== symbol && !/forecast|rating|target/i.test(text));
  if (linkTexts[0]) return linkTexts[0];
  const tokens = rowText.split(/\s+\|\s+| • | - /).map(cleanText).filter(Boolean);
  return tokens.find((token) => token.length > 3 && !isTicker(token) && !/^(upgrade|downgrade|buy|sell|hold|neutral|overweight|underweight|outperform|underperform)$/i.test(token) && !/^\$?\d/.test(token)) || '';
}

function nearestRecordText($, anchor, needle) {
  const rowText = nodeText($, $(anchor).closest('tr'));
  if (rowText.includes(needle) && rowText.length > cleanText($(anchor).text()).length) {
    return rowText;
  }
  let current = $(anchor);
  for (let depth = 0; depth < 7; depth += 1) {
    current = current.parent();
    if (!current.length) break;
    const text = nodeText($, current);
    if (text.includes(needle) && text.length <= 2800 && /(\bupgrade\b|\bdowngrade\b|target|rating|analyst|broker|\bbuy\b|\bsell\b|\bhold\b|\$\d|\d{4})/i.test(text)) {
      return text;
    }
  }
  return rowText;
}

function extractAnalystFields(rowText, screen = {}) {
  const text = cleanText(rowText);
  const lowered = text.toLowerCase();
  const action = inferAction(lowered, screen);
  const ratingFlow = extractRatingFlow(text);
  const targets = [...text.matchAll(/\$\s?(\d+(?:,\d{3})*(?:\.\d+)?)/g)].map((match) => parseNumber(match[1]));
  const [previousTarget, newTarget] = targets.length >= 2 ? [targets[0], targets[1]] : [null, targets[0] ?? null];
  return {
    action,
    stance: inferStance(action, ratingFlow.newRating, screen),
    analystFirm: extractAnalystFirm(text),
    previousRating: ratingFlow.previousRating,
    newRating: ratingFlow.newRating,
    previousTarget,
    newTarget,
    publishedAt: extractPublishedAt(text),
  };
}

function inferAction(lowered, screen = {}) {
  if (/downgrad/.test(lowered)) return 'downgrade';
  if (/upgrad/.test(lowered)) return 'upgrade';
  if (/price target|target (?:raised|increased|boosted|lifted|cut|reduced|lowered|decreased)|lowered price target|raised price target/.test(lowered)) return 'price-target-change';
  if (/initiated|coverage/.test(lowered)) return 'initiated';
  if (/reiterated|maintained|reissued/.test(lowered)) return 'reiterated';
  if (screen.id === 'upgrades') return 'upgrade';
  if (screen.id === 'downgrades') return 'downgrade';
  if (screen.id === 'price-target-changes') return 'price-target-change';
  return 'analyst-rating';
}

function inferStance(action, newRating, screen = {}) {
  const rating = cleanText(newRating).toLowerCase();
  if (action === 'downgrade' || /sell|underperform|underweight|reduce/.test(rating)) return 'bearish';
  if (action === 'upgrade' || /buy|outperform|overweight|strong buy|market outperform/.test(rating)) return 'bullish';
  if (screen.stance === 'bearish' || screen.stance === 'bullish') return screen.stance;
  return 'attention';
}

function extractRatingFlow(text) {
  const ratingWords = '(strong buy|buy|outperform|overweight|market outperform|hold|neutral|equal weight|market perform|underperform|underweight|sell|reduce)';
  const fromTo = new RegExp(`${ratingWords}\\s+(?:to|from)\\s+${ratingWords}`, 'i').exec(text);
  if (fromTo) {
    return {
      previousRating: normalizeRating(fromTo[1]),
      newRating: normalizeRating(fromTo[2]),
    };
  }
  const ratingMatch = new RegExp(`\\b${ratingWords}\\b`, 'i').exec(text);
  return { previousRating: '', newRating: ratingMatch ? normalizeRating(ratingMatch[1]) : '' };
}

function extractAnalystFirm(text) {
  const pipeParts = text.split(/\s+\|\s+/).map(cleanText).filter(Boolean);
  const tableFirm = pipeParts.find((part, index) => index > 0
    && !isTicker(part)
    && !/upgrade|downgrade|target|rating|buy|sell|hold|neutral|outperform|underperform|\$|20\d{2}/i.test(part));
  if (tableFirm) return tableFirm.slice(0, 80);
  const patterns = [
    /(?:by|from|at)\s+([A-Z][A-Za-z&.\s-]{2,45}?)(?:\s+(?:on|to|from|with|for|set|raised|lowered|upgraded|downgraded|initiated|reiterated|maintained)|\s+\$|\s+\d{1,2}\/|\s+\w+\s+\d{1,2},|\s+\|)/,
    /^([A-Z][A-Za-z&.\s-]{2,45}?)(?:\s+(?:upgraded|downgraded|raised|lowered|reiterated|initiated|maintained|set)\b)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return cleanText(match[1]).replace(/\s+(Inc|LLC|Ltd)\.?$/i, '').slice(0, 80);
  }
  return '';
}

function extractPublishedAt(text) {
  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d)?Z?)?\b/);
  if (iso) return iso[0];
  const usDate = text.match(/\b\d{1,2}\/\d{1,2}\/20\d{2}\b/);
  if (usDate) return usDate[0];
  const longDate = text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+20\d{2}\b/i);
  return longDate?.[0] || '';
}

function targetDeltaScore(record = {}) {
  if (!Number.isFinite(record.newTarget) || !Number.isFinite(record.previousTarget) || record.previousTarget <= 0) {
    return record.stance === 'bullish' ? 62 : record.stance === 'bearish' ? 38 : 50;
  }
  const deltaPct = ((record.newTarget - record.previousTarget) / record.previousTarget) * 100;
  return clampScore(50 + clamp(deltaPct, -35, 35));
}

function scoreAnalystRecord(screen, fields = {}) {
  const base = fields.stance === 'bullish' ? 64 : fields.stance === 'bearish' ? 36 : 52;
  const targetBonus = targetDeltaScore(fields) - 50;
  const ratingBonus = /strong buy|buy|outperform|overweight/i.test(fields.newRating || '') ? 5
    : /sell|underperform|underweight/i.test(fields.newRating || '') ? -7
      : 0;
  return clampScore(base + targetBonus * 0.45 + ratingBonus + (screen.weight - 0.65) * 18);
}

function extractConsensusSnippet(html) {
  const $ = cheerio.load(String(html || ''));
  $('script, style, noscript, svg').remove();
  const text = cleanText($('main').text() || $('body').text());
  return text.slice(0, 1400);
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

function consensusForecastUrl(symbol) {
  return `${MARKETBEAT_HOME_URL}stocks/NASDAQ/${String(symbol || '').toUpperCase()}/forecast/`;
}

function absolutize(href) {
  try {
    return new URL(href, MARKETBEAT_HOME_URL).toString();
  } catch {
    return href;
  }
}

function normalizeRating(value) {
  return cleanText(value).toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
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
  MARKETBEAT_HOME_URL,
  MARKETBEAT_RATINGS_URL,
  MARKETBEAT_UPGRADES_URL,
  MARKETBEAT_DOWNGRADES_URL,
  MARKETBEAT_PRICE_TARGET_CHANGES_URL,
  MARKETBEAT_SCREENS,
  collectMarketBeatAnalystContext,
  parseAnalystRows,
  evaluateMarketBeatContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
