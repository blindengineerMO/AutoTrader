const db = require('../connection');

const insertPlan = db.prepare(`
  INSERT INTO trading_plans (user_id, research_snapshot_id, model_used, raw_response_json, status, rejection_reason, execution_mode)
  VALUES (@userId, @researchSnapshotId, @modelUsed, @rawResponseJson, @status, @rejectionReason, @executionMode)
`);
const insertAction = db.prepare(`
  INSERT INTO plan_actions (trading_plan_id, symbol, action, quantity, rationale)
  VALUES (?, ?, ?, ?, ?)
`);
const listByUser = db.prepare('SELECT * FROM trading_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');
const actionsForPlan = db.prepare('SELECT * FROM plan_actions WHERE trading_plan_id = ?');
const updateActionStatus = db.prepare('UPDATE plan_actions SET status = ? WHERE id = ?');

function create({ userId, researchSnapshotId, modelUsed, rawResponse, status, rejectionReason, actions, executionMode = 'live' }) {
  const tx = db.transaction(() => {
    const { lastInsertRowid } = insertPlan.run({
      userId,
      researchSnapshotId,
      modelUsed,
      rawResponseJson: JSON.stringify(rawResponse),
      status,
      rejectionReason: rejectionReason || null,
      executionMode,
    });
    for (const a of actions || []) {
      insertAction.run(lastInsertRowid, a.symbol, a.action, a.quantity ?? null, a.rationale || null);
    }
    return lastInsertRowid;
  });
  const id = tx();
  return getById(id);
}

function getById(id) {
  const plan = db.prepare('SELECT * FROM trading_plans WHERE id = ?').get(id);
  if (!plan) return null;
  return { ...plan, rawResponse: JSON.parse(plan.raw_response_json), actions: actionsForPlan.all(id) };
}

module.exports = {
  create,
  getById,
  listByUser: (userId, limit = 20) => listByUser.all(userId, limit),
  actionsForPlan: (planId) => actionsForPlan.all(planId),
  setActionStatus: (actionId, status) => updateActionStatus.run(status, actionId),
};
