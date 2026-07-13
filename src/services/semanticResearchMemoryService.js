const researchSourceRepo = require('../db/repositories/researchSourceRepo');
const textVector = require('../utils/textVector');

function searchResearchMemory({ userId, query, limit = 10, vectorLimit = 300 } = {}) {
  if (!userId || !query) return [];
  const queryVector = textVector.embedText(query);
  const fullTextHits = researchSourceRepo.searchObservationsFullText(userId, query, limit * 2);
  const vectorHits = researchSourceRepo.listObservationVectors(userId, vectorLimit)
    .map((item) => ({
      ...item,
      vectorSimilarity: textVector.cosineSimilarity(queryVector, item.vector),
    }))
    .filter((item) => item.vectorSimilarity >= 0.18)
    .sort((a, b) => b.vectorSimilarity - a.vectorSimilarity)
    .slice(0, limit * 2);

  const merged = new Map();
  for (const item of fullTextHits) {
    const ftsScore = 1 / (1 + Math.abs(Number(item.rank) || 0));
    merged.set(item.observationId, {
      ...item,
      searchMode: 'full-text',
      ftsScore,
      vectorSimilarity: 0,
      combinedScore: ftsScore,
    });
  }
  for (const item of vectorHits) {
    const existing = merged.get(item.observationId);
    const combinedScore = (existing?.ftsScore || 0) + item.vectorSimilarity;
    merged.set(item.observationId, {
      ...(existing || item),
      searchMode: existing ? 'full-text+vector' : 'vector',
      vectorSimilarity: item.vectorSimilarity,
      combinedScore,
      terms: item.terms,
    });
  }

  return [...merged.values()]
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit)
    .map((item) => ({
      ...item,
      combinedScore: round(item.combinedScore),
      vectorSimilarity: round(item.vectorSimilarity || 0),
    }));
}

function buildSeedSourcesFromMemory({ userId, queries = [], limit = 12 } = {}) {
  const byUrl = new Map();
  for (const query of queries.filter(Boolean).slice(0, 20)) {
    for (const hit of searchResearchMemory({ userId, query, limit: Math.ceil(limit / 2) })) {
      if (!hit.url || byUrl.has(hit.url)) continue;
      byUrl.set(hit.url, {
        url: hit.url,
        title: hit.title || hit.url,
        source_type: 'semantic-memory',
        credibility_score: hit.credibilityScore || 52,
        relevance_score: Math.min(95, 50 + hit.combinedScore * 22),
        searchMode: hit.searchMode,
        semanticScore: hit.combinedScore,
      });
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => b.semanticScore - a.semanticScore)
    .slice(0, limit);
}

function round(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

module.exports = {
  searchResearchMemory,
  buildSeedSourcesFromMemory,
};
