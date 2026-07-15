const { resilientFetch } = require('../utils/resilientFetch');
const cheerio = require('cheerio');

const WALLSTREETZEN_HOME_URL = 'https://www.wallstreetzen.com/';
const WALLSTREETZEN_STOCK_SCREENER_URL = 'https://www.wallstreetzen.com/stock-screener';
const WALLSTREETZEN_STOCK_RATINGS_URL = 'https://www.wallstreetzen.com/stock-ratings';

const WALLSTREETZEN_SCREENS = [
  {
    id: 'stock-screener',
    label: 'Stock Screener',
    url: WALLSTREETZEN_STOCK_SCREENER_URL,
    stance: 'attention',
    weight: 0.68,
    category: 'quant-screener',
  },
  {
    id: 'stock-ratings',
    label: 'Stock Ratings',
    url: WALLSTREETZEN_STOCK_RATINGS_URL,
    stance: 'bullish',
    weight: 0.74,
    category: 'zen-ratings',
  },
];

async function collectWallStreetZenContext({
  timeoutMs = 8000,
  limit = 12,
  screenIds,
  includeTickerPages = false,
  companySymbols = [],
  onEvent = () => {},
} = {}) {
  const selectedIds = new Set((Array.isArray(screenIds) ? screenIds : []).filter(Boolean));
  const screens = selectedIds.size
    ? WALLSTREETZEN_SCREENS.filter((screen) => selectedIds.has(screen.id))
    : WALLSTREETZEN_SCREENS;
  const boundedLimit = clampInt(limit, 1, 50);

  const settled = await Promise.allSettled(screens.map(async (screen) => {
    const html = await fetchHtml(screen.url, timeoutMs);
    const rows = parseMarketRows(html, screen).slice(0, boundedLimit);
    emit(onEvent, 'wallstreetzen-research', 40, 'debug', 'Fetched WallStreetZen research page.', {
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
      emit(onEvent, 'wallstreetzen-research', 40, 'warn', 'WallStreetZen page unavailable; continuing with remaining sources.', {
        screen: screen.id,
        url: screen.url,
        error: result.reason.message,
      });
    }
  });

  let tickerPages = [];
  if (includeTickerPages) {
    const symbols = [...new Set([
      ...normalizeSymbolList(companySymbols),
      ...screenResults.flatMap((result) => (result.rows || []).map((row) => row.symbol)),
    ])].slice(0, Math.min(boundedLimit, 12));
    tickerPages = await collectTickerPages({ symbols, screenResults, timeoutMs, onEvent, failures });
  }

  return evaluateWallStreetZenContext({ screenResults, tickerPages, failures });
}

function parseMarketRows(html, screen = {}) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();

  $('a[href*="/stocks/us/"]').each((_, anchor) => {
    const href = $(anchor).attr('href') || '';
    const parsed = extractStockFromHref(href);
    const symbol = cleanSymbol(parsed.symbol || $(anchor).text());
    if (!symbol || seen.has(`${screen.id}:${symbol}`)) return;
    const rowText = nearestRecordText($, anchor, symbol);
    const fields = extractScreenerFields(rowText, symbol);
    rows.push({
      symbol,
      exchange: parsed.exchange,
      companyName: fields.companyName || findCompanyName($, anchor, href, symbol, rowText),
      industry: fields.industry,
      zenRating: fields.zenRating,
      recommendation: fields.recommendation,
      price: fields.price,
      changePct: fields.changePct,
      marketCapRaw: fields.marketCapRaw,
      marketCap: parseAbbreviatedNumber(fields.marketCapRaw),
      pe: fields.pe,
      debtEquity: fields.debtEquity,
      country: fields.country,
      screenId: screen.id,
      signal: screen.label,
      category: screen.category,
      stance: inferStance(fields.zenRating, fields.recommendation, screen),
      signalScore: scoreScreenerRecord(screen, fields),
      quoteUrl: absolutize(href),
      sourceUrl: screen.url,
      rowText: rowText.slice(0, 800),
      reason: `${screen.label} WallStreetZen quantitative signal${fields.zenRating ? ` with Zen Rating ${fields.zenRating}${fields.recommendation ? ` ${fields.recommendation}` : ''}` : ''}.`,
    });
    seen.add(`${screen.id}:${symbol}`);
  });

  return rows;
}

function evaluateWallStreetZenContext({ screenResults = [], tickerPages = [], failures = [] } = {}) {
  const records = screenResults.flatMap((result) => result.rows || []);
  const bullish = records.filter((item) => ['bullish', 'attention'].includes(item.stance));
  const bearish = records.filter((item) => item.stance === 'bearish');
  const rated = records.filter((item) => item.zenRating);
  const tickerRated = tickerPages.filter((item) => item.zenRating);
  const uniqueSymbols = [...new Set(records.map((item) => item.symbol))];
  const quantScore = average([...records.map((item) => item.signalScore), ...tickerPages.map((item) => ratingScore(item.zenRating))]);
  const pageScore = average(tickerPages.map((page) => scoreTickerPage(page)));
  const opportunityScore = clampScore(48 + (quantScore - 50) * 0.42 + (pageScore - 50) * 0.22 + bullish.length * 0.75 + tickerRated.length * 0.45);
  const riskScore = clampScore(49 + bearish.length * 1.8 + failures.length * 2 - (quantScore - 50) * 0.18);
  const momentum = opportunityScore >= 64 ? 'wallstreetzen-quant-positive'
    : riskScore >= 62 ? 'wallstreetzen-quant-negative'
      : 'wallstreetzen-mixed';

  return {
    available: records.length > 0 || tickerPages.length > 0,
    fetchedAt: new Date().toISOString(),
    provider: 'wallstreetzen',
    quoteDelayNote: 'WallStreetZen public screener, stock-rating, and ticker pages are scraped and may be delayed, paywalled, summarized, or markup-variable; treat Zen Ratings and analysis summaries as market-discovery evidence and verify with filings, broker/Finnhub quotes, primary company data, and independent news before trading.',
    sourceList: sourceList(),
    failures,
    screenCount: screenResults.length,
    signalCount: records.length,
    uniqueSymbolCount: uniqueSymbols.length,
    bullishCount: bullish.length,
    bearishCount: bearish.length,
    ratedCount: rated.length,
    tickerPageCount: tickerPages.length,
    quantScore,
    opportunityScore,
    riskScore,
    momentum,
    records,
    tickerPages,
    topRated: [...records].sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    topPositive: bullish.sort((a, b) => b.signalScore - a.signalScore).slice(0, 12),
    topNegative: bearish.sort((a, b) => a.signalScore - b.signalScore).slice(0, 12),
    tickerSummaries: tickerPages.slice(0, 12),
    narrative: records.length || tickerPages.length
      ? `WallStreetZen ${momentum}: ${records.length} screener/rating rows, ${rated.length} visible Zen ratings, ${tickerPages.length} ticker-page summaries. Opportunity ${opportunityScore}, risk ${riskScore}.`
      : 'WallStreetZen context unavailable; public pages may be blocked, throttled, client-rendered, or changed.',
  };
}

function scoreCandidate({ candidate, wallStreetZenContext }) {
  if (!wallStreetZenContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, signals: [], tickerPages: [], explanation: 'WallStreetZen context unavailable.' };
  }
  const symbol = cleanSymbol(candidate?.symbol);
  const signals = (wallStreetZenContext.records || []).filter((item) => item.symbol === symbol);
  const tickerPages = (wallStreetZenContext.tickerPages || []).filter((item) => item.symbol === symbol);
  if (!signals.length && !tickerPages.length) {
    return {
      normalized: 0.5,
      compositeScore: 50,
      exposure: 10,
      signals: [],
      tickerPages: [],
      explanation: `${symbol || 'Candidate'} did not appear in current WallStreetZen screener/rating rows or requested ticker-page summaries.`,
    };
  }

  const bullish = signals.filter((item) => ['bullish', 'attention'].includes(item.stance));
  const bearish = signals.filter((item) => item.stance === 'bearish');
  const signalAverage = average(signals.map((item) => item.signalScore));
  const pageAverage = average(tickerPages.map((page) => scoreTickerPage(page)));
  const exposure = clamp01(0.34 + signals.length * 0.12 + tickerPages.length * 0.08);
  const raw = 0.5
    + ((signalAverage - 50) / 100) * exposure
    + ((pageAverage - 50) / 100) * Math.min(0.28, exposure)
    + (bullish.length - bearish.length) * 0.025;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    signals: signals.slice(0, 8),
    tickerPages: tickerPages.slice(0, 8),
    explanation: `WallStreetZen quantitative signals for ${symbol || candidate?.companyName || 'candidate'}: ${signals.map((item) => `${item.zenRating || item.signal}${item.recommendation ? `/${item.recommendation}` : ''}`).join(', ') || 'no direct screener row'}${tickerPages.length ? '; ticker-page Zen/components summary available' : ''}. Verify scraped WallStreetZen ratings with filings, broker/Finnhub quotes, primary company data, and independent news before live orders.`,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'wallstreetzen',
    fetchedAt: context.fetchedAt,
    momentum: context.momentum,
    opportunityScore: context.opportunityScore,
    riskScore: context.riskScore,
    quantScore: context.quantScore,
    signalCount: context.signalCount || 0,
    bullishCount: context.bullishCount || 0,
    bearishCount: context.bearishCount || 0,
    ratedCount: context.ratedCount || 0,
    tickerPageCount: context.tickerPageCount || 0,
    topRated: (context.topRated || []).slice(0, 8).map(compactRecord),
    topPositive: (context.topPositive || []).slice(0, 8).map(compactRecord),
    topNegative: (context.topNegative || []).slice(0, 8).map(compactRecord),
    tickerSummaries: (context.tickerSummaries || []).slice(0, 8).map(compactTickerPage),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.quoteDelayNote || 'Scraped WallStreetZen pages should be verified with filings, market-data providers, and independent news before trading.',
    bmclUse: 'Use as scraped WallStreetZen quantitative-rating, component-grade, valuation/financial-summary, screener, and analyst-rating discovery evidence. Share compact Zen Rating and ticker-summary rows for candidate generation, self-improvement, and council debate, then corroborate with SEC/company filings, broker/Finnhub quotes, Nasdaq Trader/security-master data, GDELT/Google News, and official sources before live scoring or orders.',
  };
}

