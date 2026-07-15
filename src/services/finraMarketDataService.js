const { resilientFetch } = require('../utils/resilientFetch');
const cheerio = require('cheerio');

const FINRA_DATA_PORTAL_URL = 'https://www.finra.org/finra-data';
const FINRA_FIXED_INCOME_URL = 'https://www.finra.org/finra-data/fixed-income';
const FINRA_CORP_AGENCY_URL = 'https://www.finra.org/finra-data/fixed-income/corp-and-agency';
const FINRA_CORP_AGENCY_TRADE_URL = 'https://www.finra.org/finra-data/fixed-income/corp-and-agency/trade';

const FINRA_SOURCES = [
  {
    id: 'finra-data-portal',
    label: 'FINRA Data portal',
    url: FINRA_DATA_PORTAL_URL,
    type: 'finra-data-portal',
  },
  {
    id: 'finra-fixed-income',
    label: 'FINRA Fixed Income Data',
    url: FINRA_FIXED_INCOME_URL,
    type: 'finra-fixed-income',
  },
  {
    id: 'finra-corp-agency-bonds',
    label: 'FINRA corporate and agency bonds',
    url: FINRA_CORP_AGENCY_URL,
    type: 'finra-corporate-agency-bonds',
  },
  {
    id: 'finra-corp-agency-trade-activity',
    label: 'FINRA corporate bond trade activity',
    url: FINRA_CORP_AGENCY_TRADE_URL,
    type: 'finra-corporate-bond-trade-activity',
  },
];

async function collectFinraMarketContext({
  timeoutMs = 8000,
  limit = 20,
  sourceIds,
  onEvent = () => {},
} = {}) {
  const selected = selectSources(sourceIds);
  const boundedLimit = clampInt(limit, 1, 80);
  const settled = await Promise.allSettled(selected.map(async (source) => {
    const html = await fetchHtml(source.url, timeoutMs);
    const page = parseFinraPage(html, source);
    emit(onEvent, 'finra-fixed-income', 42, 'debug', 'Fetched FINRA fixed-income market page.', {
      source: source.id,
      url: source.url,
      tradeRows: page.tradeRows.length,
    });
    return page;
  }));

  const pages = [];
  const failures = [];
  settled.forEach((result, index) => {
    const source = selected[index];
    if (result.status === 'fulfilled') {
      pages.push(result.value);
    } else {
      failures.push({ source: source.id, url: source.url, error: result.reason.message });
      emit(onEvent, 'finra-fixed-income', 42, 'warn', 'FINRA fixed-income source unavailable; continuing with remaining sources.', {
        source: source.id,
        url: source.url,
        error: result.reason.message,
      });
    }
  });

  return evaluateFinraContext({
    pages,
    failures,
    limit: boundedLimit,
  });
}

function parseFinraPage(html, source = {}) {
  const $ = cheerio.load(String(html || ''));
  $('script, style, noscript, svg').remove();
  const text = cleanText($('main').text() || $('body').text());
  return {
    source,
    fetchedAt: new Date().toISOString(),
    text,
    tradeRows: parseTradeRows(html, source),
    links: $('a[href]').toArray()
      .map((anchor) => ({
        label: cleanText($(anchor).text()),
        url: absolutize($(anchor).attr('href'), source.url),
      }))
      .filter((link) => link.url && /finra\.org|developer\.finra\.org/i.test(link.url))
      .slice(0, 60),
  };
}

function parseTradeRows(html, source = {}) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  $('tr').each((_, tr) => {
    if ($(tr).find('td').length < 3) return;
    const cells = $(tr).find('td').toArray().map((cell) => cleanText($(cell).text())).filter(Boolean);
    if (cells.length < 3) return;
    const text = cleanText(cells.join(' | '));
    if (!hasBondSignal(text)) return;
    const parsed = parseTradeText(text, source);
    if (parsed.symbol || parsed.issuer || parsed.cusip) rows.push(parsed);
  });

  if (rows.length) return dedupeRows(rows);

  $('[data-symbol], [data-ticker], [data-cusip]').each((_, node) => {
    const text = cleanText($(node).text());
    const attrs = {
      symbol: $(node).attr('data-symbol') || $(node).attr('data-ticker'),
      cusip: $(node).attr('data-cusip'),
    };
    const parsed = parseTradeText(`${attrs.symbol || ''} ${attrs.cusip || ''} ${text}`, source);
    if (parsed.symbol || parsed.issuer || parsed.cusip) rows.push(parsed);
  });

  return dedupeRows(rows);
}

