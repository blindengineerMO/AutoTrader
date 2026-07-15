const { config } = require('../config');
const logger = require('../utils/logger');
const settingsRepo = require('../db/repositories/settingsRepo');
const companyIntelligenceRepo = require('../db/repositories/companyIntelligenceRepo');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const timeSettings = require('./timeSettingsService');
const locationCoordinator = require('./locationCoordinatorService');
const watcherAgentService = require('./watcherAgentService');
const finnhub = require('./marketData/finnhubClient');
const researchQuestionReasoning = require('./researchQuestionReasoningService');
const crawleeCrawler = require('./crawleeResearchCrawlerService');
const eventOutcomeLabeling = require('./eventOutcomeLabelingService');

const DEEP_CRAWL_MAX_REQUESTS = 6;
const DEEP_CRAWL_MAX_WAVES = 1;

// Deepens research on already-discovered companies during idle (off-hours)
// windows: refreshes their geographic footprint (via the location
// coordinator), pre-warms Finnhub company data, asks the local Ollama LLM for
// company-specific follow-up questions and runs a small bounded crawl against
// them, then catches up event-outcome labeling. Bounded per tick and gated to
// off-hours so it never starves the live cycle or blows API quotas (all
// downstream calls go through the Phase 64 rate limiters).
async function runIdleResearchTick({ userId, now = new Date() } = {}) {
  if (!config.idleResearch.enabled) return { ran: false, reason: 'disabled' };

  const settings = settingsRepo.get(userId);
  if (!settings) return { ran: false, reason: 'no-settings' };
  if (timeSettings.isWithinTradingHours(settings, now)) {
    return { ran: false, reason: 'within-trading-hours' };
  }

  const watcherTrainingBackfill = await watcherAgentService.runThirtyDayTrainingBackfill(userId, { force: false });

  const batch = companyIntelligenceRepo
    .listStalest(userId, config.idleResearch.maxCompaniesPerTick)
    .map((record) => ({ symbol: record.symbol, companyName: record.company_name, summary: record.summary }));

  if (!batch.length) {
    return watcherTrainingBackfill.ran
      ? { ran: true, companies: [], researched: [], mapped: 0, watcherTrainingBackfill }
      : { ran: false, reason: 'no-companies', watcherTrainingBackfill };
  }

  logger.info('Idle research tick deepening discovered companies', { userId, companies: batch.map((c) => c.symbol) });

  try {
    const { mapping, researched } = await locationCoordinator.coordinateLocations({ userId, candidates: batch });

    const deepened = [];
    for (const company of batch) {
      try {
        await deepenCompany({ userId, company });
        deepened.push(company.symbol);
      } catch (error) {
        logger.warn('Idle deep research failed for company', { userId, symbol: company.symbol, error: error.message });
      }
    }

    try {
      await eventOutcomeLabeling.backfillOutcomes({ userId });
    } catch (error) {
      logger.warn('Idle event-outcome labeling backfill failed', { userId, error: error.message });
    }

    return {
      ran: true,
      companies: batch.map((c) => c.symbol),
      researched,
      deepened,
      mapped: Object.keys(mapping).length,
      watcherTrainingBackfill,
    };
  } catch (error) {
    logger.warn('Idle research tick failed', { userId, error: error.message });
    return { ran: false, reason: 'error', error: error.message, watcherTrainingBackfill };
  }
}

// Pre-warms Finnhub company data (cached, so the next live cycle reads from
// cache) and asks the local Ollama LLM for company-specific follow-up
// questions, running a small bounded crawl against them off-hours.
async function deepenCompany({ userId, company }) {
  const finnhubCredentials = providerCredentialRepo.getSecret(userId, 'finnhub');
  const apiKey = finnhubCredentials?.apiKey || config.finnhubApiKey;
  const finnhubData = await finnhub.researchCompany(company.symbol, { apiKey });

  const reasoned = await researchQuestionReasoning
    .reasonFollowUpQuestions({ sources: { companyIntel: company.summary, finnhub: finnhubData }, news: { items: [] } })
    .catch(() => ({ questions: [] }));

  const observations = [];
  if (reasoned.questions.length) {
    const crawled = await crawleeCrawler
      .crawlAutonomousResearch({ queries: reasoned.questions, maxRequests: DEEP_CRAWL_MAX_REQUESTS, maxWaves: DEEP_CRAWL_MAX_WAVES })
      .catch((error) => {
        logger.warn('Idle deep crawl failed', { symbol: company.symbol, error: error.message });
        return { pages: [] };
      });
    observations.push(...crawled.pages.map((page) => ({ title: page.title, excerpt: page.excerpt, url: page.url })));
  }

  companyIntelligenceRepo.save({
    userId,
    symbol: company.symbol,
    companyName: company.companyName,
    summary: { ...company.summary, finnhub: finnhubData, idleObservations: observations },
  });
}

module.exports = { runIdleResearchTick };