async function collectTickerPages({ symbols, screenResults, timeoutMs, onEvent, failures }) {
  const exchangeBySymbol = new Map();
  for (const row of screenResults.flatMap((result) => result.rows || [])) {
    if (row.symbol && row.exchange) exchangeBySymbol.set(row.symbol, row.exchange);
  }
  const pages = [];
  const settled = await Promise.allSettled(symbols.map(async (symbol) => {
    const exchange = exchangeBySymbol.get(symbol) || 'NASDAQ';
    const url = tickerUrl(symbol, exchange);
    const html = await fetchHtml(url, timeoutMs);
    const page = parseTickerPage(html, { symbol, exchange, url });
    emit(onEvent, 'wallstreetzen-ticker-page', 41, 'debug', 'Fetched WallStreetZen ticker page.', {
      symbol,
      exchange,
      url,
      zenRating: page.zenRating,
    });
    return page;
  }));

  settled.forEach((result, index) => {
    const symbol = symbols[index];
    if (result.status === 'fulfilled') {
      pages.push(result.value);
    } else {
      failures.push({ screen: 'ticker-page', url: tickerUrl(symbol), error: result.reason.message });
      emit(onEvent, 'wallstreetzen-ticker-page', 41, 'warn', 'WallStreetZen ticker page unavailable; continuing with remaining pages.', {
        symbol,
        error: result.reason.message,
      });
    }
  });
  return pages;
}

