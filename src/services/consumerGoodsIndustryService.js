const cheerio = require('cheerio');
const { resilientFetch } = require('../utils/resilientFetch');

const STOCK_ANALYSIS_HOUSEHOLD_PERSONAL_URL = 'https://stockanalysis.com/stocks/industry/household-and-personal-products/';
const YAHOO_HOUSEHOLD_PERSONAL_URL = 'https://finance.yahoo.com/sectors/consumer-defensive/household-personal-products/';
const COMPANIES_MARKET_CAP_CONSUMER_GOODS_REVENUE_URL = 'https://companiesmarketcap.com/consumer-goods/largest-consumer-goods-companies-by-revenue/';
const FORTUNE_500_URL = 'https://fortune.com/ranking/fortune500/';

const INDUSTRY_SOURCES = [
  {
    id: 'stockanalysis-household-personal-products',
    label: 'Stock Analysis Household and Personal Products Industry',
    url: STOCK_ANALYSIS_HOUSEHOLD_PERSONAL_URL,
    provider: 'stockanalysis',
    focus: 'household-personal-products',
    metricMode: 'industry-fundamentals',
    weight: 0.88,
  },
  {
    id: 'yahoo-household-personal-products',
    label: 'Yahoo Finance Household and Personal Products Industry',
    url: YAHOO_HOUSEHOLD_PERSONAL_URL,
    provider: 'yahoo-finance',
    focus: 'household-personal-products',
    metricMode: 'industry-market-list',
    weight: 0.72,
  },
  {
    id: 'companiesmarketcap-consumer-goods-revenue',
    label: 'CompaniesMarketCap Consumer Goods Companies by Revenue',
    url: COMPANIES_MARKET_CAP_CONSUMER_GOODS_REVENUE_URL,
    provider: 'companiesmarketcap',
    focus: 'consumer-goods-revenue',
    metricMode: 'revenue-ranking',
    weight: 0.82,
  },
  {
    id: 'fortune-500',
    label: 'Fortune 500 Revenue Ranking',
    url: FORTUNE_500_URL,
    provider: 'fortune',
    focus: 'large-company-revenue-ranking',
    metricMode: 'revenue-ranking',
    weight: 0.64,
  },
];

async function collectConsumerGoodsIndustryContext({
  timeoutMs = 9000,
  limit = 30,
  sourceIds,
  onEvent = () => {},
} = {}) {
  const selectedIds = new Set((Array.isArray(sourceIds) ? sourceIds : []).filter(Boolean));
  const sources = INDUSTRY_SOURCES.filter((source) => !selectedIds.size || selectedIds.has(source.id) || selectedIds.has(source.provider) || selectedIds.has(source.focus));
  const selectedSources = sources.length ? sources : INDUSTRY_SOURCES;
  const boundedLimit = clampInt(limit, 1, 100);

  const settled = await Promise.allSettled(selectedSources.map(async (source) => {
    const html = await fetchHtml(source.url, timeoutMs);
    const rows = parseIndustryRows(html, source).slice(0, boundedLimit);
    emit(onEvent, 'consumer-goods-industry', 36, 'debug', 'Fetched consumer-goods industry source page.', {
      source: source.id,
      rows: rows.length,
      url: source.url,
    });
    return { source, rows };
  }));

  const sourceResults = [];
  const failures = [];
  settled.forEach((result, index) => {
    const source = selectedSources[index];
    if (result.status === 'fulfilled') {
      sourceResults.push(result.value);
    } else {
      failures.push({ source: source.id, url: source.url, error: result.reason.message });
      emit(onEvent, 'consumer-goods-industry', 36, 'warn', 'Consumer-goods industry source unavailable; continuing with remaining sources.', {
        source: source.id,
        url: source.url,
        error: result.reason.message,
      });
    }
  });

  return evaluateConsumerGoodsIndustryContext({ sourceResults, failures });
}

