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

async function searchSymbol(query, { apiKey } = {}) {
  const data = await get('/search', { q: query }, apiKey);
  return (data.result || []).map((item) => ({
    symbol: item.symbol,
    description: item.description,
    displaySymbol: item.displaySymbol,
    type: item.type,
  }));
}

async function getCompanyProfile(symbol, { apiKey } = {}) {
  return get('/stock/profile2', { symbol }, apiKey);
}

async function getBasicFinancials(symbol, { apiKey, metric = 'all' } = {}) {
  return get('/stock/metric', { symbol, metric }, apiKey);
}

async function getCompanyNews(symbol, { apiKey, from, to } = {}) {
  const today = new Date();
  const start = from || new Date(today.getTime() - 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10);
  const end = to || today.toISOString().slice(0, 10);
  return get('/company-news', { symbol, from: start, to: end }, apiKey);
}

async function getRecommendationTrends(symbol, { apiKey } = {}) {
  return get('/stock/recommendation', { symbol }, apiKey);
}

async function researchCompany(symbol, { apiKey } = {}) {
  const cleanSymbol = String(symbol || '').toUpperCase();
  const result = { symbol: cleanSymbol, available: Boolean(apiKey), errors: [] };
  if (!apiKey || !cleanSymbol) return result;

  const calls = [
    ['quote', () => getQuote(cleanSymbol, apiKey)],
    ['profile', () => getCompanyProfile(cleanSymbol, { apiKey })],
    ['metrics', () => getBasicFinancials(cleanSymbol, { apiKey })],
    ['news', () => getCompanyNews(cleanSymbol, { apiKey })],
    ['recommendations', () => getRecommendationTrends(cleanSymbol, { apiKey })],
  ];
  for (const [key, fn] of calls) {
    try {
      result[key] = await fn();
    } catch (err) {
      result.errors.push({ key, error: err.message });
      logger.warn('Finnhub company research call failed', { symbol: cleanSymbol, key, error: err.message });
    }
  }
  return result;
}

module.exports = {
  getQuote,
  getQuotes,
  searchSymbol,
  getCompanyProfile,
  getBasicFinancials,
  getCompanyNews,
  getRecommendationTrends,
  researchCompany,
};