function parseTickerPage(html, { symbol, exchange, url } = {}) {
  const $ = cheerio.load(String(html || ''));
  $('script, style, noscript, svg').remove();
  const text = cleanText($('main').text() || $('body').text());
  const fields = extractTickerFields(text, symbol);
  return {
    symbol: cleanSymbol(symbol) || fields.symbol,
    exchange: cleanText(exchange || fields.exchange).toUpperCase(),
    url,
    pageType: 'ticker-analysis',
    companyName: fields.companyName,
    price: fields.price,
    fairValuePrice: fields.fairValuePrice,
    marketCapRaw: fields.marketCapRaw,
    marketCap: parseAbbreviatedNumber(fields.marketCapRaw),
    pe: fields.pe,
    pb: fields.pb,
    ps: fields.ps,
    peg: fields.peg,
    dividendYield: fields.dividendYield,
    revenueRaw: fields.revenueRaw,
    earningsRaw: fields.earningsRaw,
    profitMargin: fields.profitMargin,
    debtEquity: fields.debtEquity,
    beta: fields.beta,
    nextEarnings: fields.nextEarnings,
    zenRating: fields.zenRating,
    recommendation: fields.recommendation,
    componentGrades: fields.componentGrades,
    industry: fields.industry,
    industryRating: fields.industryRating,
    snippet: text.slice(0, 1600),
    score: scoreTickerPage({ ...fields }),
  };
}