function parseIndustryRows(html, source = {}) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();

  $('table tr').each((_, tr) => {
    const row = parseTableRow($, tr, source);
    if (row && !seen.has(`${source.id}:${row.symbol || row.companyName}`)) {
      rows.push(row);
      seen.add(`${source.id}:${row.symbol || row.companyName}`);
    }
  });

  if (!rows.length) {
    $('a[href]').each((_, anchor) => {
      const row = parseLinkedBlock($, anchor, source);
      if (row && !seen.has(`${source.id}:${row.symbol || row.companyName}`)) {
        rows.push(row);
        seen.add(`${source.id}:${row.symbol || row.companyName}`);
      }
    });
  }

  return rows
    .map((row, index) => ({
      rank: row.rank || index + 1,
      ...row,
      signalScore: scoreRecord({ ...row, rank: row.rank || index + 1 }, source),
      caveat: sourceCaveat(source),
    }))
    .sort((a, b) => a.rank - b.rank || b.signalScore - a.signalScore);
}

function evaluateConsumerGoodsIndustryContext({ sourceResults = [], failures = [] } = {}) {
  const records = sourceResults.flatMap((result) => result.rows || []);
  const uniqueSymbols = [...new Set(records.map((record) => record.symbol).filter(Boolean))];
  const householdPersonalProducts = records.filter((record) => record.focus === 'household-personal-products');
  const revenueRanked = records.filter((record) => record.metricMode === 'revenue-ranking' || Number.isFinite(record.revenue));
  const dividendVisible = records.filter((record) => Number.isFinite(record.dividendYield));
  const valuationVisible = records.filter((record) => Number.isFinite(record.pe) || Number.isFinite(record.marketCap));
  const industryScore = clampScore(average(records.map((record) => record.signalScore)));
  const revenueLeadershipScore = clampScore(average(revenueRanked.map((record) => record.signalScore)));
  const valuationCoverageScore = clampScore(42 + valuationVisible.length * 2.4 + dividendVisible.length * 1.2);
  const momentum = industryScore >= 66 || revenueLeadershipScore >= 66 ? 'consumer-goods-leadership-visible'
    : records.length ? 'consumer-goods-watchlist' : 'unavailable';

  return {
    available: records.length > 0,
    fetchedAt: new Date().toISOString(),
    provider: 'consumer-goods-industry',
    sourceList: sourceList(),
    failures,
    sourceCount: sourceResults.length,
    signalCount: records.length,
    uniqueSymbolCount: uniqueSymbols.length,
    householdPersonalProductsCount: householdPersonalProducts.length,
    revenueRankedCount: revenueRanked.length,
    dividendVisibleCount: dividendVisible.length,
    valuationVisibleCount: valuationVisible.length,
    industryScore,
    revenueLeadershipScore,
    valuationCoverageScore,
    momentum,
    records,
    topCompanies: records.sort((a, b) => b.signalScore - a.signalScore || a.rank - b.rank).slice(0, 30),
    householdPersonalProducts: householdPersonalProducts.sort((a, b) => b.signalScore - a.signalScore || a.rank - b.rank).slice(0, 30),
    revenueLeaders: revenueRanked.sort((a, b) => b.signalScore - a.signalScore || a.rank - b.rank).slice(0, 30),
    sourceSummaries: summarizeSources(records),
    caveat: 'Consumer-goods industry pages are scraped public-page discovery and comparison evidence. Stock Analysis, Yahoo Finance, CompaniesMarketCap, and Fortune rows can surface public companies, revenue rank, market cap, profit, valuation, and dividend context, but they are not primary filings, broker-grade quotes, real-time portfolio data, or company-specific sales attribution. Verify with SEC filings, company reports, broker/Finnhub quotes, and independent news before scoring or trading.',
    narrative: records.length
      ? `Consumer-goods industry context ${momentum}: ${records.length} visible company rows, ${uniqueSymbols.length} unique tickers, ${householdPersonalProducts.length} household/personal-product rows, ${revenueRanked.length} revenue-ranking rows. Industry score ${industryScore}, revenue leadership ${revenueLeadershipScore}.`
      : 'Consumer-goods industry context unavailable; public pages may be blocked, paywalled, throttled, or changed.',
  };
}

