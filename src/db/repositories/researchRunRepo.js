const db = require('../connection');

const insertRun = db.prepare(`
  INSERT INTO research_runs (user_id, status, phase, progress, terminal_json)
  VALUES (?, 'queued', 'queued', 0, '[]')
`);

const byId = db.prepare('SELECT * FROM research_runs WHERE id = ?');
const latestByUser = db.prepare('SELECT * FROM research_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?');

// Reconcile runs left in queued/running by an unexpected restart. Anything older
// than the threshold is marked failed so it never blocks a future cycle; the next
// scheduled cron re-runs the work fresh (training is idempotent from the last
// atomically-saved model).
const markStaleRunningStmt = db.prepare(`
  UPDATE research_runs
  SET status = 'failed',
      phase = 'failed',
      error = 'terminated_by_restart',
      completed_at = datetime('now')
  WHERE status IN ('queued', 'running')
    AND started_at <= datetime('now', @cutoff)
`);
const listStaleRunningStmt = db.prepare(`
  SELECT id FROM research_runs
  WHERE status IN ('queued', 'running') AND started_at <= datetime('now', @cutoff)
`);

const updateState = db.prepare(`
  UPDATE research_runs
  SET status = @status,
      phase = @phase,
      progress = @progress,
      terminal_json = @terminalJson,
      research_snapshot_id = @researchSnapshotId,
      trading_plan_id = @tradingPlanId,
      decision_report_id = @decisionReportId,
      error = @error,
      completed_at = @completedAt
  WHERE id = @id
`);

function create(userId) {
  const { lastInsertRowid } = insertRun.run(userId);
  return getById(lastInsertRowid);
}

function appendEvent(runId, event) {
  const run = getById(runId);
  if (!run) return null;
  const terminal = [
    ...run.terminal,
    {
      ts: new Date().toISOString(),
      level: event.level || 'debug',
      phase: event.phase || run.phase,
      message: event.message,
      data: event.data || null,
    },
  ].slice(-300);
  return save({
    ...run,
    terminal,
    status: event.status || run.status,
    phase: event.phase || run.phase,
    progress: Number.isFinite(event.progress) ? event.progress : run.progress,
    error: event.error || run.error,
    completed_at: event.completedAt || run.completed_at,
  });
}

function markStarted(runId) {
  return appendEvent(runId, {
    status: 'running',
    phase: 'boot',
    progress: 3,
    level: 'info',
    message: 'Autonomous research operation started.',
  });
}

function markComplete(runId, { snapshotId, planId, reportId }) {
  const run = getById(runId);
  if (!run) return null;
  return save({
    ...run,
    status: 'complete',
    phase: 'complete',
    progress: 100,
    research_snapshot_id: snapshotId || run.research_snapshot_id,
    trading_plan_id: planId || run.trading_plan_id,
    decision_report_id: reportId || run.decision_report_id,
    completed_at: new Date().toISOString(),
    terminal: [
      ...run.terminal,
      {
        ts: new Date().toISOString(),
        level: 'info',
        phase: 'complete',
        message: 'Research, strategy evaluation, and report generation complete.',
        data: { snapshotId, planId, reportId },
      },
    ].slice(-300),
  });
}

function markFailed(runId, error) {
  const run = getById(runId);
  if (!run) return null;
  return save({
    ...run,
    status: 'failed',
    phase: 'failed',
    progress: 100,
    error: error.message || String(error),
    completed_at: new Date().toISOString(),
    terminal: [
      ...run.terminal,
      {
        ts: new Date().toISOString(),
        level: 'error',
        phase: 'failed',
        message: error.message || String(error),
        data: null,
      },
    ].slice(-300),
  });
}

function save(run) {
  updateState.run({
    id: run.id,
    status: run.status,
    phase: run.phase,
    progress: run.progress,
    terminalJson: JSON.stringify(run.terminal || []),
    researchSnapshotId: run.research_snapshot_id || null,
    tradingPlanId: run.trading_plan_id || null,
    decisionReportId: run.decision_report_id || null,
    error: run.error || null,
    completedAt: run.completed_at || null,
  });
  return getById(run.id);
}

function deserialize(row) {
  if (!row) return row;
  return {
    ...row,
    terminal: JSON.parse(row.terminal_json || '[]'),
  };
}

function getById(id) {
  return deserialize(byId.get(id));
}

function markStaleRunning({ olderThanMinutes = 0 } = {}) {
  const cutoff = `-${Math.max(0, olderThanMinutes)} minutes`;
  const stale = listStaleRunningStmt.all({ cutoff }).map((row) => row.id);
  markStaleRunningStmt.run({ cutoff });
  return stale;
}

module.exports = {
  create,
  appendEvent,
  markStarted,
  markComplete,
  markFailed,
  markStaleRunning,
  getById,
  listByUser: (userId, limit = 10) => latestByUser.all(userId, limit).map(deserialize),
};
