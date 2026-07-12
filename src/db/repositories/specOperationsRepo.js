const db = require('../connection');

const insertPaperOrder = db.prepare(`
  INSERT INTO paper_broker_orders (
    user_id, run_id, client_order_id, broker_order_id, symbol, side, quantity,
    requested_price, fill_price, status, reason, submitted_at, payload_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, client_order_id) DO UPDATE SET
    run_id = excluded.run_id
`);
const getPaperOrder = db.prepare('SELECT * FROM paper_broker_orders WHERE user_id = ? AND client_order_id = ?');
const listPaperOrdersByRunStmt = db.prepare('SELECT * FROM paper_broker_orders WHERE user_id = ? AND run_id = ? ORDER BY id');

const insertReconciliationRun = db.prepare(`
  INSERT INTO reconciliation_runs (user_id, run_id, status, summary_json)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id, run_id) DO UPDATE SET
    status = excluded.status,
    summary_json = excluded.summary_json
`);
const getReconciliationRun = db.prepare('SELECT * FROM reconciliation_runs WHERE user_id = ? AND run_id = ?');
const listReconciliationRunsStmt = db.prepare('SELECT * FROM reconciliation_runs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
const deleteDifferences = db.prepare('DELETE FROM reconciliation_differences WHERE user_id = ? AND reconciliation_run_id = ?');
const insertDifference = db.prepare(`
  INSERT INTO reconciliation_differences (
    user_id, reconciliation_run_id, symbol, difference_type, severity, expected_json, actual_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const listDifferencesStmt = db.prepare('SELECT * FROM reconciliation_differences WHERE user_id = ? AND reconciliation_run_id = ? ORDER BY id');

function savePaperBrokerOrder({ userId, runId = null, clientOrderId, brokerOrderId, symbol, side, quantity, requestedPrice = null, fillPrice = null, status, reason = null, submittedAt = new Date().toISOString(), payload = {} }) {
  insertPaperOrder.run(
    userId,
    runId,
    clientOrderId,
    brokerOrderId,
    normalizeSymbol(symbol),
    side,
    quantity,
    finiteOrNull(requestedPrice),
    finiteOrNull(fillPrice),
    status,
    reason,
    submittedAt,
    JSON.stringify(payload)
  );
  return getPaperBrokerOrder(userId, clientOrderId);
}

function getPaperBrokerOrder(userId, clientOrderId) {
  return deserializePaperOrder(getPaperOrder.get(userId, clientOrderId));
}

function listPaperBrokerOrdersByRun(userId, runId) {
  return listPaperOrdersByRunStmt.all(userId, runId).map(deserializePaperOrder);
}

function saveReconciliationRun({ userId, runId, status, summary = {}, differences = [] }) {
  const tx = db.transaction(() => {
    insertReconciliationRun.run(userId, runId, status, JSON.stringify(summary));
    deleteDifferences.run(userId, runId);
    for (const difference of differences || []) {
      insertDifference.run(
        userId,
        runId,
        difference.symbol ? normalizeSymbol(difference.symbol) : null,
        difference.differenceType,
        difference.severity,
        JSON.stringify(difference.expected || {}),
        JSON.stringify(difference.actual || {})
      );
    }
  });
  tx();
  return getReconciliation(userId, runId);
}

function getReconciliation(userId, runId) {
  const run = getReconciliationRun.get(userId, runId);
  if (!run) return null;
  return {
    ...run,
    summary: JSON.parse(run.summary_json),
    differences: listDifferences(userId, runId),
  };
}

function listReconciliations(userId, limit = 20) {
  return listReconciliationRunsStmt.all(userId, limit).map((row) => ({
    ...row,
    summary: JSON.parse(row.summary_json),
  }));
}

function listDifferences(userId, runId) {
  return listDifferencesStmt.all(userId, runId).map((row) => ({
    ...row,
    expected: JSON.parse(row.expected_json),
    actual: JSON.parse(row.actual_json),
  }));
}

function deserializePaperOrder(row) {
  return row ? { ...row, payload: JSON.parse(row.payload_json) } : null;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z.]/g, '');
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = {
  savePaperBrokerOrder,
  getPaperBrokerOrder,
  listPaperBrokerOrdersByRun,
  saveReconciliationRun,
  getReconciliation,
  listReconciliations,
};