async function fetchHtml(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 AutoTrader WallStreetZen research bot; contact=local',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers, redirect: 'follow' }, { bucket: 'wallstreetzen', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return [
    { name: 'WallStreetZen home', type: 'wallstreetzen-home', url: WALLSTREETZEN_HOME_URL },
    { name: 'WallStreetZen stock screener', type: 'wallstreetzen-stock-screener', url: WALLSTREETZEN_STOCK_SCREENER_URL },
    { name: 'WallStreetZen analyst ratings', type: 'wallstreetzen-stock-ratings', url: WALLSTREETZEN_STOCK_RATINGS_URL },
    { name: 'WallStreetZen ticker analysis page', type: 'wallstreetzen-ticker-analysis', url: tickerUrl('{ticker}', '{exchange}'), urlPattern: tickerUrl('{ticker}', '{exchange}') },
  ];
}

function compactRecord(record) {
  return {
    symbol: record.symbol,
    exchange: record.exchange,
    companyName: record.companyName,
    industry: record.industry,
    zenRating: record.zenRating,
    recommendation: record.recommendation,
    price: record.price,
    changePct: record.changePct,
    marketCapRaw: record.marketCapRaw,
    pe: record.pe,
    debtEquity: record.debtEquity,
    signal: record.signal,
    category: record.category,
    stance: record.stance,
    signalScore: record.signalScore,
    sourceUrl: record.sourceUrl,
    quoteUrl: record.quoteUrl,
  };
}

function compactTickerPage(page) {
  return {
    symbol: page.symbol,
    exchange: page.exchange,
    companyName: page.companyName,
    zenRating: page.zenRating,
    recommendation: page.recommendation,
    componentGrades: page.componentGrades,
    fairValuePrice: page.fairValuePrice,
    pe: page.pe,
    peg: page.peg,
    profitMargin: page.profitMargin,
    debtEquity: page.debtEquity,
    score: page.score,
    url: page.url,
    snippet: cleanText(page.snippet).slice(0, 420),
  };
}

