const Alpaca = require('@alpacahq/alpaca-trade-api');
const { config } = require('../../config');
const providerCredentialRepo = require('../../db/repositories/providerCredentialRepo');
const settingsRepo = require('../../db/repositories/settingsRepo');
const httpCache = require('../../utils/httpCache');
const logger = require('../../utils/logger');

const ASSET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ASSET_LIST_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let clientFactory = (options) => new Alpaca(options);

function getCredentials(userId) {
  const saved = userId ? providerCredentialRepo.getSecret(userId, 'alpaca') : null;
  const paper = parseBoolean(saved?.paper, config.alpaca.paper);
  const baseUrl = saved?.baseUrl || config.alpaca.baseUrl || defaultBaseUrl(paper);
  return {
    keyId: saved?.keyId || config.alpaca.keyId,
    secretKey: saved?.secretKey || config.alpaca.secretKey,
    paper,
    baseUrl,
  };
}

function isConfigured(userId) {
  const credentials = getCredentials(userId);
  return Boolean(credentials.keyId && credentials.secretKey);
}

async function getAsset(symbol, { userId } = {}) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return { available: false, reason: 'missing-symbol' };
  if (settingsRepo.isSymbolExcluded(userId, normalized)) {
    return {
      available: true,
      symbol: normalized,
      tradable: false,
      excluded: true,
      reason: 'symbol-already-excluded',
    };
  }
  if (!isConfigured(userId)) {
    return { available: false, symbol: normalized, reason: 'alpaca-not-configured' };
  }
  return httpCache.getOrFetch(assetCacheKey(userId, normalized), ASSET_CACHE_TTL_MS, () => fetchAssetFromAlpaca(normalized, userId));
}

// Re-checks a symbol against live Alpaca asset data even if it's currently
// excluded, bypassing both the isSymbolExcluded short-circuit in getAsset()
// and any cached not-tradable result — used by the daily excluded-symbol
// recheck job so a symbol Alpaca starts allowing again can be detected.
async function recheckAsset(symbol, { userId } = {}) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return { available: false, reason: 'missing-symbol' };
  if (!isConfigured(userId)) return { available: false, symbol: normalized, reason: 'alpaca-not-configured' };
  const cacheKey = assetCacheKey(userId, normalized);
  httpCache.clearCache(cacheKey);
  return httpCache.getOrFetch(cacheKey, ASSET_CACHE_TTL_MS, () => fetchAssetFromAlpaca(normalized, userId));
}

function assetCacheKey(userId, normalizedSymbol) {
  return `alpaca:asset:${userId || 'env'}:${normalizedSymbol}`;
}

async function fetchAssetFromAlpaca(normalized, userId) {
  try {
    const asset = await createClient(userId).getAsset(normalized);
    return normalizeAsset(asset, normalized);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        available: true,
        symbol: normalized,
        tradable: false,
        reason: 'asset-not-found',
        error: error.message,
      };
    }
    logger.warn('Alpaca asset lookup failed', { userId, symbol: normalized, error: error.message });
    return { available: false, symbol: normalized, reason: 'alpaca-lookup-failed', error: error.message };
  }
}

async function lookupCompany(query, { userId } = {}) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return { available: false, reason: 'missing-query' };
  const directSymbol = looksLikeSymbol(normalizedQuery) ? await getAsset(normalizedQuery, { userId }) : null;
  if (directSymbol?.available && directSymbol.tradable) return directSymbol;
  if (!isConfigured(userId)) return { available: false, query: normalizedQuery, reason: 'alpaca-not-configured' };

  const assetsResult = await getTradableAssets({ userId });
  if (!assetsResult.available) return assetsResult;
  const normalizedNeedle = normalizeText(normalizedQuery);
  const candidates = assetsResult.assets
    .map((asset) => ({ asset, score: scoreAssetMatch(asset, normalizedNeedle, normalizedQuery) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.asset.symbol.localeCompare(b.asset.symbol));
  if (!candidates.length) {
    return { available: true, query: normalizedQuery, tradable: false, reason: 'no-alpaca-asset-match' };
  }
  return { ...candidates[0].asset, matchScore: candidates[0].score, matchQuery: normalizedQuery };
}

async function evaluateSymbol(symbol, { userId, companyName, source = 'alpaca-asset-eligibility' } = {}) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return { eligible: false, symbol: normalized, reason: 'missing-symbol' };
  if (settingsRepo.isSymbolExcluded(userId, normalized)) {
    return { eligible: false, symbol: normalized, excluded: true, reason: 'symbol-already-excluded' };
  }
  const asset = await getAsset(normalized, { userId });
  if (!asset.available) {
    return { eligible: true, symbol: normalized, degraded: true, reason: asset.reason, asset };
  }
  if (asset.tradable) {
    return { eligible: true, symbol: asset.symbol || normalized, companyName: asset.name || companyName, asset };
  }
  excludeSymbol(userId, {
    symbol: normalized,
    companyName: companyName || asset.name,
    reason: reasonForNonTradable(asset),
    source,
    assetStatus: asset.status,
    exchange: asset.exchange,
  });
  return { eligible: false, symbol: normalized, reason: reasonForNonTradable(asset), asset };
}

async function evaluateCompanyLead(lead, { userId, source = 'alpaca-asset-eligibility' } = {}) {
  const leadSymbol = normalizeSymbol(lead?.symbol);
  const name = lead?.name || lead?.companyName || leadSymbol;
  if (leadSymbol) return evaluateSymbol(leadSymbol, { userId, companyName: name, source });

  const match = await lookupCompany(name, { userId });
  if (!match.available) return { eligible: true, degraded: true, reason: match.reason, asset: match };
  if (match.tradable) return { eligible: true, symbol: match.symbol, companyName: match.name || name, asset: match };

  return { eligible: false, symbol: null, companyName: name, reason: match.reason, asset: match };
}

