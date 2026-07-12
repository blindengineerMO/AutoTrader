const db = require('../connection');

const insertRun = db.prepare(`
  INSERT INTO backtest_runs (
    user_id, run_id, source_run_id, dataset_version, feature_version, model_version,
    strategy_version, random_seed, dependency_lock_hash, git_commit, status,
    metrics_json, assumptions_json, split_metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, run_id) DO UPDATE SET
    status = excluded.status,
    metrics_json = excluded.metrics_json,
    assumptions_json = excluded.assumptions_json,
    split_metadata_json = excluded.split_metadata_json
`);
const getRun = db.prepare('SELECT * FROM backtest_runs WHERE user_id = ? AND run_id = ?');
const listRunsStmt = db.prepare('SELECT * FROM backtest_runs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');

const insertEvent = db.prepare(`
  INSERT INTO backtest_events (user_id, backtest_run_id, event_ts, event_type, symbol, payload_json)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const listEventsStmt = db.prepare('SELECT * FROM backtest_events WHERE user_id = ? AND backtest_run_id = ? ORDER BY event_ts, id');

const upsertMonitoring = db.prepare(`
  INSERT INTO monitoring_status (user_id, status_key, status, details_json, observed_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, status_key) DO UPDATE SET
    status = excluded.status,
    details_json = excluded.details_json,
    observed_at = datetime('now')
`);
const listMonitoringStmt = db.prepare('SELECT * FROM monitoring_status WHERE user_id = ? ORDER BY status_key');

function saveRun({ userId, runId, sourceRunId = null, datasetVersion, featureVersion, modelVersion, strategyVersion, randomSeed = 0, dependencyLockHash = null, gitCommit = null, status, metrics = {}, assumptions = {}, splitMetadata = null }) {
  insertRun.run(
    userId,
    runId,
    sourceRunId,
    datasetVersion,
    featureVersion,
    modelVersion,
    strategyVersion,
    randomSeed,
    dependencyLockHash,
    gitCommit,
    status,
    JSON.stringify(metrics),
    JSON.stringify(assumptions),
    splitMetadata ? JSON.stringify(splitMetadata) : null
  );
  return deserializeRun(getRun.get(userId, runId));
}

function appendEvents({ userId, runId, events }) {
  const tx = db.transaction((items) => {
    for (const event of items || []) {
      insertEvent.run(userId, runId, event.ts, event.type, event.symbol || null, JSON.stringify(event.payload || {}));
    }
  });
  tx(events || []);
  return listEvents(userId, runId);
}

function listEvents(userId, runId) {
  return listEventsStmt.all(userId, runId).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
}

function listRuns(userId, limit = 20) {
  return listRunsStmt.all(userId, limit).map(deserializeRun);
}

function upsertStatus({ userId, statusKey, status, details = {} }) {
  upsertMonitoring.run(userId, statusKey, status, JSON.stringify(details));
}

function listMonitoring(userId) {
  return listMonitoringStmt.all(userId).map((row) => ({ ...row, details: JSON.parse(row.details_json) }));
}

function deserializeRun(row) {
  return row
    ? {
        ...row,
        metrics: JSON.parse(row.metrics_json),
        assumptions: JSON.parse(row.assumptions_json),
        splitMetadata: row.split_metadata_json ? JSON.parse(row.split_metadata_json) : null,
      }
    : null;
}

module.exports = {
  saveRun,
  appendEvents,
  listEvents,
  listRuns,
  upsertStatus,
  listMonitoring,
};
