const crypto = require('crypto');
const db = require('../connection');

const insertSecurity = db.prepare(`
  INSERT INTO securities (
    user_id, symbol, permanent_id, exchange, security_type, listing_date, delisting_date,
    sector, industry, market_cap_usd, shares_outstanding, is_active, is_tradeable, exclusion_reason
  ) VALUES (
    @userId, @symbol, @permanentId, @exchange, @securityType, @listingDate, @delistingDate,
    @sector, @industry, @marketCapUsd, @sharesOutstanding, @isActive, @isTradeable, @exclusionReason
  )
  ON CONFLICT(user_id, symbol, permanent_id) DO UPDATE SET
    exchange = excluded.exchange,
    security_type = excluded.security_type,
    listing_date = excluded.listing_date,
    delisting_date = excluded.delisting_date,
    sector = excluded.sector,
    industry = excluded.industry,
    market_cap_usd = excluded.market_cap_usd,
    shares_outstanding = excluded.shares_outstanding,
    is_active = excluded.is_active,
    is_tradeable = excluded.is_tradeable,
    exclusion_reason = excluded.exclusion_reason,
    updated_at = datetime('now')
`);

const getSecurityStmt = db.prepare('SELECT * FROM securities WHERE user_id = ? AND symbol = ? ORDER BY is_active DESC, id DESC LIMIT 1');
const listSecuritiesStmt = db.prepare('SELECT * FROM securities WHERE user_id = ? ORDER BY symbol');