async function filterCandidates(candidates, { userId, onExcluded = null, source = 'alpaca-asset-eligibility' } = {}) {
  const kept = [];
  const excluded = [];
  for (const candidate of candidates || []) {
    const eligibility = await evaluateSymbol(candidate.symbol, {
      userId,
      companyName: candidate.companyName,
      source,
    });
    if (eligibility.eligible) {
      kept.push({
        ...candidate,
        symbol: eligibility.symbol || candidate.symbol,
        companyName: candidate.companyName || eligibility.companyName,
        alpacaAsset: eligibility.asset?.tradable ? compactAsset(eligibility.asset) : undefined,
        alpacaEligibilityDegraded: Boolean(eligibility.degraded),
      });
    } else {
      const item = { ...candidate, alpacaEligibility: eligibility };
      excluded.push(item);
      if (onExcluded) onExcluded(item);
    }
  }
  return { kept, excluded };
}

function excludeSymbol(userId, entry) {
  if (!userId || !entry?.symbol) return null;
  return settingsRepo.addExcludedSymbol(userId, {
    ...entry,
    source: entry.source || 'alpaca-asset-eligibility',
  });
}

async function getTradableAssets({ userId } = {}) {
  if (!isConfigured(userId)) return { available: false, reason: 'alpaca-not-configured', assets: [] };
  const cacheKey = `alpaca:assets:active:${userId || 'env'}`;
  return httpCache.getOrFetch(cacheKey, ASSET_LIST_CACHE_TTL_MS, async () => {
    try {
      const assets = await createClient(userId).getAssets({ status: 'active', asset_class: 'us_equity' });
      return {
        available: true,
        assets: (assets || []).map((asset) => normalizeAsset(asset)).filter((asset) => asset.symbol),
      };
    } catch (error) {
      logger.warn('Alpaca active asset list lookup failed', { userId, error: error.message });
      return { available: false, reason: 'alpaca-assets-lookup-failed', error: error.message, assets: [] };
    }
  });
}

function createClient(userId) {
  const credentials = getCredentials(userId);
  if (!credentials.keyId || !credentials.secretKey) {
    throw new Error('Alpaca API key ID and secret key are required for asset lookup.');
  }
  return clientFactory({
    keyId: credentials.keyId,
    secretKey: credentials.secretKey,
    paper: credentials.paper,
    baseUrl: credentials.baseUrl,
  });
}

function normalizeAsset(asset, fallbackSymbol = '') {
  const symbol = normalizeSymbol(asset?.symbol || fallbackSymbol);
  const status = String(asset?.status || '').toLowerCase();
  return {
    available: true,
    id: asset?.id || null,
    symbol,
    name: asset?.name || asset?.description || symbol,
    exchange: asset?.exchange || null,
    assetClass: asset?.class || asset?.asset_class || null,
    status,
    tradable: Boolean(asset?.tradable) && (!status || status === 'active'),
    marginable: Boolean(asset?.marginable),
    shortable: Boolean(asset?.shortable),
    fractionable: Boolean(asset?.fractionable),
    easyToBorrow: Boolean(asset?.easy_to_borrow),
  };
}

function compactAsset(asset) {
  if (!asset) return null;
  return {
    symbol: asset.symbol,
    name: asset.name,
    exchange: asset.exchange,
    status: asset.status,
    tradable: asset.tradable,
    fractionable: asset.fractionable,
  };
}

function reasonForNonTradable(asset) {
  if (asset?.excluded) return 'Symbol is already in the excluded-symbol configuration.';
  if (asset?.reason === 'asset-not-found') return 'Alpaca asset lookup did not find this symbol.';
  if (asset?.reason === 'no-alpaca-asset-match') return 'Alpaca active asset list did not match this company.';
  if (asset?.status && asset.status !== 'active') return `Alpaca asset status is ${asset.status}.`;
  return 'Alpaca reports the asset is not tradable.';
}

function scoreAssetMatch(asset, normalizedNeedle, originalQuery) {
  const symbol = normalizeSymbol(originalQuery);
  if (symbol && asset.symbol === symbol) return 100;
  const name = normalizeText(asset.name);
  if (!normalizedNeedle || !name) return 0;
  if (name === normalizedNeedle) return 95;
  if (name.startsWith(normalizedNeedle)) return 80;
  if (name.includes(normalizedNeedle)) return 65;
  const words = normalizedNeedle.split(' ').filter((word) => word.length > 2);
  if (!words.length) return 0;
  const hits = words.filter((word) => name.includes(word)).length;
  return hits >= Math.min(2, words.length) ? 40 + hits * 5 : 0;
}

function isNotFound(error) {
  const status = error?.statusCode || error?.status || error?.response?.statusCode || error?.response?.status;
  return status === 404 || /not found|404/i.test(String(error?.message || ''));
}

function looksLikeSymbol(value) {
  return /^[A-Za-z][A-Za-z0-9.-]{0,6}$/.test(String(value || '').trim());
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 16);
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function defaultBaseUrl(paper) {
  return paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'paper'].includes(String(value).trim().toLowerCase());
}

function __setClientFactoryForTests(factory) {
  clientFactory = factory || ((options) => new Alpaca(options));
}

module.exports = {
  ASSET_CACHE_TTL_MS,
  ASSET_LIST_CACHE_TTL_MS,
  getCredentials,
  isConfigured,
  getAsset,
  recheckAsset,
  lookupCompany,
  evaluateSymbol,
  evaluateCompanyLead,
  filterCandidates,
  excludeSymbol,
  getTradableAssets,
  normalizeSymbol,
  __setClientFactoryForTests,
};
