const { config } = require('../../config');
const logger = require('../../utils/logger');

const BASE_URL = 'https://finnhub.io/api/v1';

async function get(path, params = {}, apiKey = config.finnhubApiKey) {
  if (!apiKey) {
    throw new Error('FINNHUB_API_KEY is not configured');
  }
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('token', apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Finnhub request failed: ${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
}

/** @returns {Promise<{symbol: string, current: number, high: number, low: number, open: number, prevClose: number}>} */
async function getQuote(symbol, apiKey) {
  const data = await get('/quote', { symbol }, apiKey);
  return {
    symbol,
    current: data.c,
    high: data.h,
    low: data.l,
    open: data.o,
    prevClose: data.pc,
    changePct: data.pc ? ((data.c - data.pc) / data.pc) * 100 : 0,
  };
}

async function getQuotes(symbols, { apiKey } = {}) {
  const results = [];
  for (const symbol of symbols) {
    try {
      results.push(await getQuote(symbol, apiKey));
    } catch (err) {
      logger.error(`Failed to fetch quote for ${symbol}`, { error: err.message });
    }
  }
  return results;
}

module.exports = { getQuote, getQuotes };
