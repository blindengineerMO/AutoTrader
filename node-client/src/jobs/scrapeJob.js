const { normalizeLimitedStrings, isPublicHttpUrl, clampNumber, clampFloat } = require('./urlGuard');
const crawleeCrawler = require('../crawler/crawleeResearchCrawlerService');
const { compactCrawlerResult } = require('./compactCrawlerResult');

async function runScrapeJob(request = {}) {
  const full = Boolean(request.full);
  const urls = normalizeLimitedStrings(request.urls || request.url, full ? 30 : 6).filter(isPublicHttpUrl);
  const seedSources = urls.map((url) => ({ url, title: url, tags: ['bmcl-crawl'] }));
  if (!seedSources.length) {
    return { ok: false, reason: 'No public HTTP(S) crawl URL provided.', mode: 'crawl', pages: [], failures: [] };
  }

  const events = [];
  const result = await crawleeCrawler.crawlAutonomousResearch({
    queries: normalizeLimitedStrings(request.queries || request.query, full ? 150 : 2),
    seedSources,
    maxRequests: full
      ? clampNumber(request.maxRequests, seedSources.length, 300, Math.max(seedSources.length, 96))
      : clampNumber(request.maxRequests, seedSources.length, 36, Math.max(seedSources.length, 12)),
    maxWaves: full ? clampNumber(request.maxWaves, 1, 12, 8) : clampNumber(request.maxWaves, 1, 4, 2),
    maxFollowUps: full ? clampNumber(request.maxFollowUps, 0, 40, 18) : clampNumber(request.maxFollowUps, 0, 10, 4),
    maxSearchExpansions: full
      ? clampNumber(request.maxSearchExpansions, 0, 60, 36)
      : clampNumber(request.maxSearchExpansions, 0, 12, 4),
    maxRuntimeMs: full
      ? clampNumber(request.maxRuntimeMs, 10_000, 600_000, 360_000)
      : clampNumber(request.maxRuntimeMs, 10_000, 120_000, 45_000),
    minContinuationScore: clampFloat(request.minContinuationScore, 0.1, 5, 1.85),
    onEvent: (event) => events.push(event),
  });

  return compactCrawlerResult({ result, events, queries: seedSources.map((source) => source.url), mode: 'crawl', full });
}

module.exports = { runScrapeJob };
