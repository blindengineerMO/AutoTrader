const logger = require('../../utils/logger');
const { config } = require('../../config');
const { resilientFetch } = require('../../utils/resilientFetch');

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const FACTS_URL = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
const SUBMISSIONS_URL = (cik) => `https://data.sec.gov/submissions/CIK${cik}.json`;

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

function requireUserAgent(overrideUserAgent) {
  const userAgent = overrideUserAgent || config.secEdgarUserAgent;
  if (!userAgent) {
    throw new Error(
      'SEC_EDGAR_USER_AGENT is not configured. SEC requires a descriptive User-Agent ' +
        '(e.g. "AutoTrader research contact@example.com") on every request — see ' +
        'https://www.sec.gov/os/webmaster-faq#developers. Refusing to send an anonymous request.'
    );
  }
  return userAgent;
}

async function fetchJson(url, { userAgent } = {}) {
  const resolvedUserAgent = requireUserAgent(userAgent);
  const res = await resilientFetch(url, {
    headers: {
      'User-Agent': resolvedUserAgent,
      Accept: 'application/json',
    },
  }, { bucket: 'sec-edgar' });
  if (!res.ok) throw new Error(`SEC EDGAR request failed: ${res.status} ${url}`);
  return res.json();
}

async function getCompanyTickers({ force = false, userAgent } = {}) {
  const now = Date.now();
  if (!force && tickerCache && now - tickerCacheAt < TICKER_CACHE_TTL_MS) return tickerCache;
  const data = await fetchJson(TICKERS_URL, { userAgent });
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
  return String(cikStr).replace(/^CIK/i, '').replace(/\D/g, '').padStart(10, '0');
}

async function getCik(symbol, options = {}) {
  const tickers = await getCompanyTickers(options);
  return tickers.get(String(symbol).toUpperCase()) || null;
}

async function getCompanyFacts(cik, options = {}) {
  return fetchJson(FACTS_URL(padCik(cik)), options);
}

async function getCompanySubmissions(cik, options = {}) {
  return fetchJson(SUBMISSIONS_URL(padCik(cik)), options);
}

async function getSubmissionsBySymbol(symbol, options = {}) {
  const identity = await getCik(symbol, options);
  if (!identity) {
    logger.warn('No SEC EDGAR CIK found for submissions lookup', { symbol });
    return null;
  }
  const submissions = await getCompanySubmissions(identity.cik, options);
  return { identity, submissions };
}

async function getSubmissionSummary(symbol, options = {}) {
  const result = await getSubmissionsBySymbol(symbol, options);
  if (!result) return null;
  return summarizeSubmissions(result.submissions, { symbol, identity: result.identity });
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

async function getFundamentalFacts(symbol, options = {}) {
  const identity = await getCik(symbol, options);
  if (!identity) {
    logger.warn('No SEC EDGAR CIK found for symbol', { symbol });
    return null;
  }
  const companyFacts = await getCompanyFacts(identity.cik, options);
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

function summarizeSubmissions(submissions, { symbol, identity, maxFilings = 40 } = {}) {
  const recentFilings = normalizeRecentFilings(submissions?.filings?.recent, submissions?.cik).slice(0, maxFilings);
  const formCounts = recentFilings.reduce((counts, filing) => {
    counts[filing.form] = (counts[filing.form] || 0) + 1;
    return counts;
  }, {});
  const latestByForm = {};
  for (const form of ['10-K', '10-Q', '8-K', '20-F', '40-F', '6-K', 'S-1', 'DEF 14A', '13F-HR']) {
    latestByForm[form] = recentFilings.find((filing) => filing.form === form) || null;
  }
  const latestFiling = recentFilings[0] || null;
  const latestPeriodic = latestByForm['10-Q'] || latestByForm['10-K'] || latestByForm['20-F'] || latestByForm['40-F'] || null;
  return {
    symbol: String(symbol || submissions?.tickers?.[0] || '').toUpperCase() || null,
    cik: padCik(submissions?.cik || identity?.cik || ''),
    companyName: submissions?.name || identity?.title || null,
    entityType: submissions?.entityType || null,
    sic: submissions?.sic || null,
    sicDescription: submissions?.sicDescription || null,
    tickers: submissions?.tickers || (symbol ? [String(symbol).toUpperCase()] : []),
    exchanges: submissions?.exchanges || [],
    fiscalYearEnd: submissions?.fiscalYearEnd || null,
    stateOfIncorporation: submissions?.stateOfIncorporation || null,
    flags: submissions?.flags || '',
    formerNames: (submissions?.formerNames || []).slice(0, 8),
    latestFiling,
    latestPeriodic,
    latestAnnual: latestByForm['10-K'] || latestByForm['20-F'] || latestByForm['40-F'] || null,
    latestQuarterly: latestByForm['10-Q'] || null,
    latestMaterialEvent: latestByForm['8-K'] || latestByForm['6-K'] || null,
    formCounts,
    recentFilings,
    olderSubmissionFiles: (submissions?.filings?.files || []).slice(0, 12),
    source: {
      name: 'SEC company submissions API',
      url: SUBMISSIONS_URL(padCik(submissions?.cik || identity?.cik || '')),
      tickerDirectoryUrl: TICKERS_URL,
    },
  };
}

function normalizeRecentFilings(recent = {}, cik) {
  const accessionNumbers = recent.accessionNumber || [];
  const keys = [
    'accessionNumber',
    'filingDate',
    'reportDate',
    'acceptanceDateTime',
    'act',
    'form',
    'fileNumber',
    'filmNumber',
    'items',
    'size',
    'isXBRL',
    'isInlineXBRL',
    'primaryDocument',
    'primaryDocDescription',
  ];
  return accessionNumbers.map((_, index) => {
    const filing = Object.fromEntries(keys.map((key) => [key, recent[key]?.[index] ?? null]));
    const accessionNoDashes = String(filing.accessionNumber || '').replace(/-/g, '');
    const cikNoZeros = String(cik || '').replace(/^0+/, '');
    const primaryDocument = filing.primaryDocument || '';
    return {
      ...filing,
      size: Number(filing.size || 0),
      isXBRL: Boolean(filing.isXBRL),
      isInlineXBRL: Boolean(filing.isInlineXBRL),
      filingUrl: cikNoZeros && accessionNoDashes && primaryDocument
        ? `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${accessionNoDashes}/${primaryDocument}`
        : null,
    };
  });
}

module.exports = {
  getCompanyTickers,
  getCik,
  getCompanyFacts,
  getCompanySubmissions,
  getSubmissionsBySymbol,
  getSubmissionSummary,
  summarizeSubmissions,
  normalizeRecentFilings,
  getFundamentalFacts,
  pickLatestFact,
  CONCEPTS,
};
