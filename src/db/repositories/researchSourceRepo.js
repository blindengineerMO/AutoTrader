const db = require('../connection');
const textVector = require('../../utils/textVector');

const upsertStmt = db.prepare(`
  INSERT INTO research_sources (
    user_id, url, title, source_type, status, discovery_method, discovered_from_url,
    tags_json, notes, relevance_score, credibility_score
  )
  VALUES (
    @userId, @url, @title, @sourceType, @status, @discoveryMethod, @discoveredFromUrl,
    @tagsJson, @notes, @relevanceScore, @credibilityScore
  )
  ON CONFLICT(user_id, url) DO UPDATE SET
    title = CASE WHEN research_sources.source_type = 'manual' THEN research_sources.title ELSE COALESCE(excluded.title, research_sources.title) END,
    source_type = CASE WHEN research_sources.source_type = 'manual' THEN research_sources.source_type ELSE excluded.source_type END,
    status = excluded.status,
    discovery_method = CASE WHEN research_sources.source_type = 'manual' THEN research_sources.discovery_method ELSE excluded.discovery_method END,
    discovered_from_url = COALESCE(excluded.discovered_from_url, research_sources.discovered_from_url),
    tags_json = CASE WHEN research_sources.source_type = 'manual' THEN research_sources.tags_json ELSE excluded.tags_json END,
    notes = COALESCE(excluded.notes, research_sources.notes),
    failure_count = CASE WHEN research_sources.status = 'failed' AND excluded.status = 'active' THEN 0 ELSE research_sources.failure_count END,
    relevance_score = max(research_sources.relevance_score, excluded.relevance_score),
    credibility_score = max(research_sources.credibility_score, excluded.credibility_score),
    updated_at = datetime('now')
`);

const listByUserStmt = db.prepare(`
  SELECT * FROM research_sources
  WHERE user_id = ?
  ORDER BY status = 'active' DESC, credibility_score DESC, relevance_score DESC, updated_at DESC
  LIMIT ?
`);

const SORT_COLUMNS = {
  updated_at: 'updated_at',
  relevance_score: 'relevance_score',
  credibility_score: 'credibility_score',
  failure_count: 'failure_count',
  success_count: 'success_count',
  title: 'title',
  url: 'url',
  status: 'status',
  source_type: 'source_type',
};

const activeByUserStmt = db.prepare(`
  SELECT * FROM research_sources
  WHERE user_id = ? AND status = 'active'
  ORDER BY credibility_score DESC, relevance_score DESC, success_count DESC
  LIMIT ?
`);

const getByIdStmt = db.prepare('SELECT * FROM research_sources WHERE id = ?');
const byUrlStmt = db.prepare('SELECT * FROM research_sources WHERE user_id = ? AND url = ?');

const updateStatsStmt = db.prepare(`
  UPDATE research_sources
  SET success_count = success_count + @successDelta,
      failure_count = failure_count + @failureDelta,
      status = CASE
        WHEN @successDelta > 0 THEN 'active'
        WHEN failure_count + @failureDelta >= 10 AND source_type != 'manual' THEN 'failed'
        ELSE status
      END,
      notes = CASE
        WHEN failure_count + @failureDelta >= 10 AND source_type != 'manual'
          THEN 'Auto-retired after 10 failed fetch attempts. It will stay out of active research unless future crawling re-learns it.'
        ELSE notes
      END,
      relevance_score = min(100, max(0, relevance_score + @relevanceDelta)),
      credibility_score = min(100, max(0, credibility_score + @credibilityDelta)),
      last_scraped_at = datetime('now'),
      last_success_at = CASE WHEN @successDelta > 0 THEN datetime('now') ELSE last_success_at END,
      updated_at = datetime('now')
  WHERE id = @id
`);

const updateStmt = db.prepare(`
  UPDATE research_sources
  SET title = @title,
      status = @status,
      source_type = @sourceType,
      tags_json = @tagsJson,
      notes = @notes,
      relevance_score = @relevanceScore,
      credibility_score = @credibilityScore,
      updated_at = datetime('now')
  WHERE id = @id AND user_id = @userId
`);

const insertObservationStmt = db.prepare(`
  INSERT INTO research_source_observations (
    user_id, source_id, research_run_id, url, title, excerpt, links_json, score_json
  )
  VALUES (@userId, @sourceId, @researchRunId, @url, @title, @excerpt, @linksJson, @scoreJson)
`);

let insertObservationFtsStmt;
let insertObservationVectorStmt;
let recentVectorsStmt;