function evaluateFinraContext({ pages = [], failures = [], limit = 20 } = {}) {
  const tradeSignals = pages.flatMap((page) => page.tradeRows || []).slice(0, limit);
  const portalText = cleanText(pages.map((page) => page.text).join(' ')).slice(0, 4000);
  const portalAvailability = pages.length > 0;
  const tradeActivityAvailable = pages.some((page) => /trade activity|corporate bond|agency bond|fixed income/i.test(page.text))
    || tradeSignals.length > 0;
  const marketStructureAvailable = pages.some((page) => /bond details|market statistics|fixed income data|bond watchlist/i.test(page.text));
  const stressed = tradeSignals.filter((row) => row.creditStance === 'stressed');
  const constructive = tradeSignals.filter((row) => row.creditStance === 'constructive');
  const stressScores = tradeSignals.map(scoreTradeStress);
  const creditStressScore = clampScore(average(stressScores));
  const refinancingPressureScore = clampScore(45 + stressed.length * 4 + average(tradeSignals.map((row) => Number.isFinite(row.yieldPct) ? row.yieldPct * 3.5 : 0)) * 0.35);
  const equityCreditDivergenceScore = clampScore(42 + stressed.length * 5 - constructive.length * 2 + failures.length * 1.5);
  const riskScore = clampScore(creditStressScore * 0.46 + refinancingPressureScore * 0.34 + equityCreditDivergenceScore * 0.2);
  const opportunityScore = clampScore(100 - riskScore + constructive.length * 2 - failures.length);
  const momentum = riskScore >= 64 ? 'finra-credit-stress'
    : opportunityScore >= 62 ? 'finra-credit-constructive'
      : 'finra-credit-mixed';

  return {
    available: portalAvailability || tradeSignals.length > 0,
    fetchedAt: new Date().toISOString(),
    provider: 'finra',
    quoteDelayNote: 'FINRA public fixed-income pages provide fixed-income security, trade-activity, and market-statistics context. Treat portal/scraped rows as credit-market risk evidence, not as a trade authorization; verify bond identifiers, issuer mapping, and equity ticker links before live orders.',
    sourceList: sourceList(),
    failures,
    pageCount: pages.length,
    tradeSignalCount: tradeSignals.length,
    stressedCount: stressed.length,
    constructiveCount: constructive.length,
    marketStructureAvailable,
    tradeActivityAvailable,
    creditStressScore,
    refinancingPressureScore,
    equityCreditDivergenceScore,
    riskScore,
    opportunityScore,
    momentum,
    portalSummary: summarizePortalText(portalText),
    tradeSignals,
    topCreditWeakness: [...tradeSignals].sort((a, b) => scoreTradeStress(b) - scoreTradeStress(a)).slice(0, 12),
    topCreditStrength: [...tradeSignals].sort((a, b) => scoreTradeStress(a) - scoreTradeStress(b)).slice(0, 12),
    narrative: portalAvailability || tradeSignals.length
      ? `FINRA ${momentum}: ${pages.length} fixed-income pages available, ${tradeSignals.length} parsed trade/security rows, stress ${riskScore}, refinancing pressure ${refinancingPressureScore}.`
      : 'FINRA fixed-income context unavailable; public pages may be unavailable, client-rendered, throttled, or markup-variable.',
  };
}

