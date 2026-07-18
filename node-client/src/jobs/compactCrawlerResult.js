// Mirrors src/services/brainMeshService.js's compactCrawlerResult, with a
// `full` flag: heavy callers ask the coordinator for full-fidelity results
// (no truncation, richer page fields) by setting request.full = true, while
// default/compact mode keeps the small payload light callers expect.
function compactCrawlerResult({ result, events, queries, mode, full = false }) {
  const pageLimit = full ? result.pages.length : 8;
  const failureLimit = full ? result.failures.length : 8;
  const entityLeadLimit = full ? result.entityLeads.length : 12;
  return {
    ok: true,
    mode,
    queries,
    pageCount: result.pages.length,
    failureCount: result.failures.length,
    discoveredCount: result.discovered.length,
    entityLeadCount: result.entityLeads.length,
    pages: result.pages.slice(0, pageLimit).map((page) => (full ? {
      url: page.url,
      title: page.title,
      excerpt: page.excerpt,
      fullText: page.fullText,
      links: page.links,
      relevance: page.score?.relevance,
      weightedFinancialEvents: page.score?.weightedFinancialEvents,
      tags: page.score?.tags || [],
      sourceType: page.userData?.type,
      searchProvider: page.userData?.searchProvider,
      discoveredFromUrl: page.userData?.discoveredFromUrl,
      sourceCredibilityScore: page.userData?.source?.credibility_score,
    } : {
      url: page.url,
      title: page.title,
      excerpt: page.excerpt,
      relevance: page.score?.relevance,
      tags: page.score?.tags || [],
      sourceType: page.userData?.type,
      searchProvider: page.userData?.searchProvider,
    })),
    failures: result.failures.slice(0, failureLimit).map((failure) => (full ? {
      url: failure.url,
      title: failure.title,
      error: failure.error,
      userData: failure.userData,
    } : {
      url: failure.url,
      error: failure.error,
      searchProvider: failure.userData?.searchProvider,
      query: failure.userData?.query,
    })),
    providerFallbacks: events
      .filter((event) => event.phase === 'crawlee-search-fallback')
      .flatMap((event) => event.data?.fallbackRequests || [])
      .slice(0, full ? undefined : 12),
    discovered: full ? result.discovered : undefined,
    entityLeads: result.entityLeads.slice(0, entityLeadLimit),
    events: events.slice(full ? -64 : -16),
  };
}

module.exports = { compactCrawlerResult };
