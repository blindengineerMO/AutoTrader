const { normalizeLimitedStrings, clampNumber, clampFloat } = require('./urlGuard');
const crawleeCrawler = require('../crawler/crawleeResearchCrawlerService');
const { compactCrawlerResult } = require('./compactCrawlerResult');

async function runSearchJob(request = {}) {
  const full = Boolean(request.full);
  const queries = normalizeLimitedStrings(request.queries || request.query, full ? 150 : 4);
  if (!queries.length) {
    return { ok: false, reason: 'No search query provided.', mode: 'search', pages: [], failures: [] };
  }

  const events = [];
  const result = await crawleeCrawler.crawlAutonomousResearch({
    queries,
    seedSources: [],
    maxRequests: full ? clampNumber(request.maxRequests, 4, 300, 96) : clampNumber(request.maxRequests, 4, 36, 16),
    maxWaves: full ? clampNumber(request.maxWaves, 1, 12, 8) : clampNumber(request.maxWaves, 1, 4, 2),
    maxFollowUps: full ? clampNumber(request.maxFollowUps, 0, 40, 18) : clampNumber(request.maxFollowUps, 0, 10, 4),
    maxSearchExpansions: full
      ? clampNumber(request.maxSearchExpansions, 0, 100, 36)
      : clampNumber(request.maxSearchExpansions, 0, 16, 8),
    maxRuntimeMs: full
      ? clampNumber(request.maxRuntimeMs, 10_000, 600_000, 360_000)
      : clampNumber(request.maxRuntimeMs, 10_000, 120_000, 45_000),
    minContinuationScore: clampFloat(request.minContinuationScore, 0.1, 5, 1.85),
    onEvent: (event) => events.push(event),
  });

  return compactCrawlerResult({ result, events, queries, mode: 'search', full });
}

module.exports = { runSearchJob };