function scoreCandidate({ candidate, finraContext }) {
  if (!finraContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, signals: [], explanation: 'FINRA fixed-income context unavailable.' };
  }
  const symbol = cleanSymbol(candidate?.symbol);
  const companyName = cleanText(candidate?.companyName);
  const signals = (finraContext.tradeSignals || []).filter((row) => matchesCandidate(row, { symbol, companyName }));
  const exposure = clamp01(Math.max(candidateCreditExposure(candidate), signals.length ? 0.42 + signals.length * 0.1 : 0.1));
  const directStress = signals.length ? average(signals.map(scoreTradeStress)) : finraContext.riskScore;
  const stressPenalty = ((directStress - 50) / 100) * exposure;
  const normalized = clamp01(0.5 - stressPenalty + (finraContext.opportunityScore - 50) / 1000);

  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    signals: signals.slice(0, 8),
    contextRiskScore: finraContext.riskScore,
    explanation: signals.length
      ? `FINRA credit-market signals for ${symbol || companyName || 'candidate'} include ${signals.length} bond/security row(s): ${signals.slice(0, 3).map((row) => `${row.issuer || row.symbol || row.cusip} ${row.creditStance} stress ${scoreTradeStress(row)}`).join(', ')}. Watch yield spreads, falling bond prices, distressed volume, downgrade language, and refinancing pressure before equity orders.`
      : `${symbol || companyName || 'Candidate'} had no direct FINRA bond rows; applying sector leverage sensitivity against FINRA fixed-income market risk ${finraContext.riskScore}.`,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'finra',
    fetchedAt: context.fetchedAt,
    momentum: context.momentum,
    opportunityScore: context.opportunityScore,
    riskScore: context.riskScore,
    creditStressScore: context.creditStressScore,
    refinancingPressureScore: context.refinancingPressureScore,
    equityCreditDivergenceScore: context.equityCreditDivergenceScore,
    tradeSignalCount: context.tradeSignalCount || 0,
    stressedCount: context.stressedCount || 0,
    constructiveCount: context.constructiveCount || 0,
    marketStructureAvailable: Boolean(context.marketStructureAvailable),
    tradeActivityAvailable: Boolean(context.tradeActivityAvailable),
    topCreditWeakness: (context.topCreditWeakness || []).slice(0, 8).map(compactTradeSignal),
    topCreditStrength: (context.topCreditStrength || []).slice(0, 8).map(compactTradeSignal),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.quoteDelayNote || 'Use FINRA fixed-income public data as credit-market risk evidence and verify issuer/ticker mapping before trading.',
    bmclUse: 'Use as official FINRA fixed-income and corporate/agency bond trade-activity evidence for credit-risk debate. Agents should share yield spread, bond-price, distressed-trading, downgrade-risk, refinancing-pressure, and equity-credit divergence observations, then corroborate issuer mappings with SEC filings, broker/Finnhub quotes, rating/news sources, and company fundamentals before live orders.',
  };
}

function parseTradeText(text, source = {}) {
  const normalized = cleanText(text);
  const symbol = cleanSymbol(
    normalized.match(/\b(?:Ticker|Symbol)\s*[:|]?\s*([A-Z][A-Z0-9.-]{0,7})\b/i)?.[1]
    || normalized.match(/\b([A-Z][A-Z0-9.-]{1,5})\b(?=.*\b(?:CUSIP|Yield|Spread|Price|Trade|Bond)\b)/i)?.[1]
  );
  const cusip = cleanText(normalized.match(/\b(?:CUSIP)\s*[:|]?\s*([A-Z0-9]{9})\b/i)?.[1]
    || normalized.match(/\b[A-Z0-9]{9}\b/)?.[0]).toUpperCase();
  const issuer = extractIssuer(normalized, symbol, cusip);
  const price = firstNumberAfter(normalized, ['Price', 'Last Price', 'Trade Price']);
  const yieldPct = firstNumberAfter(normalized, ['Yield', 'YTM', 'Yield to Maturity']);
  const spreadBps = firstNumberAfter(normalized, ['Spread', 'OAS', 'G-Spread', 'Z-Spread']);
  const tradeCount = firstNumberAfter(normalized, ['Trades', 'Trade Count']);
  const volume = parseAbbreviatedNumber(normalized.match(/\b(?:Volume|Par)\s*[:|]?\s*\$?([\d,.]+[KMBT]?)\b/i)?.[1]);
  const rating = cleanText(normalized.match(/\b(?:Rating|Credit Rating)\s*[:|]?\s*([A-Z]{1,3}[+-]?(?:\s+Watch\s+\w+)?|Investment Grade|High Yield|Junk)\b/i)?.[1]);
  const tradeDate = cleanText(normalized.match(/\b(20\d{2}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/20\d{2})\b/)?.[1]);
  const creditStance = inferCreditStance({ price, yieldPct, spreadBps, rating, text: normalized });
  return {
    symbol,
    issuer,
    cusip,
    bondDescription: normalized.slice(0, 240),
    price,
    yieldPct,
    spreadBps,
    tradeCount,
    volume,
    rating,
    tradeDate,
    creditStance,
    sourceUrl: source.url,
    sourceId: source.id,
    reason: reasonForTrade({ price, yieldPct, spreadBps, rating, creditStance }),
  };
}

