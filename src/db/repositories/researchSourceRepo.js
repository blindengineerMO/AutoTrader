const db = require('../connection');

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
  return lastInsertRowid;
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

function deserialize(row) {
  if (!row) return row;
  return {
    ...row,
    tags: JSON.parse(row.tags_json || '[]'),
  };
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
  recordObservation,
  updateStats,
};