function queryByUser(userId, {
  page = 1,
  pageSize = 25,
  search = '',
  status = '',
  sourceType = '',
  sortBy = 'updated_at',
  sortDir = 'desc',
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const safeSortBy = SORT_COLUMNS[sortBy] ? sortBy : 'updated_at';
  const safeSortDir = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const where = ['user_id = @userId'];
  const params = {
    userId,
    limit: safePageSize,
    offset: (safePage - 1) * safePageSize,
  };

  if (search) {
    where.push(`(
      url LIKE @search OR title LIKE @search OR notes LIKE @search OR
      tags_json LIKE @search OR discovery_method LIKE @search
    )`);
    params.search = `%${search}%`;
  }
  if (status) {
    where.push('status = @status');
    params.status = status;
  }
  if (sourceType) {
    where.push('source_type = @sourceType');
    params.sourceType = sourceType;
  }

  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS count FROM research_sources WHERE ${whereSql}`).get(params).count;
  const items = db.prepare(`
    SELECT * FROM research_sources
    WHERE ${whereSql}
    ORDER BY ${SORT_COLUMNS[safeSortBy]} ${safeSortDir}, id ${safeSortDir}
    LIMIT @limit OFFSET @offset
  `).all(params).map(deserialize);

  return {
    items,
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    sortBy: safeSortBy,
    sortDir: safeSortDir.toLowerCase(),
  };
}

function upsert(source) {
  upsertStmt.run({
    userId: source.userId,
    url: source.url,
    title: source.title || null,
    sourceType: source.sourceType || 'learned',
    status: source.status || 'active',
    discoveryMethod: source.discoveryMethod || 'manual',
    discoveredFromUrl: source.discoveredFromUrl || null,
    tagsJson: JSON.stringify(source.tags || []),
    notes: source.notes || null,
    relevanceScore: source.relevanceScore ?? 50,
    credibilityScore: source.credibilityScore ?? 50,
  });
  return getByUrl(source.userId, source.url);
}

function update(userId, id, patch) {
  const current = getById(id);
  if (!current || current.user_id !== userId) return null;
  updateStmt.run({
    id,
    userId,
    title: patch.title ?? current.title,
    status: patch.status ?? current.status,
    sourceType: patch.sourceType ?? current.source_type,
    tagsJson: JSON.stringify(patch.tags ?? current.tags),
    notes: patch.notes ?? current.notes,
    relevanceScore: patch.relevanceScore ?? current.relevance_score,
    credibilityScore: patch.credibilityScore ?? current.credibility_score,
  });
  return getById(id);
}

function recordObservation({ userId, sourceId, researchRunId, url, title, excerpt, links, score }) {
  const { lastInsertRowid } = insertObservationStmt.run({
    userId,
    sourceId: sourceId || null,
    researchRunId: researchRunId || null,
    url,
    title: title || null,
    excerpt: excerpt || '',
    linksJson: JSON.stringify(links || []),
    scoreJson: JSON.stringify(score || {}),
  });
  indexObservation({
    id: Number(lastInsertRowid),
    userId,
    sourceId: sourceId || null,
    url,
    title: title || null,
    excerpt: excerpt || '',
    score: score || {},
  });
  return lastInsertRowid;
}

function indexObservation({ id, userId, sourceId, url, title, excerpt, score }) {
  const searchText = [
    title,
    excerpt,
    url,
    Array.isArray(score?.tags) ? score.tags.join(' ') : '',
    score?.weightedFinancialEvents?.events?.slice?.(0, 5)?.map((event) => event.event?.type).join(' ') || '',
  ].filter(Boolean).join(' ');
  try {
    getInsertObservationFtsStmt().run({
      rowid: id,
      title: title || '',
      excerpt: excerpt || '',
      url: url || '',
    });
    getInsertObservationVectorStmt().run({
      observationId: id,
      userId,
      sourceId,
      vectorJson: JSON.stringify(textVector.embedText(searchText)),
      termsJson: JSON.stringify(textVector.topTerms(searchText)),
      textHash: textVector.textHash(searchText),
    });
  } catch {
    // Older dev/test databases may not have run the semantic-memory migration yet.
    // Production startup runs migrations before serving requests.
  }
}

function updateStats(id, { success = false, relevanceDelta = 0, credibilityDelta = 0 }) {
  updateStatsStmt.run({
    id,
    successDelta: success ? 1 : 0,
    failureDelta: success ? 0 : 1,
    relevanceDelta,
    credibilityDelta,
  });
  return getById(id);
}

function searchObservationsFullText(userId, query, limit = 12) {
  const match = buildFtsQuery(query);
  if (!match) return [];
  try {
    return db.prepare(`
      SELECT
        rso.id AS observation_id,
        rso.source_id,
        rso.url,
        rso.title,
        rso.excerpt,
        rso.score_json,
        rso.created_at,
        rs.credibility_score,
        rs.relevance_score,
        bm25(research_observation_fts) AS rank
      FROM research_observation_fts
      JOIN research_source_observations rso ON rso.id = research_observation_fts.rowid
      LEFT JOIN research_sources rs ON rs.id = rso.source_id
      WHERE research_observation_fts MATCH @match AND rso.user_id = @userId
      ORDER BY rank
      LIMIT @limit
    `).all({ userId, match, limit: Math.max(1, Math.min(50, Number(limit) || 12)) }).map(deserializeSearchResult);
  } catch {
    return [];
  }
}

function listObservationVectors(userId, limit = 250) {
  try {
    return getRecentVectorsStmt().all(userId, Math.max(1, Math.min(1000, Number(limit) || 250))).map((row) => ({
    ...deserializeSearchResult({
      observation_id: row.observation_id,
      source_id: row.source_id,
      url: row.url,
      title: row.title,
      excerpt: row.excerpt,
      score_json: row.score_json,
      created_at: row.created_at,
      credibility_score: row.credibility_score,
      relevance_score: row.relevance_score,
      rank: 0,
    }),
    vector: JSON.parse(row.vector_json || '[]'),
    terms: JSON.parse(row.terms_json || '[]'),
    textHash: row.text_hash,
  }));
  } catch {
    return [];
  }
}

function deserialize(row) {
  if (!row) return row;
  return {
    ...row,
    tags: JSON.parse(row.tags_json || '[]'),
  };
}

function deserializeSearchResult(row) {
  return {
    observationId: row.observation_id,
    sourceId: row.source_id,
    url: row.url,
    title: row.title,
    excerpt: row.excerpt,
    score: JSON.parse(row.score_json || '{}'),
    createdAt: row.created_at,
    credibilityScore: row.credibility_score,
    relevanceScore: row.relevance_score,
    rank: row.rank,
  };
}

function buildFtsQuery(query) {
  const terms = textVector.tokenize(query)
    .filter((term) => /^[a-z0-9$.-]+$/i.test(term))
    .slice(0, 8);
  return terms.length ? terms.map((term) => `${term.replace(/"/g, '')}*`).join(' OR ') : '';
}

function getInsertObservationFtsStmt() {
  if (!insertObservationFtsStmt) {
    insertObservationFtsStmt = db.prepare(`
      INSERT INTO research_observation_fts (rowid, title, excerpt, url)
      VALUES (@rowid, @title, @excerpt, @url)
    `);
  }
  return insertObservationFtsStmt;
}

function getInsertObservationVectorStmt() {
  if (!insertObservationVectorStmt) {
    insertObservationVectorStmt = db.prepare(`
      INSERT OR REPLACE INTO research_memory_vectors (
        observation_id, user_id, source_id, vector_json, terms_json, text_hash
      )
      VALUES (@observationId, @userId, @sourceId, @vectorJson, @termsJson, @textHash)
    `);
  }
  return insertObservationVectorStmt;
}

function getRecentVectorsStmt() {
  if (!recentVectorsStmt) {
    recentVectorsStmt = db.prepare(`
      SELECT
        rmv.*,
        rso.url,
        rso.title,
        rso.excerpt,
        rso.score_json,
        rs.credibility_score,
        rs.relevance_score
      FROM research_memory_vectors rmv
      JOIN research_source_observations rso ON rso.id = rmv.observation_id
      LEFT JOIN research_sources rs ON rs.id = rmv.source_id
      WHERE rmv.user_id = ?
      ORDER BY rmv.created_at DESC
      LIMIT ?
    `);
  }
  return recentVectorsStmt;
}

function getById(id) {
  return deserialize(getByIdStmt.get(id));
}

function getByUrl(userId, url) {
  return deserialize(byUrlStmt.get(userId, url));
}

module.exports = {
  upsert,
  update,
  getById,
  getByUrl,
  listByUser: (userId, limit = 100) => listByUserStmt.all(userId, limit).map(deserialize),
  listActiveByUser: (userId, limit = 25) => activeByUserStmt.all(userId, limit).map(deserialize),
  queryByUser,
  recordObservation,
  searchObservationsFullText,
  listObservationVectors,
  updateStats,
};