function hasBondSignal(text) {
  return /(CUSIP|corporate bond|agency bond|bond|yield|spread|trade activity|TRACE|rating|maturity|coupon)/i.test(text);
}

function inferCreditStance({ price, yieldPct, spreadBps, rating, text }) {
  if ((Number.isFinite(price) && price < 85)
    || (Number.isFinite(yieldPct) && yieldPct >= 8)
    || (Number.isFinite(spreadBps) && spreadBps >= 350)
    || /distress|default|downgrade|watch negative|junk|high yield|ccc|cc|caa/i.test(`${rating} ${text}`)) {
    return 'stressed';
  }
  if ((Number.isFinite(price) && price >= 98)
    || (Number.isFinite(yieldPct) && yieldPct <= 5.5)
    || (Number.isFinite(spreadBps) && spreadBps <= 160)
    || /investment grade|aaa|aa|a\+|a-|bbb/i.test(`${rating} ${text}`)) {
    return 'constructive';
  }
  return 'mixed';
}

function scoreTradeStress(row = {}) {
  let score = 45;
  if (Number.isFinite(row.price)) score += clamp((90 - row.price) * 1.2, -16, 24);
  if (Number.isFinite(row.yieldPct)) score += clamp((row.yieldPct - 5) * 4.5, -12, 26);
  if (Number.isFinite(row.spreadBps)) score += clamp((row.spreadBps - 160) / 12, -12, 28);
  if (Number.isFinite(row.tradeCount)) score += clamp(row.tradeCount / 8, 0, 10);
  if (/distress|default|downgrade|watch negative|junk|high yield|ccc|cc|caa/i.test(`${row.rating || ''} ${row.bondDescription || ''}`)) score += 14;
  if (row.creditStance === 'constructive') score -= 10;
  if (row.creditStance === 'stressed') score += 8;
  return clampScore(score);
}

function candidateCreditExposure(candidate = {}) {
  const text = [candidate.symbol, candidate.companyName, candidate.theme, candidate.discovery?.method, ...(candidate.discovery?.tags || [])].join(' ').toLowerCase();
  const highDebtTerms = ['bank', 'financial', 'credit', 'loan', 'reit', 'real estate', 'utility', 'telecom', 'airline', 'auto', 'automotive', 'energy', 'industrial', 'materials', 'capital', 'bond'];
  const hits = highDebtTerms.filter((term) => text.includes(term)).length;
  return clamp01(0.12 + hits * 0.09);
}

function matchesCandidate(row, { symbol, companyName }) {
  const issuer = cleanText(row.issuer).toLowerCase();
  const description = cleanText(row.bondDescription).toLowerCase();
  if (symbol && row.symbol === symbol) return true;
  if (companyName && (issuer.includes(companyName.toLowerCase()) || description.includes(companyName.toLowerCase()))) return true;
  return false;
}