function scoreCandidate({ candidate, consumerGoodsContext }) {
  if (!consumerGoodsContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, signals: [], explanation: 'Consumer-goods industry context unavailable.' };
  }
  const symbol = cleanSymbol(candidate?.symbol);
  const candidateName = cleanText(candidate?.companyName || candidate?.name || '');
  const signals = (consumerGoodsContext.records || []).filter((record) => (
    (symbol && record.symbol === symbol)
    || (candidateName && record.companyName && namesOverlap(candidateName, record.companyName))
  ));
  if (!signals.length) {
    return {
      normalized: 0.5,
      compositeScore: 50,
      exposure: 8,
      signals: [],
      explanation: `${symbol || candidateName || 'Candidate'} did not appear in current scraped consumer-goods industry rows.`,
    };
  }
  const signalAverage = average(signals.map((signal) => signal.signalScore));
  const revenueSignals = signals.filter((signal) => Number.isFinite(signal.revenue) || signal.metricMode === 'revenue-ranking');
  const householdSignals = signals.filter((signal) => signal.focus === 'household-personal-products');
  const valuationPenalty = signals.some((signal) => Number.isFinite(signal.pe) && signal.pe > 45) ? -0.04 : 0;
  const dividendBonus = signals.some((signal) => Number.isFinite(signal.dividendYield) && signal.dividendYield > 1) ? 0.02 : 0;
  const exposure = clamp01(0.3 + signals.length * 0.12 + revenueSignals.length * 0.05 + householdSignals.length * 0.05);
  const raw = 0.5 + ((signalAverage - 50) / 100) * exposure + revenueSignals.length * 0.025 + householdSignals.length * 0.02 + dividendBonus + valuationPenalty;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    signals: signals.slice(0, 8).map(compactRecord),
    explanation: `Consumer-goods industry signals for ${symbol || candidateName || 'candidate'}: ${signals.map((signal) => signal.sourceLabel).join(', ')}. Treat scraped industry ranks and metrics as discovery/comparison evidence and verify against filings before live orders.`,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'consumer-goods-industry',
    fetchedAt: context.fetchedAt,
    momentum: context.momentum,
    industryScore: context.industryScore,
    revenueLeadershipScore: context.revenueLeadershipScore,
    valuationCoverageScore: context.valuationCoverageScore,
    signalCount: context.signalCount || 0,
    uniqueSymbolCount: context.uniqueSymbolCount || 0,
    householdPersonalProductsCount: context.householdPersonalProductsCount || 0,
    revenueRankedCount: context.revenueRankedCount || 0,
    topCompanies: (context.topCompanies || []).slice(0, 12).map(compactRecord),
    householdPersonalProducts: (context.householdPersonalProducts || []).slice(0, 12).map(compactRecord),
    revenueLeaders: (context.revenueLeaders || []).slice(0, 12).map(compactRecord),
    sourceSummaries: context.sourceSummaries || [],
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.caveat,
    bmclUse: 'Share as scraped consumer-goods and household/personal-products industry discovery evidence. Use compact ticker/company/rank/revenue/market-cap/profit/valuation/dividend rows to identify public CPG, home-care, personal-care, and large consumer-goods companies for further research, then corroborate with SEC filings, company reports, broker/Finnhub quotes, BLS/Census/Amazon/Walmart demand proxies, and independent news before scoring or trading.',
  };
}

async function fetchHtml(url, timeoutMs = 9000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 AutoTrader consumer goods industry research bot; contact=local',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers, redirect: 'follow' }, { bucket: 'consumer-goods-industry', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function parseTableRow($, tr, source = {}) {
  if (!$(tr).find('td').length) return null;
  const cells = $(tr).find('td,th').toArray().map((cell) => cleanText($(cell).text()));
  const rowText = cleanText(cells.join(' '));
  if (!cells.length || !looksLikeCompanyRow(rowText)) return null;
  const links = $(tr).find('a[href]').toArray().map((anchor) => ({
    href: $(anchor).attr('href') || '',
    text: cleanText($(anchor).text()),
  }));
  return normalizeRow({
    rowText,
    rank: parseRank(cells[0]) || parseRank(rowText),
    symbol: findSymbol({ links, cells, rowText, source }),
    companyName: findCompanyName({ links, cells, rowText, source }),
    url: absolutize(links[0]?.href, source.url),
    source,
  });
}

