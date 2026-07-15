const settingsRepo = require('../db/repositories/settingsRepo');
const userRepo = require('../db/repositories/userRepo');
const alpacaAssetClient = require('./marketData/alpacaAssetClient');
const logger = require('../utils/logger');

// Only symbols auto-excluded because Alpaca itself rejected them as
// not-tradable are eligible for automatic restoration. Symbols a user
// excluded manually (source 'manual-settings') are left alone — only the
// user should re-add those.
const AUTO_EXCLUSION_SOURCE = 'alpaca-asset-eligibility';

async function recheckExcludedSymbolsForUser(userId) {
  if (!alpacaAssetClient.isConfigured(userId)) {
    return { checked: 0, restored: [] };
  }

  const candidates = settingsRepo.getExcludedSymbols(userId).filter((entry) => entry.source === AUTO_EXCLUSION_SOURCE);
  const restored = [];
  for (const entry of candidates) {
    const asset = await alpacaAssetClient.recheckAsset(entry.symbol, { userId });
    if (asset.available && asset.tradable) {
      settingsRepo.removeExcludedSymbol(userId, entry.symbol);
      restored.push(entry.symbol);
      logger.info('Restored auto-excluded symbol now tradable via Alpaca', { userId, symbol: entry.symbol });
    }
  }
  return { checked: candidates.length, restored };
}

async function recheckExcludedSymbolsForAllUsers() {
  const results = [];
  for (const user of userRepo.list()) {
    try {
      const result = await recheckExcludedSymbolsForUser(user.id);
      if (result.checked) results.push({ userId: user.id, ...result });
    } catch (err) {
      logger.error('Excluded-symbol recheck failed for user', { userId: user.id, error: err.message });
    }
  }
  return results;
}

module.exports = { recheckExcludedSymbolsForUser, recheckExcludedSymbolsForAllUsers };
