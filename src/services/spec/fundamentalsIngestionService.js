const specRepo = require('../../db/repositories/specResearchRepo');
const secEdgarClient = require('../marketData/secEdgarClient');
const logger = require('../../utils/logger');

/**
 * Derives point-in-time-safe fundamental ratios from SEC EDGAR XBRL facts.
 * Every ratio is tagged with the filing timestamp of its underlying fact
 * (`availableAt`) rather than the fiscal period end, so downstream feature
 * generation never joins on a period before the numbers were public.
 */
function deriveRatios(facts, { priceUsd } = {}) {
  const ratios = {};
  const netIncome = facts.NetIncomeLoss?.value;
  const revenue = facts.Revenues?.value;
  const equity = facts.StockholdersEquity?.value;
  const assets = facts.Assets?.value;
  const liabilities = facts.Liabilities?.value;
  const shares = facts.CommonStockSharesOutstanding?.value;
  const eps = facts.EarningsPerShareDiluted?.value;
  const operatingIncome = facts.OperatingIncomeLoss?.value;

  if (Number.isFinite(eps) && Number.isFinite(priceUsd) && priceUsd > 0) {
    ratios.earningsYield = { value: eps / priceUsd, availableAt: facts.EarningsPerShareDiluted.filedAt };
  }
  if (Number.isFinite(equity) && Number.isFinite(shares) && shares > 0 && Number.isFinite(priceUsd) && priceUsd > 0) {
    const bookValuePerShare = equity / shares;
    ratios.bookToMarket = { value: bookValuePerShare / priceUsd, availableAt: facts.StockholdersEquity.filedAt };
  }
  if (Number.isFinite(netIncome) && Number.isFinite(equity) && equity !== 0) {
    ratios.returnOnEquity = { value: netIncome / equity, availableAt: latestOf(facts.NetIncomeLoss, facts.StockholdersEquity) };
  }
  if (Number.isFinite(liabilities) && Number.isFinite(equity) && equity !== 0) {
    ratios.debtToEquity = { value: liabilities / equity, availableAt: latestOf(facts.Liabilities, facts.StockholdersEquity) };
  }
  if (Number.isFinite(operatingIncome) && Number.isFinite(revenue) && revenue !== 0) {
    ratios.operatingMargin = { value: operatingIncome / revenue, availableAt: latestOf(facts.OperatingIncomeLoss, facts.Revenues) };
  }
  return ratios;
}

function latestOf(a, b) {
  const dates = [a?.filedAt, b?.filedAt].filter(Boolean).sort();
  return dates.at(-1) || null;
}

/**
 * Fetches, persists (raw-first), and derives fundamentals for one symbol.
 * Returns null (not a thrown error) when EDGAR has no CIK/facts for the
 * symbol so callers can fall back to the heuristic feature path.
 */
async function ingestFundamentals({ userId, symbol, priceUsd }) {
  let fetched;
  try {
    fetched = await secEdgarClient.getFundamentalFacts(symbol);
  } catch (err) {
    logger.warn('SEC EDGAR fundamentals fetch failed', { symbol, error: err.message });
    return null;
  }
  if (!fetched || !Object.keys(fetched.facts || {}).length) return null;

  const rawSource = specRepo.saveRawSource({
    userId,
    sourceName: 'sec-edgar-companyfacts',
    sourceUrl: `https://data.sec.gov/api/xbrl/companyfacts/CIK${fetched.cik}.json`,
    observedAt: new Date().toISOString(),
    availableAt: fetched.availableAt || new Date().toISOString(),
    payload: { symbol: fetched.symbol, cik: fetched.cik, facts: fetched.facts },
  });

  const ratios = deriveRatios(fetched.facts, { priceUsd });

  return {
    symbol: fetched.symbol,
    cik: fetched.cik,
    availableAt: fetched.availableAt,
    facts: fetched.facts,
    ratios,
    sourceRawId: rawSource.id,
  };
}

async function ingestFundamentalsForSymbols({ userId, symbols = [], pricesBySymbol = {} }) {
  const results = new Map();
  for (const symbol of symbols) {
    const normalized = String(symbol).toUpperCase();
    try {
      const fundamentals = await ingestFundamentals({ userId, symbol: normalized, priceUsd: pricesBySymbol[normalized] });
      if (fundamentals) results.set(normalized, fundamentals);
    } catch (err) {
      logger.warn('Fundamentals ingestion failed for symbol', { symbol: normalized, error: err.message });
    }
  }
  return results;
}

module.exports = { deriveRatios, ingestFundamentals, ingestFundamentalsForSymbols };