function extractStockFromHref(href = '') {
  try {
    const parsed = new URL(href, WALLSTREETZEN_HOME_URL);
    const match = parsed.pathname.match(/\/stocks\/us\/([^/]+)\/([^/?#]+)/i);
    return { exchange: cleanText(match?.[1] || '').toUpperCase(), symbol: match?.[2] || '' };
  } catch {
    const match = String(href || '').match(/\/stocks\/us\/([^/]+)\/([^/?#]+)/i);
    return { exchange: cleanText(match?.[1] || '').toUpperCase(), symbol: match?.[2] || '' };
  }
}

function extractScreenerFields(rowText, symbol) {
  const text = cleanText(rowText);
  const ratingMatch = text.match(/\b([A-F])\s+(Strong Buy|Buy|Hold|Sell|Strong Sell)\b/i)
    || text.match(/\b([A-F])\b(?=\s*(?:\$|Unlock|United States|NASDAQ|NYSE|AMEX))/i);
  const dollars = [...text.matchAll(/\$[\d,.]+[KMBT]?/gi)].map((match) => match[0]);
  const percentages = [...text.matchAll(/[-+]?\d+(?:\.\d+)?%/g)].map((match) => parseNumber(match[0]));
  const ratios = [...text.matchAll(/\b\d+(?:\.\d+)?x\b/gi)].map((match) => parseNumber(match[0]));
  return {
    companyName: extractCompanyNameFromRow(text, symbol),
    industry: extractIndustry(text),
    zenRating: ratingMatch ? ratingMatch[1].toUpperCase() : '',
    recommendation: ratingMatch?.[2] ? normalizeRecommendation(ratingMatch[2]) : '',
    marketCapRaw: dollars.find((value) => /[BT]$/i.test(value)) || '',
    price: dollars.length >= 2 ? parseNumber(dollars[1]) : parseNumber(dollars[0]),
    changePct: percentages[0] ?? null,
    pe: ratios[0] ?? null,
    debtEquity: ratios.length > 1 ? ratios[ratios.length - 1] : null,
    country: /United States/i.test(text) ? 'United States' : '',
  };
}

function extractTickerFields(text, symbol) {
  const ratingMatch = text.match(/Zen Rating.*?\b([A-F])\s+(Strong Buy|Buy|Hold|Sell|Strong Sell)\b/i)
    || text.match(/\b([A-F])\s+(Strong Buy|Buy|Hold|Sell|Strong Sell)\b/i);
  const componentGrades = {};
  for (const component of ['Value', 'Growth', 'Momentum', 'Sentiment', 'Safety', 'Financials', 'Artificial Intelligence']) {
    const match = new RegExp(`\\b([A-F])\\s+${escapeRegExp(component)}\\b`, 'i').exec(text);
    if (match) componentGrades[component.toLowerCase().replace(/\s+/g, '')] = match[1].toUpperCase();
  }
  return {
    symbol: cleanSymbol(symbol) || cleanSymbol(text.match(/\bNASDAQ:\s*([A-Z0-9.-]+)\b/i)?.[1]),
    exchange: cleanText(text.match(/\b(NASDAQ|NYSE|AMEX):\s*[A-Z0-9.-]+\b/i)?.[1]).toUpperCase(),
    companyName: cleanText(text.match(new RegExp(`${escapeRegExp(symbol || '')}\\s+([^#]{2,80}? Stock)`, 'i'))?.[1]).replace(/\s+Stock$/i, ''),
    price: labeledMoney(text, `${symbol || ''} Price`) || labeledMoney(text, 'Price') || null,
    fairValuePrice: labeledMoney(text, 'Fair Value Price'),
    marketCapRaw: labeledRawMoney(text, 'Market Cap'),
    pe: labeledNumber(text, 'P/E'),
    pb: labeledNumber(text, 'P/B'),
    ps: labeledNumber(text, 'P/S'),
    peg: labeledNumber(text, 'PEG'),
    dividendYield: labeledPercent(text, 'Dividend Yield'),
    revenueRaw: labeledRawMoney(text, 'Revenue'),
    earningsRaw: labeledRawMoney(text, 'Earnings'),
    profitMargin: labeledPercent(text, 'Profit Margin'),
    debtEquity: labeledNumber(text, 'Debt to Equity'),
    beta: labeledNumber(text, 'Beta'),
    nextEarnings: cleanText(text.match(/Next Earnings\s+([A-Z][a-z]{2,8}\s+\d{1,2},\s+20\d{2})/)?.[1]),
    zenRating: ratingMatch ? ratingMatch[1].toUpperCase() : '',
    recommendation: ratingMatch?.[2] ? normalizeRecommendation(ratingMatch[2]) : '',
    componentGrades,
    industry: cleanText(text.match(/Industry\s*:\s*([A-Za-z&\-\s]+?)\s+Industry Rating/i)?.[1]),
    industryRating: cleanText(text.match(/Industry Rating\s+([A-F])\b/i)?.[1]).toUpperCase(),
  };
}

function scoreTickerPage(page = {}) {
  const rating = ratingScore(page.zenRating);
  const components = Object.values(page.componentGrades || {}).map(ratingScore);
  const componentScore = average(components);
  const valuationPenalty = Number.isFinite(page.pe) && page.pe > 60 ? 5 : 0;
  const leveragePenalty = Number.isFinite(page.debtEquity) && page.debtEquity > 3 ? 4 : 0;
  return clampScore(rating * 0.55 + componentScore * 0.35 + 5 - valuationPenalty - leveragePenalty);
}

function scoreScreenerRecord(screen, fields = {}) {
  const rating = ratingScore(fields.zenRating);
  const move = Number.isFinite(fields.changePct) ? clamp(fields.changePct, -12, 12) : 0;
  const ratioPenalty = Number.isFinite(fields.pe) && fields.pe > 80 ? 5 : 0;
  return clampScore(rating + move * 0.55 + (screen.weight - 0.68) * 18 - ratioPenalty);
}

function ratingScore(rating) {
  const map = { A: 82, B: 68, C: 52, D: 34, F: 20 };
  return map[cleanText(rating).toUpperCase()] ?? 50;
}

function inferStance(zenRating, recommendation, screen = {}) {
  const rating = cleanText(zenRating).toUpperCase();
  const rec = cleanText(recommendation).toLowerCase();
  if (['A', 'B'].includes(rating) || /strong buy|buy/.test(rec)) return 'bullish';
  if (['D', 'F'].includes(rating) || /sell/.test(rec)) return 'bearish';
  return screen.stance || 'attention';
}

function nearestRecordText($, anchor, needle) {
  const rowText = nodeText($, $(anchor).closest('tr'));
  if (rowText.includes(needle) && rowText.length > cleanText($(anchor).text()).length) return rowText;
  let current = $(anchor);
  for (let depth = 0; depth < 7; depth += 1) {
    current = current.parent();
    if (!current.length) break;
    const text = nodeText($, current);
    if (text.includes(needle) && text.length <= 3000 && /(Zen Rating|Market Cap|P\/E|D\/E|Unlock|\$|NASDAQ|NYSE|AMEX|Strong Buy|Buy|Hold|Sell)/i.test(text)) {
      return text;
    }
  }
  return rowText || nodeText($, $(anchor).parent());
}

function findCompanyName($, anchor, href, symbol, rowText = '') {
  const linkTexts = $(anchor).closest('tr,div,li').find(`a[href="${href}"]`).toArray()
    .map((link) => cleanText($(link).text()))
    .filter((text) => text && cleanSymbol(text) !== symbol && !/stock|rating|screener/i.test(text));
  return linkTexts[0] || extractCompanyNameFromRow(rowText, symbol);
}

function extractCompanyNameFromRow(text, symbol) {
  const parts = cleanText(text).split(/\s+\|\s+/).map(cleanText).filter(Boolean);
  const symbolIndex = parts.findIndex((part) => cleanSymbol(part) === cleanSymbol(symbol));
  if (symbolIndex >= 0 && parts[symbolIndex + 1] && !isTicker(parts[symbolIndex + 1])) {
    return parts[symbolIndex + 1];
  }
  const match = new RegExp(`\\b${escapeRegExp(symbol)}\\b\\s+([A-Z][A-Z0-9&.,'\\-\\s]{2,80}?)(?:\\s+(NASDAQ|NYSE|AMEX)\\b|\\s+\\$|\\s+Unlock)`, 'i').exec(text);
  return cleanText(match?.[1]).replace(/\s+(CORP|INC|CO|LTD)$/i, (suffix) => suffix.toUpperCase());
}

function extractIndustry(text) {
  const match = text.match(/\b(NASDAQ|NYSE|AMEX)\s+([A-Za-z][A-Za-z&\-\s]{3,60}?)(?:\s+Unlock|\s+\$|\s+[A-F]\b)/);
  return cleanText(match?.[2]);
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

function labeledMoney(text, label) {
  return parseNumber(labeledRawMoney(text, label));
}

function labeledRawMoney(text, label) {
  const match = new RegExp(`${escapeRegExp(label)}\\s*\\ufeff?\\s*(\\$[\\d,.]+[KMBT]?)`, 'i').exec(text);
  return cleanText(match?.[1]);
}

function labeledNumber(text, label) {
  const match = new RegExp(`${escapeRegExp(label)}\\s*\\ufeff?\\s*([-+]?\\d+(?:\\.\\d+)?)(?:x)?`, 'i').exec(text);
  return parseNumber(match?.[1]);
}

function labeledPercent(text, label) {
  const match = new RegExp(`${escapeRegExp(label)}\\s*\\ufeff?\\s*([-+]?\\d+(?:\\.\\d+)?)%`, 'i').exec(text);
  return parseNumber(match?.[1]);
}

function tickerUrl(symbol, exchange = 'NASDAQ') {
  return `${WALLSTREETZEN_HOME_URL}stocks/us/${String(exchange || 'NASDAQ').toLowerCase()}/${String(symbol || '').toLowerCase()}`;
}

function normalizeSymbolList(symbols) {
  return (Array.isArray(symbols) ? symbols : [symbols]).map(cleanSymbol).filter(Boolean);
}

function absolutize(href) {
  try {
    return new URL(href, WALLSTREETZEN_HOME_URL).toString();
  } catch {
    return href;
  }
}

function normalizeRecommendation(value) {
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
  WALLSTREETZEN_HOME_URL,
  WALLSTREETZEN_STOCK_SCREENER_URL,
  WALLSTREETZEN_STOCK_RATINGS_URL,
  WALLSTREETZEN_SCREENS,
  collectWallStreetZenContext,
  parseMarketRows,
  parseTickerPage,
  evaluateWallStreetZenContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
  tickerUrl,
};
