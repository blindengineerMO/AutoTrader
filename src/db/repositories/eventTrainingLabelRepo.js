const db = require('../connection');

const insertLabel = db.prepare(`
  INSERT OR IGNORE INTO event_training_labels (
    user_id, symbol, event_category, event_type, event_direction, base_weight,
    certainty, source_type, source_reliability, source_domain, statement_text,
    affected_metric, market_expectation, surprise_direction, final_event_score,
    evidence_url, document_id, sector_symbol, event_date
  ) VALUES (
    @userId, @symbol, @eventCategory, @eventType, @eventDirection, @baseWeight,
    @certainty, @sourceType, @sourceReliability, @sourceDomain, @statementText,
    @affectedMetric, @marketExpectation, @surpriseDirection, @finalEventScore,
    @evidenceUrl, @documentId, @sectorSymbol, @eventDate
  )
`);

const awaitingReturns = db.prepare(`
  SELECT * FROM event_training_labels
  WHERE user_id = ?
    AND (stock_return_1_day IS NULL OR stock_return_21_days IS NULL)
    AND event_date <= datetime('now', ?)
  ORDER BY event_date ASC
  LIMIT ?
`);

const awaitingFundamentals = db.prepare(`
  SELECT * FROM event_training_labels
  WHERE user_id = ?
    AND stock_return_21_days IS NOT NULL
    AND fundamental_result_2_quarters_later IS NULL
  ORDER BY event_date ASC
  LIMIT ?
`);

const recentLabels = db.prepare(`
  SELECT * FROM event_training_labels
  WHERE user_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

const accuracyRows = db.prepare(`
  SELECT event_category AS category,
         COUNT(*) AS samples,
         AVG(CASE WHEN original_model_prediction_correct = 1 THEN 1.0 ELSE 0.0 END) AS accuracy
  FROM event_training_labels
  WHERE user_id = ? AND original_model_prediction_correct IS NOT NULL
  GROUP BY event_category
`);

const multiplierRows = db.prepare(`
  SELECT category, multiplier, samples, accuracy FROM event_category_learning WHERE user_id = ?
`);

const upsertLearning = db.prepare(`
  INSERT INTO event_category_learning (user_id, category, multiplier, samples, accuracy, updated_at)
  VALUES (@userId, @category, @multiplier, @samples, @accuracy, datetime('now'))
  ON CONFLICT(user_id, category) DO UPDATE SET
    multiplier = excluded.multiplier,
    samples = excluded.samples,
    accuracy = excluded.accuracy,
    updated_at = excluded.updated_at
`);

function saveLabels(userId, labels) {
  let inserted = 0;
  for (const label of labels) {
    const result = insertLabel.run({
      userId,
      symbol: label.symbol,
      eventCategory: label.eventCategory,
      eventType: label.eventType,
      eventDirection: label.eventDirection,
      baseWeight: label.baseWeight ?? 0,
      certainty: label.certainty ?? null,
      sourceType: label.sourceType ?? null,
      sourceReliability: label.sourceReliability ?? null,
      sourceDomain: label.sourceDomain ?? null,
      statementText: label.statementText ?? null,
      affectedMetric: label.affectedMetric ?? null,
      marketExpectation: label.marketExpectation ?? null,
      surpriseDirection: label.surpriseDirection ?? null,
      finalEventScore: label.finalEventScore ?? 0,
      evidenceUrl: label.evidenceUrl ?? null,
      documentId: label.documentId ?? '',
      sectorSymbol: label.sectorSymbol || 'SPY',
      eventDate: label.eventDate,
    });
    inserted += result.changes;
  }
  return inserted;
}

function listAwaitingReturns(userId, { minAgeDays = 1, limit = 40 } = {}) {
  return awaitingReturns.all(userId, `-${minAgeDays} days`, limit);
}

function listAwaitingFundamentals(userId, { limit = 20 } = {}) {
  return awaitingFundamentals.all(userId, limit);
}

function updateOutcomes(id, fields) {
  const allowed = [
    'baseline_close',
    'stock_return_1_day',
    'stock_return_21_days',
    'sector_return_21_days',
    'sector_adjusted_return_21_days',
    'fundamental_result_2_quarters_later',
    'original_model_prediction_correct',
  ];
  const sets = allowed.filter((column) => fields[column] !== undefined);
  if (!sets.length) return;
  const sql = `UPDATE event_training_labels
    SET ${sets.map((column) => `${column} = @${column}`).join(', ')}, outcome_backfilled_at = datetime('now')
    WHERE id = @id`;
  db.prepare(sql).run({ id, ...fields });
}

function accuracyByCategory(userId) {
  return accuracyRows.all(userId);
}

function getCategoryMultipliers(userId) {
  const map = {};
  for (const row of multiplierRows.all(userId)) map[row.category] = row.multiplier;
  return map;
}

function listCategoryLearning(userId) {
  return multiplierRows.all(userId);
}

function upsertCategoryLearning(userId, rows) {
  for (const row of rows) {
    upsertLearning.run({
      userId,
      category: row.category,
      multiplier: row.multiplier,
      samples: row.samples,
      accuracy: row.accuracy ?? null,
    });
  }
}

function listRecent(userId, limit = 50) {
  return recentLabels.all(userId, limit);
}

module.exports = {
  saveLabels,
  listAwaitingReturns,
  listAwaitingFundamentals,
  updateOutcomes,
  accuracyByCategory,
  getCategoryMultipliers,
  listCategoryLearning,
  upsertCategoryLearning,
  listRecent,
};