const insertRawSource = db.prepare(`
  INSERT OR IGNORE INTO raw_source_data (
    user_id, source_name, source_url, content_hash, content_type, observed_at,
    available_at, revision_version, payload_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getRawByHash = db.prepare('SELECT * FROM raw_source_data WHERE user_id = ? AND source_name = ? AND content_hash = ? AND revision_version = ?');

const insertBar = db.prepare(`
  INSERT INTO pit_market_bars (
    user_id, security_id, symbol, bar_date, open_unadjusted, high_unadjusted, low_unadjusted,
    close_unadjusted, close_adjusted, volume, bid, ask, data_source, source_raw_id,
    as_of, available_at, revision_version
  ) VALUES (
    @userId, @securityId, @symbol, @barDate, @openUnadjusted, @highUnadjusted, @lowUnadjusted,
    @closeUnadjusted, @closeAdjusted, @volume, @bid, @ask, @dataSource, @sourceRawId,
    @asOf, @availableAt, @revisionVersion
  )
  ON CONFLICT(user_id, symbol, bar_date, data_source, revision_version) DO UPDATE SET
    security_id = excluded.security_id,
    open_unadjusted = excluded.open_unadjusted,
    high_unadjusted = excluded.high_unadjusted,
    low_unadjusted = excluded.low_unadjusted,
    close_unadjusted = excluded.close_unadjusted,
    close_adjusted = excluded.close_adjusted,
    volume = excluded.volume,
    bid = excluded.bid,
    ask = excluded.ask,
    source_raw_id = excluded.source_raw_id,
    as_of = excluded.as_of,
    available_at = excluded.available_at
`);
const listBarsStmt = db.prepare('SELECT * FROM pit_market_bars WHERE user_id = ? ORDER BY symbol, bar_date');
const listBarsBySymbolsStmt = db.prepare(`
  SELECT * FROM pit_market_bars
  WHERE user_id = @userId AND symbol IN (SELECT value FROM json_each(@symbolsJson))
  ORDER BY symbol, bar_date
`);

const insertQuality = db.prepare(`
  INSERT INTO data_quality_reports (user_id, dataset_version, scope, status, critical, metrics_json, warnings_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const byQualityId = db.prepare('SELECT * FROM data_quality_reports WHERE id = ?');
const latestQualityStmt = db.prepare('SELECT * FROM data_quality_reports WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1');
const listQualityStmt = db.prepare('SELECT * FROM data_quality_reports WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');

const insertFeatureSet = db.prepare(`
  INSERT INTO feature_sets (user_id, dataset_version, feature_version, status, quality_report_id, metadata_json)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, dataset_version, feature_version) DO UPDATE SET
    status = excluded.status,
    quality_report_id = excluded.quality_report_id,
    metadata_json = excluded.metadata_json
`);
const featureSetByKey = db.prepare('SELECT * FROM feature_sets WHERE user_id = ? AND dataset_version = ? AND feature_version = ?');
const insertFeatureRow = db.prepare(`
  INSERT INTO feature_rows (feature_set_id, symbol, as_of, available_at, features_json)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(feature_set_id, symbol) DO UPDATE SET
    as_of = excluded.as_of,
    available_at = excluded.available_at,
    features_json = excluded.features_json
`);
const listFeatureRowsStmt = db.prepare(`
  SELECT fr.*
  FROM feature_rows fr
  JOIN feature_sets fs ON fs.id = fr.feature_set_id
  WHERE fs.user_id = ? AND fs.dataset_version = ? AND fs.feature_version = ?
  ORDER BY fr.symbol
`);

const insertModel = db.prepare(`
  INSERT INTO model_registry (
    user_id, model_version, model_type, artifact_hash, status, approved_by, approved_at,
    promotion_report_json, metrics_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, model_version) DO UPDATE SET
    model_type = excluded.model_type,
    artifact_hash = excluded.artifact_hash,
    status = excluded.status,
    approved_by = excluded.approved_by,
    approved_at = excluded.approved_at,
    promotion_report_json = excluded.promotion_report_json,
    metrics_json = excluded.metrics_json
`);
const modelByVersion = db.prepare('SELECT * FROM model_registry WHERE user_id = ? AND model_version = ?');
const activeChampionStmt = db.prepare("SELECT * FROM model_registry WHERE user_id = ? AND status = 'champion' ORDER BY approved_at DESC, id DESC LIMIT 1");
const listModelsStmt = db.prepare('SELECT * FROM model_registry WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');

const upsertPromotionReviewStmt = db.prepare(`
  INSERT INTO model_promotion_reviews (
    user_id, challenger_model_version, champion_model_version, review_status,
    gate_results_json, backtest_run_id, approved_by, approved_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, challenger_model_version) DO UPDATE SET
    champion_model_version = excluded.champion_model_version,
    review_status = excluded.review_status,
    gate_results_json = excluded.gate_results_json,
    backtest_run_id = excluded.backtest_run_id,
    approved_by = excluded.approved_by,
    approved_at = excluded.approved_at
`);
const getPromotionReviewStmt = db.prepare('SELECT * FROM model_promotion_reviews WHERE user_id = ? AND challenger_model_version = ?');
const listPromotionReviewsStmt = db.prepare('SELECT * FROM model_promotion_reviews WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');

const insertTrainingSnapshotStmt = db.prepare(`
  INSERT OR IGNORE INTO model_training_snapshots (
    user_id, snapshot_id, model_version, dataset_version, feature_version,
    artifact_hash, artifact_json, metrics_json, created_by
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getTrainingSnapshotStmt = db.prepare('SELECT * FROM model_training_snapshots WHERE user_id = ? AND snapshot_id = ?');
const listTrainingSnapshotsStmt = db.prepare('SELECT * FROM model_training_snapshots WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');

const insertRollbackStmt = db.prepare(`
  INSERT OR IGNORE INTO model_rollback_events (
    user_id, rollback_id, from_model_version, to_model_version, approved_by, reason
  ) VALUES (?, ?, ?, ?, ?, ?)
`);
const getRollbackStmt = db.prepare('SELECT * FROM model_rollback_events WHERE user_id = ? AND rollback_id = ?');
const listRollbackEventsStmt = db.prepare('SELECT * FROM model_rollback_events WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');

const insertPortfolio = db.prepare(`
  INSERT INTO portfolio_targets (
    user_id, run_id, dataset_version, feature_version, model_version, strategy_version, market_regime, target_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, run_id) DO UPDATE SET
    dataset_version = excluded.dataset_version,
    feature_version = excluded.feature_version,
    model_version = excluded.model_version,
    strategy_version = excluded.strategy_version,
    market_regime = excluded.market_regime,
    target_json = excluded.target_json
`);

const insertRisk = db.prepare(`
  INSERT INTO risk_check_results (user_id, run_id, symbol, check_name, status, severity, reason, details_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const listRiskStmt = db.prepare('SELECT * FROM risk_check_results WHERE user_id = ? AND run_id = ? ORDER BY id');

const insertAudit = db.prepare(`
  INSERT INTO spec_audit_events (user_id, run_id, event_type, entity_type, entity_id, payload_json)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const listAuditStmt = db.prepare('SELECT * FROM spec_audit_events WHERE user_id = ? AND run_id = ? ORDER BY id');

const insertPaperIntent = db.prepare(`
  INSERT INTO paper_order_intents (
    user_id, run_id, client_order_id, symbol, side, quantity, limit_price, notional_usd,
    status, reason_codes_json, risk_result_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const listPaperIntentsStmt = db.prepare('SELECT * FROM paper_order_intents WHERE user_id = ? AND run_id = ? ORDER BY id');

const insertCorporateAction = db.prepare(`
  INSERT INTO corporate_actions (
    user_id, symbol, action_type, ex_date, effective_at, available_at, ratio,
    cash_amount, new_symbol, details_json, source_raw_id, revision_version
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, symbol, action_type, ex_date, revision_version) DO UPDATE SET
    effective_at = excluded.effective_at,
    available_at = excluded.available_at,
    ratio = excluded.ratio,
    cash_amount = excluded.cash_amount,
    new_symbol = excluded.new_symbol,
    details_json = excluded.details_json,
    source_raw_id = excluded.source_raw_id
`);
const listCorporateActionsStmt = db.prepare(`
  SELECT * FROM corporate_actions
  WHERE user_id = @userId
    AND symbol IN (SELECT value FROM json_each(@symbolsJson))
  ORDER BY available_at, ex_date, id
`);

const upsertCalendarDayStmt = db.prepare(`
  INSERT INTO market_calendar_days (
    market, session_date, is_open, open_at, close_at, early_close, reason, source_raw_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(market, session_date) DO UPDATE SET
    is_open = excluded.is_open,
    open_at = excluded.open_at,
    close_at = excluded.close_at,
    early_close = excluded.early_close,
    reason = excluded.reason,
    source_raw_id = excluded.source_raw_id
`);
const listCalendarDaysStmt = db.prepare(`
  SELECT * FROM market_calendar_days
  WHERE market = ? AND session_date BETWEEN ? AND ?
  ORDER BY session_date
`);
const getCalendarDayStmt = db.prepare('SELECT * FROM market_calendar_days WHERE market = ? AND session_date = ?');

const upsertUniverseMembershipStmt = db.prepare(`
  INSERT INTO universe_memberships (
    user_id, universe_version, symbol, permanent_id, member_from, member_to, reason, source_raw_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, universe_version, symbol, permanent_id) DO UPDATE SET
    member_from = excluded.member_from,
    member_to = excluded.member_to,
    reason = excluded.reason,
    source_raw_id = excluded.source_raw_id
`);
const listUniverseMembershipsStmt = db.prepare(`
  SELECT * FROM universe_memberships
  WHERE user_id = ? AND universe_version = ?
  ORDER BY symbol, permanent_id
`);

function upsertSecurity(userId, security) {
  const symbol = normalizeSymbol(security.symbol);
  insertSecurity.run({
    userId,
    symbol,
    permanentId: security.permanentId || `AUTO-${symbol}`,
    exchange: security.exchange || 'UNKNOWN',
    securityType: security.securityType || 'common_stock',
    listingDate: security.listingDate || null,
    delistingDate: security.delistingDate || null,
    sector: security.sector || null,
    industry: security.industry || null,
    marketCapUsd: finiteOrNull(security.marketCapUsd),
    sharesOutstanding: finiteOrNull(security.sharesOutstanding),
    isActive: security.isActive === false ? 0 : 1,
    isTradeable: security.isTradeable === false ? 0 : 1,
    exclusionReason: security.exclusionReason || null,
  });
  return getSecurity(userId, symbol);
}

function getSecurity(userId, symbol) {
  return getSecurityStmt.get(userId, normalizeSymbol(symbol));
}

function listSecurities(userId) {
  return listSecuritiesStmt.all(userId);
}

function saveRawSource({ userId, sourceName, sourceUrl, contentType = 'application/json', observedAt, availableAt, revisionVersion = 1, payload }) {
  const payloadJson = JSON.stringify(payload || {});
  const hash = crypto.createHash('sha256').update(payloadJson).digest('hex');
  insertRawSource.run(userId, sourceName, sourceUrl || null, hash, contentType, observedAt, availableAt, revisionVersion, payloadJson);
  return deserializeRaw(getRawByHash.get(userId, sourceName, hash, revisionVersion));
}

function saveMarketBars({ userId, bars }) {
  const tx = db.transaction((items) => {
    for (const bar of items) {
      const security = getSecurity(userId, bar.symbol) || upsertSecurity(userId, { symbol: bar.symbol });
      insertBar.run({
        userId,
        securityId: security.id,
        symbol: normalizeSymbol(bar.symbol),
        barDate: bar.barDate,
        openUnadjusted: finiteOrNull(bar.openUnadjusted),
        highUnadjusted: finiteOrNull(bar.highUnadjusted),
        lowUnadjusted: finiteOrNull(bar.lowUnadjusted),
        closeUnadjusted: finiteOrNull(bar.closeUnadjusted),
        closeAdjusted: finiteOrNull(bar.closeAdjusted ?? bar.closeUnadjusted),
        volume: finiteOrNull(bar.volume),
        bid: finiteOrNull(bar.bid),
        ask: finiteOrNull(bar.ask),
        dataSource: bar.dataSource || 'unknown',
        sourceRawId: bar.sourceRawId || null,
        asOf: bar.asOf || bar.barDate,
        availableAt: bar.availableAt || bar.asOf || bar.barDate,
        revisionVersion: bar.revisionVersion || 1,
      });
    }
  });
  tx(bars || []);
  return listBars(userId);
}

function listBars(userId, symbols) {
  const rows = symbols?.length
    ? listBarsBySymbolsStmt.all({ userId, symbolsJson: JSON.stringify(symbols.map(normalizeSymbol)) })
    : listBarsStmt.all(userId);
  return rows;
}

function createQualityReport({ userId, datasetVersion, scope, status, critical = false, metrics, warnings = [] }) {
  const { lastInsertRowid } = insertQuality.run(
    userId,
    datasetVersion,
    scope,
    status,
    critical ? 1 : 0,
    JSON.stringify(metrics || {}),
    JSON.stringify(warnings || [])
  );
  return deserializeQuality(byQualityId.get(lastInsertRowid));
}

function getLatestQualityReport(userId) {
  return deserializeQuality(latestQualityStmt.get(userId));
}

function listQualityReports(userId, limit = 20) {
  return listQualityStmt.all(userId, limit).map(deserializeQuality);
}

function saveFeatureSet({ userId, datasetVersion, featureVersion, status = 'created', qualityReportId = null, metadata = {}, rows = [] }) {
  const tx = db.transaction(() => {
    insertFeatureSet.run(userId, datasetVersion, featureVersion, status, qualityReportId, JSON.stringify(metadata));
    const featureSet = featureSetByKey.get(userId, datasetVersion, featureVersion);
    for (const row of rows) {
      insertFeatureRow.run(featureSet.id, normalizeSymbol(row.symbol), row.asOf, row.availableAt, JSON.stringify(row.features || {}));
    }
  });
  tx();
  return getFeatureRows(userId, datasetVersion, featureVersion);
}

function getFeatureRows(userId, datasetVersion, featureVersion) {
  return listFeatureRowsStmt.all(userId, datasetVersion, featureVersion).map((row) => ({
    ...row,
    features: JSON.parse(row.features_json),
  }));
}

function upsertModel({ userId, modelVersion, modelType, artifactHash, status, approvedBy = null, approvedAt = null, promotionReport = {}, metrics = {} }) {
  insertModel.run(
    userId,
    modelVersion,
    modelType,
    artifactHash,
    status,
    approvedBy,
    approvedAt,
    JSON.stringify(promotionReport),
    JSON.stringify(metrics)
  );
  return getModel(userId, modelVersion);
}

function getModel(userId, modelVersion) {
  return deserializeModel(modelByVersion.get(userId, modelVersion));
}

function getActiveChampion(userId) {
  return deserializeModel(activeChampionStmt.get(userId));
}

function listModels(userId, limit = 50) {
  return listModelsStmt.all(userId, limit).map(deserializeModel);
}

function savePromotionReview({ userId, challengerModelVersion, championModelVersion = null, reviewStatus, gateResults = [], backtestRunId = null, approvedBy = null, approvedAt = null }) {
  upsertPromotionReviewStmt.run(
    userId,
    challengerModelVersion,
    championModelVersion,
    reviewStatus,
    JSON.stringify(gateResults),
    backtestRunId,
    approvedBy,
    approvedAt
  );
  return getPromotionReview(userId, challengerModelVersion);
}

function getPromotionReview(userId, challengerModelVersion) {
  return deserializePromotionReview(getPromotionReviewStmt.get(userId, challengerModelVersion));
}

function listPromotionReviews(userId, limit = 20) {
  return listPromotionReviewsStmt.all(userId, limit).map(deserializePromotionReview);
}

function saveTrainingSnapshot({ userId, snapshotId, modelVersion, datasetVersion, featureVersion, artifactHash, artifact = {}, metrics = {}, createdBy }) {
  insertTrainingSnapshotStmt.run(
    userId,
    snapshotId,
    modelVersion,
    datasetVersion,
    featureVersion,
    artifactHash,
    JSON.stringify(artifact),
    JSON.stringify(metrics),
    createdBy
  );
  return getTrainingSnapshot(userId, snapshotId);
}

function getTrainingSnapshot(userId, snapshotId) {
  return deserializeTrainingSnapshot(getTrainingSnapshotStmt.get(userId, snapshotId));
}

function listTrainingSnapshots(userId, limit = 20) {
  return listTrainingSnapshotsStmt.all(userId, limit).map(deserializeTrainingSnapshot);
}

function saveRollbackEvent({ userId, rollbackId, fromModelVersion, toModelVersion, approvedBy, reason = null }) {
  insertRollbackStmt.run(userId, rollbackId, fromModelVersion, toModelVersion, approvedBy, reason);
  return getRollbackEvent(userId, rollbackId);
}

function getRollbackEvent(userId, rollbackId) {
  return getRollbackStmt.get(userId, rollbackId);
}

function listRollbackEvents(userId, limit = 20) {
  return listRollbackEventsStmt.all(userId, limit);
}

function savePortfolioTarget({ userId, runId, datasetVersion, featureVersion, modelVersion, strategyVersion, marketRegime, target }) {
  insertPortfolio.run(userId, runId, datasetVersion, featureVersion, modelVersion, strategyVersion, marketRegime, JSON.stringify(target));
}

function saveRiskChecks({ userId, runId, checks }) {
  const tx = db.transaction((items) => {
    for (const check of items || []) {
      insertRisk.run(userId, runId, check.symbol || null, check.checkName, check.status, check.severity, check.reason, JSON.stringify(check.details || {}));
    }
  });
  tx(checks || []);
  return listRiskChecks(userId, runId);
}

function listRiskChecks(userId, runId) {
  return listRiskStmt.all(userId, runId).map((row) => ({ ...row, details: JSON.parse(row.details_json) }));
}

function audit({ userId, runId, eventType, entityType, entityId = null, payload = {} }) {
  insertAudit.run(userId, runId, eventType, entityType, entityId, JSON.stringify(payload));
}

function listAuditEvents(userId, runId) {
  return listAuditStmt.all(userId, runId).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
}

function savePaperOrderIntents({ userId, runId, intents }) {
  const tx = db.transaction((items) => {
    for (const intent of items || []) {
      insertPaperIntent.run(
        userId,
        runId,
        intent.clientOrderId,
        normalizeSymbol(intent.symbol),
        intent.side,
        intent.quantity,
        finiteOrNull(intent.limitPrice),
        intent.notionalUsd,
        intent.status || 'planned',
        JSON.stringify(intent.reasonCodes || []),
        JSON.stringify(intent.riskResult || {})
      );
    }
  });
  tx(intents || []);
  return listPaperOrderIntents(userId, runId);
}

function listPaperOrderIntents(userId, runId) {
  return listPaperIntentsStmt.all(userId, runId).map((row) => ({
    ...row,
    reasonCodes: JSON.parse(row.reason_codes_json),
    riskResult: JSON.parse(row.risk_result_json),
  }));
}

function saveCorporateActions({ userId, actions }) {
  const tx = db.transaction((items) => {
    for (const action of items || []) {
      insertCorporateAction.run(
        userId,
        normalizeSymbol(action.symbol),
        action.actionType || action.action_type,
        action.exDate || action.ex_date,
        action.effectiveAt || action.effective_at || action.exDate || action.ex_date,
        action.availableAt || action.available_at || action.effectiveAt || action.effective_at || action.exDate || action.ex_date,
        finiteOrNull(action.ratio),
        finiteOrNull(action.cashAmount ?? action.cash_amount),
        action.newSymbol ? normalizeSymbol(action.newSymbol) : action.new_symbol ? normalizeSymbol(action.new_symbol) : null,
        JSON.stringify(action.details || {}),
        action.sourceRawId || action.source_raw_id || null,
        action.revisionVersion || action.revision_version || 1
      );
    }
  });
  tx(actions || []);
  return listCorporateActions(userId, (actions || []).map((action) => action.symbol));
}

function listCorporateActions(userId, symbols) {
  const normalized = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))];
  if (!normalized.length) return [];
  return listCorporateActionsStmt.all({ userId, symbolsJson: JSON.stringify(normalized) }).map(deserializeCorporateAction);
}

function saveMarketCalendarDays({ market = 'US', days }) {
  const tx = db.transaction((items) => {
    for (const day of items || []) {
      upsertCalendarDayStmt.run(
        market,
        day.sessionDate || day.session_date,
        day.isOpen === false || day.is_open === 0 ? 0 : 1,
        day.openAt || day.open_at || null,
        day.closeAt || day.close_at || null,
        day.earlyClose || day.early_close ? 1 : 0,
        day.reason || null,
        day.sourceRawId || day.source_raw_id || null
      );
    }
  });
  tx(days || []);
  const dates = (days || []).map((day) => day.sessionDate || day.session_date).filter(Boolean).sort();
  if (!dates.length) return [];
  return listMarketCalendarDays(market, dates[0], dates[dates.length - 1]);
}

function getMarketCalendarDay(market = 'US', sessionDate) {
  return getCalendarDayStmt.get(market, sessionDate);
}

function listMarketCalendarDays(market = 'US', startDate = '0000-01-01', endDate = '9999-12-31') {
  return listCalendarDaysStmt.all(market, startDate, endDate);
}

function saveUniverseMemberships({ userId, universeVersion, memberships }) {
  const tx = db.transaction((items) => {
    for (const membership of items || []) {
      const symbol = normalizeSymbol(membership.symbol);
      upsertUniverseMembershipStmt.run(
        userId,
        universeVersion,
        symbol,
        membership.permanentId || membership.permanent_id || `AUTO-${symbol}`,
        membership.memberFrom || membership.member_from || null,
        membership.memberTo || membership.member_to || null,
        membership.reason || null,
        membership.sourceRawId || membership.source_raw_id || null
      );
    }
  });
  tx(memberships || []);
  return listUniverseMemberships(userId, universeVersion);
}

function listUniverseMemberships(userId, universeVersion) {
  return listUniverseMembershipsStmt.all(userId, universeVersion);
}

function deserializeRaw(row) {
  return row ? { ...row, payload: JSON.parse(row.payload_json) } : null;
}

function deserializeQuality(row) {
  return row ? { ...row, metrics: JSON.parse(row.metrics_json), warnings: JSON.parse(row.warnings_json) } : null;
}

function deserializeModel(row) {
  return row ? { ...row, promotionReport: JSON.parse(row.promotion_report_json), metrics: JSON.parse(row.metrics_json) } : null;
}

function deserializePromotionReview(row) {
  return row ? { ...row, gateResults: JSON.parse(row.gate_results_json) } : null;
}

function deserializeTrainingSnapshot(row) {
  return row ? { ...row, artifact: JSON.parse(row.artifact_json), metrics: JSON.parse(row.metrics_json) } : null;
}

function deserializeCorporateAction(row) {
  return row ? { ...row, details: JSON.parse(row.details_json) } : null;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z.]/g, '');
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = {
  upsertSecurity,
  getSecurity,
  listSecurities,
  saveRawSource,
  saveMarketBars,
  listBars,
  createQualityReport,
  getLatestQualityReport,
  listQualityReports,
  saveFeatureSet,
  getFeatureRows,
  upsertModel,
  getModel,
  getActiveChampion,
  listModels,
  savePromotionReview,
  getPromotionReview,
  listPromotionReviews,
  saveTrainingSnapshot,
  getTrainingSnapshot,
  listTrainingSnapshots,
  saveRollbackEvent,
  getRollbackEvent,
  listRollbackEvents,
  savePortfolioTarget,
  saveRiskChecks,
  listRiskChecks,
  audit,
  listAuditEvents,
  savePaperOrderIntents,
  listPaperOrderIntents,
  saveCorporateActions,
  listCorporateActions,
  saveMarketCalendarDays,
  getMarketCalendarDay,
  listMarketCalendarDays,
  saveUniverseMemberships,
  listUniverseMemberships,
};
