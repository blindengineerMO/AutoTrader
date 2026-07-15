const { resilientFetch } = require('../../utils/resilientFetch');
const logger = require('../../utils/logger');

async function getYahooQuote(symbol) {
  const url = new URL('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol));
  url.searchParams.set('range', '5d');
  url.searchParams.set('interval', '1d');
  const res = await resilientFetch(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 AutoTrader research bot',
      Accept: 'application/json,text/plain,*/*',
    },
  }, { bucket: 'yahoo' });
  if (!res.ok) throw new Error(`Yahoo chart scrape failed: ${res.status}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  const meta = result?.meta;
  const quote = result?.indicators?.quote?.[0];
  if (!meta || !quote) throw new Error('Yahoo chart response did not include quote data');
  const closes = (quote.close || []).filter((n) => Number.isFinite(n));
  const highs = (quote.high || []).filter((n) => Number.isFinite(n));
  const lows = (quote.low || []).filter((n) => Number.isFinite(n));
  const opens = (quote.open || []).filter((n) => Number.isFinite(n));
  const current = meta.regularMarketPrice || closes.at(-1);
  const prevClose = meta.previousClose || closes.at(-2) || closes.at(-1) || current;
  return {
    symbol,
    current,
    high: highs.at(-1) || current,
    low: lows.at(-1) || current,
    open: opens.at(-1) || prevClose,
    prevClose,
    changePct: prevClose ? ((current - prevClose) / prevClose) * 100 : 0,
  };
}

async function getYahooHistory(symbol, range = '5y', interval = '1mo') {
  const url = new URL('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol));
  url.searchParams.set('range', range);
  url.searchParams.set('interval', interval);
  url.searchParams.set('events', 'split');
  const res = await resilientFetch(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 AutoTrader research bot',
      Accept: 'application/json,text/plain,*/*',
    },
  }, { bucket: 'yahoo' });
  if (!res.ok) throw new Error(`Yahoo historical scrape failed: ${res.status}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  const closes = (quote?.close || []).filter((n) => Number.isFinite(n));
  if (closes.length < 2) throw new Error('Yahoo historical response did not include enough close data');
  const first = closes[0];
  const last = closes.at(-1);
  let peak = first;
  let maxDrawdownPct = 0;
  for (const close of closes) {
    peak = Math.max(peak, close);
    const drawdown = peak ? ((close - peak) / peak) * 100 : 0;
    maxDrawdownPct = Math.min(maxDrawdownPct, drawdown);
  }
  const splitEvents = Object.values(result?.events?.splits || {})
    .map((event) => ({
      date: event.date ? new Date(event.date * 1000).toISOString() : null,
      numerator: Number(event.numerator || 0),
      denominator: Number(event.denominator || 0),
      splitRatio: event.splitRatio || (event.numerator && event.denominator ? `${event.numerator}:${event.denominator}` : null),
    }))
    .filter((event) => event.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const firstTimestamp = timestamps.find((value) => Number.isFinite(value));
  const lastTimestamp = [...timestamps].reverse().find((value) => Number.isFinite(value));
  const years = firstTimestamp && lastTimestamp
    ? Math.max(0.1, (lastTimestamp - firstTimestamp) / (365.25 * 24 * 60 * 60))
    : 5;
  const totalReturnPct = ((last - first) / first) * 100;
  const annualizedReturnPct = (Math.pow(last / first, 1 / years) - 1) * 100;
  return {
    symbol,
    range,
    interval,
    firstClose: first,
    lastClose: last,
    points: closes.length,
    years: Number(years.toFixed(2)),
    fiveYearReturnPct: Number(totalReturnPct.toFixed(2)),
    annualizedReturnPct: Number(annualizedReturnPct.toFixed(2)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    stockSplitsPast5Years: splitEvents.length,
    splitEvents,
  };
}

async function getYahooDailyCloses(symbol, range = '2y') {
  const url = new URL('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol));
  url.searchParams.set('range', range);
  url.searchParams.set('interval', '1d');
  const res = await resilientFetch(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 AutoTrader research bot',
      Accept: 'application/json,text/plain,*/*',
    },
  }, { bucket: 'yahoo' });
  if (!res.ok) throw new Error(`Yahoo daily closes scrape failed: ${res.status}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const closes = (quote?.close || []).filter((n) => Number.isFinite(n));
  if (closes.length < 30) throw new Error('Yahoo daily closes response did not include enough data');
  return closes;
}

async function getStooqQuote(symbol) {
  const normalized = symbol.includes('.') ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(normalized)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await resilientFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 AutoTrader research bot', Accept: 'text/csv,*/*' },
  }, { bucket: 'stooq' });
  if (!res.ok) throw new Error(`Stooq scrape failed: ${res.status}`);
  const text = await res.text();
  const [header, row] = text.trim().split(/\r?\n/);
  if (!header || !row || row.includes('N/D')) throw new Error('Stooq response did not include quote data');
  const values = row.split(',');
  const [sourceSymbol, , , open, high, low, close] = values;
  const current = Number(close);
  const openPrice = Number(open);
  return {
    symbol,
    sourceSymbol,
    current,
    high: Number(high) || current,
    low: Number(low) || current,
    open: openPrice || current,
    prevClose: openPrice || current,
    changePct: openPrice ? ((current - openPrice) / openPrice) * 100 : 0,
  };
}

async function getQuote(symbol) {
  try {
    return await getYahooQuote(symbol);
  } catch (yahooErr) {
    logger.warn('Yahoo scrape quote failed, trying Stooq', { symbol, error: yahooErr.message });
    return getStooqQuote(symbol);
  }
}

async function getQuotes(symbols) {
  const results = [];
  for (const symbol of symbols) {
    try {
      results.push(await getQuote(symbol));
    } catch (err) {
      logger.warn('Scraped quote unavailable', { symbol, error: err.message });
    }
  }
  return results;
}

module.exports = { getQuote, getQuotes, getHistoricalStats: getYahooHistory, getDailyCloses: getYahooDailyCloses };
