const logger = require('../../utils/logger');
const { config } = require('../../config');

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const FACTS_URL = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

let tickerCache = null;
let tickerCacheAt = 0;
const TICKER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Concepts used for the value/quality feature derivation. Each is either an
// "instant" XBRL fact (balance-sheet-style, has only `end`) or a "duration"
// fact (income-statement-style, has `start`/`end` spanning a period).
const CONCEPTS = {
  Revenues: 'duration',
  NetIncomeLoss: 'duration',
  OperatingIncomeLoss: 'duration',
  EarningsPerShareDiluted: 'duration',
  Assets: 'instant',
  Liabilities: 'instant',
  StockholdersEquity: 'instant',
  CashAndCashEquivalentsAtCarryingValue: 'instant',
  CommonStockSharesOutstanding: 'instant',
};

function requireUserAgent() {
  const userAgent = config.secEdgarUserAgent;
  if (!userAgent) {
    throw new Error(
      'SEC_EDGAR_USER_AGENT is not configured. SEC requires a descriptive User-Agent ' +
        '(e.g. "AutoTrader research contact@example.com") on every request — see ' +
        'https://www.sec.gov/os/webmaster-faq#developers. Refusing to send an anonymous request.'
    );
  }
  return userAgent;
}

async function fetchJson(url) {
  const userAgent = requireUserAgent();
  const res = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`SEC EDGAR request failed: ${res.status} ${url}`);
  return res.json();
}

async function getCompanyTickers({ force = false } = {}) {
  const now = Date.now();
  if (!force && tickerCache && now - tickerCacheAt < TICKER_CACHE_TTL_MS) return tickerCache;
  const data = await fetchJson(TICKERS_URL);
  const map = new Map();
  for (const entry of Object.values(data || {})) {
    if (!entry?.ticker || entry.cik_str === undefined) continue;
    map.set(String(entry.ticker).toUpperCase(), {
      cik: padCik(entry.cik_str),
      title: entry.title || null,
    });
  }
  tickerCache = map;
  tickerCacheAt = now;
  return map;
}

function padCik(cikStr) {
  return String(cikStr).padStart(10, '0');
}

async function getCik(symbol) {
  const tickers = await getCompanyTickers();
  return tickers.get(String(symbol).toUpperCase()) || null;
}

async function getCompanyFacts(cik) {
  return fetchJson(FACTS_URL(cik));
}

/**
 * Picks the most recently *filed* fact for a concept rather than the most
 * recent fiscal period end — the filing date is what makes a fact point-in-time
 * safe, since the value wasn't publicly knowable before it was filed.
 */
function pickLatestFact(companyFacts, concept) {
  const node = companyFacts?.facts?.['us-gaap']?.[concept];
  const units = node?.units?.USD || node?.units?.['USD/shares'] || node?.units?.shares;
  if (!units || !units.length) return null;
  const sorted = units
    .filter((item) => item.filed && item.val !== undefined && item.val !== null)
    .slice()
    .sort((a, b) => String(b.filed).localeCompare(String(a.filed)));
  return sorted[0] || null;
}

async function getFundamentalFacts(symbol) {
  const identity = await getCik(symbol);
  if (!identity) {
    logger.warn('No SEC EDGAR CIK found for symbol', { symbol });
    return null;
  }
  const companyFacts = await getCompanyFacts(identity.cik);
  const facts = {};
  let latestFiledAt = null;
  for (const [concept, kind] of Object.entries(CONCEPTS)) {
    const fact = pickLatestFact(companyFacts, concept);
    if (!fact) continue;
    facts[concept] = { value: fact.val, filedAt: fact.filed, periodEnd: fact.end, form: fact.form, kind };
    if (!latestFiledAt || fact.filed > latestFiledAt) latestFiledAt = fact.filed;
  }
  return {
    symbol: String(symbol).toUpperCase(),
    cik: identity.cik,
    title: identity.title,
    facts,
    availableAt: latestFiledAt ? new Date(latestFiledAt).toISOString() : null,
    raw: companyFacts,
  };
}

module.exports = {
  getCompanyTickers,
  getCik,
  getCompanyFacts,
  getFundamentalFacts,
  pickLatestFact,
  CONCEPTS,
};