function parseLinkedBlock($, anchor, source = {}) {
  const href = $(anchor).attr('href') || '';
  const linkText = cleanText($(anchor).text());
  const blockText = nearestRecordText($, anchor, linkText);
  const rowText = cleanText(`${linkText} ${blockText}`);
  if (!looksLikeCompanyRow(rowText)) return null;
  const links = [{ href, text: linkText }];
  return normalizeRow({
    rowText,
    rank: parseRank(rowText),
    symbol: findSymbol({ links, cells: [linkText], rowText, source }),
    companyName: findCompanyName({ links, cells: [linkText], rowText, source }),
    url: absolutize(href, source.url),
    source,
  });
}

function normalizeRow({ rowText, rank, symbol, companyName, url, source }) {
  const metrics = extractMetrics(rowText);
  const cleanedName = cleanCompanyName(companyName || metrics.companyName || '');
  const cleanedSymbol = cleanSymbol(symbol || metrics.symbol || '');
  if (!cleanedName && !cleanedSymbol) return null;
  return {
    rank,
    symbol: cleanedSymbol,
    companyName: cleanedName || cleanedSymbol,
    provider: source.provider,
    sourceId: source.id,
    sourceLabel: source.label,
    sourceUrl: source.url,
    companyUrl: url,
    focus: source.focus,
    metricMode: source.metricMode,
    marketCap: metrics.marketCap,
    marketCapRaw: metrics.marketCapRaw,
    revenue: metrics.revenue,
    revenueRaw: metrics.revenueRaw,
    profit: metrics.profit,
    profitRaw: metrics.profitRaw,
    pe: metrics.pe,
    dividendYield: metrics.dividendYield,
    price: metrics.price,
    changePct: metrics.changePct,
    rowText: rowText.slice(0, 900),
    reason: `${source.label} visible industry/ranking row${rank ? ` rank ${rank}` : ''}${cleanedSymbol ? ` for ${cleanedSymbol}` : ''}.`,
  };
}

function extractMetrics(text) {
  const normalized = cleanText(text).replace(/\u2212/g, '-');
  const moneyTokens = [...normalized.matchAll(/\$\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*[KMBT]?/gi)].map((match) => cleanText(match[0]));
  const percentages = [...normalized.matchAll(/[-+]?\d+(?:\.\d+)?%/g)].map((match) => parseNumber(match[0]));
  const pe = firstFinite([
    ...[...normalized.matchAll(/\bP\/?E\b\s*[: ]?\s*([-+]?\d+(?:\.\d+)?)/gi)].map((match) => parseNumber(match[1])),
    ...[...normalized.matchAll(/\bPE\b\s*[: ]?\s*([-+]?\d+(?:\.\d+)?)/gi)].map((match) => parseNumber(match[1])),
  ]);
  return {
    marketCapRaw: labeledMoney(normalized, /market\s*cap/i) || moneyTokens[0] || '',
    marketCap: parseAbbreviatedMoney(labeledMoney(normalized, /market\s*cap/i) || moneyTokens[0]),
    revenueRaw: labeledMoney(normalized, /revenue/i) || moneyTokens[1] || moneyTokens[0] || '',
    revenue: parseAbbreviatedMoney(labeledMoney(normalized, /revenue/i) || moneyTokens[1] || moneyTokens[0]),
    profitRaw: labeledMoney(normalized, /profit|income|earnings/i) || moneyTokens[2] || '',
    profit: parseAbbreviatedMoney(labeledMoney(normalized, /profit|income|earnings/i) || moneyTokens[2]),
    price: parsePriceLike(moneyTokens[0]),
    changePct: firstFinite(percentages),
    dividendYield: firstFinite([...normalized.matchAll(/(?:dividend|yield)\s*[: ]?\s*([-+]?\d+(?:\.\d+)?)%/gi)].map((match) => parseNumber(match[1]))) ?? (percentages.length ? percentages.at(-1) : null),
    pe,
  };
}

function scoreRecord(row, source = {}) {
  const rankBoost = Math.max(0, 24 - Math.min(row.rank || 120, 120) * 0.18);
  const metricBoost = (Number.isFinite(row.revenue) ? 5 : 0)
    + (Number.isFinite(row.marketCap) ? 4 : 0)
    + (Number.isFinite(row.profit) ? 3 : 0)
    + (Number.isFinite(row.dividendYield) && row.dividendYield > 0 ? 2 : 0);
  const valuationAdjustment = Number.isFinite(row.pe) && row.pe > 0
    ? row.pe < 25 ? 4 : row.pe > 50 ? -4 : 0
    : 0;
  const sourceBoost = ((source.weight || 0.7) - 0.65) * 20;
  return clampScore(50 + rankBoost + metricBoost + valuationAdjustment + sourceBoost);
}

