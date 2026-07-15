const brainModelRepo = require('../db/repositories/brainModelRepo');
const crawleeCrawler = require('./crawleeResearchCrawlerService');
const logger = require('../utils/logger');

const MODEL_KEY = 'search-provider-health';

// Search-provider health (success/failure/rate-limit counters) lives in an
// in-process Map inside the crawler service, so it resets on restart unless
// persisted. Saved/restored here rather than inside the crawler module itself
// so the crawler stays DB-free (its unit tests never touch a database).
function restore() {
  try {
    const saved = brainModelRepo.get(null, MODEL_KEY);
    if (saved?.model?.providers?.length) {
      crawleeCrawler.restoreProviderHealthState(saved.model.providers);
      return saved.model.providers.length;
    }
  } catch (err) {
    logger.warn('Failed to restore search provider health', { error: err.message });
  }
  return 0;
}

function persist() {
  try {
    brainModelRepo.save({
      userId: null,
      modelKey: MODEL_KEY,
      modelJson: { providers: crawleeCrawler.exportProviderHealthState() },
    });
  } catch (err) {
    logger.warn('Failed to persist search provider health', { error: err.message });
  }
}

module.exports = { restore, persist };