function reasonForTrade({ price, yieldPct, spreadBps, rating, creditStance }) {
  const parts = [];
  if (Number.isFinite(price)) parts.push(`bond price ${price}`);
  if (Number.isFinite(yieldPct)) parts.push(`yield ${yieldPct}%`);
  if (Number.isFinite(spreadBps)) parts.push(`spread ${spreadBps} bps`);
  if (rating) parts.push(`rating ${rating}`);
  return `${creditStance} FINRA fixed-income signal${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

function extractIssuer(text, symbol, cusip) {
  const cells = text.split(/\s+\|\s+/).map(cleanText).filter(Boolean);
  const symbolIndex = cells.findIndex((cell) => cleanSymbol(cell) === symbol);
  if (symbolIndex >= 0 && cells[symbolIndex + 1] && !hasNumericMetric(cells[symbolIndex + 1])) return cells[symbolIndex + 1];
  const cusipIndex = cells.findIndex((cell) => cell.includes(cusip));
  if (cusipIndex > 0 && !hasNumericMetric(cells[cusipIndex - 1])) return cells[cusipIndex - 1];
  const issuerMatch = text.match(/\b(?:Issuer|Company)\s*[:|]?\s*([A-Z0-9&.,' -]{3,90}?)(?:\s+\||\s+(?:CUSIP|Ticker|Symbol|Price|Yield|Spread)\b)/i);
  if (issuerMatch) return cleanText(issuerMatch[1]);
  return '';
}

function hasNumericMetric(value) {
  return /\d|price|yield|spread|volume|trade/i.test(value || '');
}

function firstNumberAfter(text, labels) {
  for (const label of labels) {
    const match = new RegExp(`${escapeRegExp(label)}\\s*[:|]?\\s*([-+]?\\d+(?:\\.\\d+)?)(?:%|\\s*bps)?`, 'i').exec(text);
    const parsed = parseNumber(match?.[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function fetchHtml(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 AutoTrader FINRA fixed-income research bot; contact=local',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers, redirect: 'follow' }, { bucket: 'finra', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function selectSources(sourceIds) {
  const ids = new Set((Array.isArray(sourceIds) ? sourceIds : []).filter(Boolean));
  return ids.size ? FINRA_SOURCES.filter((source) => ids.has(source.id)) : FINRA_SOURCES;
}

function sourceList() {
  return FINRA_SOURCES.map((source) => ({
    name: source.label,
    type: source.type,
    url: source.url,
  }));
}

function compactTradeSignal(row = {}) {
  return {
    symbol: row.symbol,
    issuer: row.issuer,
    cusip: row.cusip,
    price: row.price,
    yieldPct: row.yieldPct,
    spreadBps: row.spreadBps,
    tradeCount: row.tradeCount,
    volume: row.volume,
    rating: row.rating,
    creditStance: row.creditStance,
    stressScore: scoreTradeStress(row),
    sourceUrl: row.sourceUrl,
    reason: row.reason,
  };
}

function summarizePortalText(text) {
  const sentences = cleanText(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.filter((sentence) => /fixed income|bond|trade activity|market statistics|corporate|agency|watchlist/i.test(sentence)).slice(0, 4).join(' ').slice(0, 700);
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = [row.symbol, row.issuer, row.cusip, row.price, row.yieldPct, row.spreadBps].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSymbolList(symbols) {
  return (Array.isArray(symbols) ? symbols : [symbols]).map(cleanSymbol).filter(Boolean);
}

function absolutize(href, baseUrl = FINRA_DATA_PORTAL_URL) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function cleanSymbol(value) {
  const symbol = cleanText(value).toUpperCase().replace(/[^A-Z0-9.-]/g, '');
  return /^[A-Z][A-Z0-9.-]{0,7}$/.test(symbol) ? symbol : '';
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseNumber(value) {
  const parsed = Number(String(value || '').replace(/[$,%x]/gi, '').replace(/,/g, '').replace(/[KMBT]$/i, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAbbreviatedNumber(value) {
  const text = String(value || '').replace(/[$,]/g, '').trim();
  const match = text.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/i);
  if (!match) return null;
  const base = Number(match[1]);
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[String(match[2] || '').toUpperCase()] || 1;
  return Number.isFinite(base) ? base * mult : null;
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

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  FINRA_DATA_PORTAL_URL,
  FINRA_FIXED_INCOME_URL,
  FINRA_CORP_AGENCY_URL,
  FINRA_CORP_AGENCY_TRADE_URL,
  FINRA_SOURCES,
  collectFinraMarketContext,
  parseFinraPage,
  parseTradeRows,
  evaluateFinraContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
  normalizeSymbolList,
};