function sourceList() {
  return INDUSTRY_SOURCES.map((source) => ({
    name: source.label,
    type: source.metricMode,
    provider: source.provider,
    focus: source.focus,
    url: source.url,
  }));
}

function summarizeSources(records) {
  const bySource = new Map();
  for (const record of records) {
    const current = bySource.get(record.sourceId) || {
      sourceId: record.sourceId,
      sourceLabel: record.sourceLabel,
      provider: record.provider,
      signals: 0,
      averageScore: 0,
      visibleTickers: 0,
      revenueRows: 0,
      topCompanies: [],
    };
    current.signals += 1;
    current.averageScore += record.signalScore;
    current.visibleTickers += record.symbol ? 1 : 0;
    current.revenueRows += Number.isFinite(record.revenue) ? 1 : 0;
    current.topCompanies.push(record.symbol || record.companyName);
    bySource.set(record.sourceId, current);
  }
  return [...bySource.values()].map((item) => ({
    ...item,
    averageScore: clampScore(item.averageScore / item.signals),
    topCompanies: item.topCompanies.slice(0, 8),
  })).sort((a, b) => b.averageScore - a.averageScore);
}

function compactRecord(record) {
  return {
    rank: record.rank,
    symbol: record.symbol,
    companyName: record.companyName,
    provider: record.provider,
    sourceLabel: record.sourceLabel,
    focus: record.focus,
    metricMode: record.metricMode,
    signalScore: record.signalScore,
    marketCapRaw: record.marketCapRaw,
    revenueRaw: record.revenueRaw,
    profitRaw: record.profitRaw,
    pe: record.pe,
    dividendYield: record.dividendYield,
    price: record.price,
    changePct: record.changePct,
    companyUrl: record.companyUrl,
    sourceUrl: record.sourceUrl,
    reason: record.reason,
  };
}

function sourceCaveat(source = {}) {
  if (source.provider === 'fortune') return 'Fortune 500 is a revenue-ranking discovery source for large U.S. companies; it is not household-goods-specific and may require corroboration from filings and company reports.';
  if (source.provider === 'yahoo-finance') return 'Yahoo Finance industry pages are scraped/unsupported consumer pages; verify market data and fundamentals with primary or broker-grade sources.';
  return 'Scraped industry ranking rows are discovery/comparison evidence and should be verified against SEC filings, company reports, broker/Finnhub quotes, and independent news before trading.';
}

function looksLikeCompanyRow(text) {
  const normalized = cleanText(text);
  return normalized.length >= 5
    && normalized.length <= 2200
    && !/^(rank|company|symbol|market cap|revenue|profit|stock price)$/i.test(normalized)
    && (/\b[A-Z][A-Z0-9.-]{0,7}\b/.test(normalized) || /\$\s*\d/.test(normalized) || /\b(revenue|market cap|profit|dividend|fortune 500)\b/i.test(normalized));
}

function findSymbol({ links = [], cells = [], rowText = '', source = {} }) {
  for (const link of links) {
    const fromHref = symbolFromHref(link.href, source.provider);
    if (fromHref) return fromHref;
    const fromText = cleanSymbol(link.text);
    if (fromText) return fromText;
  }
  for (const cell of cells) {
    const symbol = cleanSymbol(cell);
    if (symbol) return symbol;
  }
  const parenSymbol = cleanText(rowText).match(/\(([A-Z][A-Z0-9.-]{0,7})\)/);
  if (parenSymbol) return cleanSymbol(parenSymbol[1]);
  return '';
}

function findCompanyName({ links = [], cells = [], rowText = '', source = {} }) {
  const linkName = links.map((link) => cleanCompanyName(link.text)).find(Boolean);
  if (linkName) return linkName;
  const cellName = cells.map(cleanCompanyName).find(Boolean);
  if (cellName) return cellName;
  const beforeTicker = cleanText(rowText).split(/\s+[A-Z][A-Z0-9.-]{0,7}\s+/)[0];
  return cleanCompanyName(beforeTicker);
}

function symbolFromHref(href = '', provider = '') {
  const value = String(href || '');
  const patterns = provider === 'stockanalysis'
    ? [/\/stocks\/([a-z0-9.-]+)\//i]
    : provider === 'yahoo-finance'
      ? [/\/quote\/([A-Z0-9.-]+)/i]
      : [/\/([A-Z0-9.-]+)\/?$/i, /\/companies\/[^/]+\/([A-Z0-9.-]+)\//i];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const symbol = cleanSymbol(match?.[1] || '');
    if (symbol) return symbol;
  }
  return '';
}

function nearestRecordText($, anchor, needle) {
  let current = $(anchor);
  for (let depth = 0; depth < 7; depth += 1) {
    current = current.parent();
    if (!current.length) break;
    const text = cleanText(current.text());
    if (text.includes(needle) && text.length <= 2400 && looksLikeCompanyRow(text)) return text;
  }
  return cleanText($(anchor).text());
}

function labeledMoney(text, labelPattern) {
  const escaped = String(text || '');
  const match = escaped.match(new RegExp(`${labelPattern.source}[^$]{0,80}(\\$\\s*[-+]?\\d+(?:,\\d{3})*(?:\\.\\d+)?\\s*[KMBT]?)`, 'i'));
  return match?.[1] || '';
}

function parseRank(value) {
  const match = String(value || '').match(/#?\s*(\d{1,4})\b/);
  return match ? Number(match[1]) : null;
}

function parseAbbreviatedMoney(value) {
  const match = String(value || '').replace(/,/g, '').match(/\$?\s*([-+]?\d+(?:\.\d+)?)\s*([KMBT])?/i);
  if (!match) return null;
  const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 };
  return Number(match[1]) * (multipliers[match[2]?.toUpperCase()] || 1);
}

function parsePriceLike(value) {
  const parsed = parseAbbreviatedMoney(value);
  return parsed > 0 && parsed < 100000 ? parsed : null;
}

function parseNumber(value) {
  const parsed = Number(String(value || '').replace(/[$,%]/g, '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function absolutize(href, baseUrl) {
  try {
    return new URL(href, baseUrl || STOCK_ANALYSIS_HOUSEHOLD_PERSONAL_URL).toString();
  } catch {
    return baseUrl || null;
  }
}

function namesOverlap(a, b) {
  const left = new Set(cleanText(a).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !COMPANY_STOP_WORDS.has(word)));
  const right = new Set(cleanText(b).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !COMPANY_STOP_WORDS.has(word)));
  return [...left].some((word) => right.has(word));
}

const COMPANY_STOP_WORDS = new Set(['inc', 'corp', 'corporation', 'company', 'co', 'ltd', 'plc', 'holdings', 'group', 'class', 'common', 'stock']);

function cleanCompanyName(value) {
  const text = cleanText(value)
    .replace(/\(([A-Z][A-Z0-9.-]{0,7})\)/g, '')
    .replace(/^#?\d+\s*/, '')
    .replace(/\s+\$\s*\d.*$/, '')
    .replace(/\s+(Market Cap|Revenue|Profit|P\/?E|Dividend).*$/i, '')
    .trim();
  if (!text || cleanSymbol(text) || text.length < 2 || /^\d/.test(text)) return '';
  return text.slice(0, 180);
}

function cleanSymbol(value) {
  const symbol = cleanText(value).toUpperCase().replace(/[^A-Z0-9.-]/g, '');
  return /^[A-Z][A-Z0-9.-]{0,7}$/.test(symbol) && !COMMON_NON_SYMBOLS.has(symbol) ? symbol : '';
}

const COMMON_NON_SYMBOLS = new Set(['USD', 'USA', 'US', 'NYSE', 'NASDAQ', 'AMEX', 'ETF', 'PE', 'CEO', 'CFO']);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
  STOCK_ANALYSIS_HOUSEHOLD_PERSONAL_URL,
  YAHOO_HOUSEHOLD_PERSONAL_URL,
  COMPANIES_MARKET_CAP_CONSUMER_GOODS_REVENUE_URL,
  FORTUNE_500_URL,
  INDUSTRY_SOURCES,
  collectConsumerGoodsIndustryContext,
  parseIndustryRows,
  evaluateConsumerGoodsIndustryContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
