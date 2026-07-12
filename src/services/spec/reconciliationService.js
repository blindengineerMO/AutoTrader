const brokerAccountRepo = require('../../db/repositories/brokerAccountRepo');
const positionRepo = require('../../db/repositories/positionRepo');
const specRepo = require('../../db/repositories/specResearchRepo');
const operationsRepo = require('../../db/repositories/specOperationsRepo');
const settingsRepo = require('../../db/repositories/settingsRepo');
const alertingService = require('../alertingService');

function reconcilePaperRun({ userId, runId }) {
  const intents = specRepo.listPaperOrderIntents(userId, runId);
  const orders = operationsRepo.listPaperBrokerOrdersByRun(userId, runId);
  const account = brokerAccountRepo.getDefault(userId, 'paper');
  const positions = account ? positionRepo.listByUser(userId) : [];
  const ordersByClientId = new Map(orders.map((order) => [order.client_order_id, order]));
  const expectedPositions = new Map();
  const differences = [];

  for (const intent of intents) {
    const order = ordersByClientId.get(intent.client_order_id);
    if (!order) {
      differences.push({
        symbol: intent.symbol,
        differenceType: 'missing_paper_order',
        severity: 'critical',
        expected: { clientOrderId: intent.client_order_id, status: intent.status },
        actual: {},
      });
      continue;
    }
    if (intent.status === 'planned' && order.status !== 'filled') {
      differences.push({
        symbol: intent.symbol,
        differenceType: 'paper_order_not_filled',
        severity: 'warning',
        expected: { status: 'filled' },
        actual: { status: order.status, reason: order.reason },
      });
    }
    if (order.status === 'filled') {
      const multiplier = order.side === 'buy' ? 1 : -1;
      expectedPositions.set(order.symbol, (expectedPositions.get(order.symbol) || 0) + multiplier * Number(order.quantity || 0));
    }
  }

  const positionBySymbol = new Map(positions.map((position) => [position.symbol, position]));
  for (const [symbol, expectedQty] of expectedPositions.entries()) {
    const actualQty = Number(positionBySymbol.get(symbol)?.quantity || 0);
    if (Math.abs(actualQty - expectedQty) > 0.000001) {
      differences.push({
        symbol,
        differenceType: 'position_quantity_mismatch',
        severity: 'critical',
        expected: { quantity: expectedQty },
        actual: { quantity: actualQty },
      });
    }
  }

  const status = differences.some((item) => item.severity === 'critical') ? 'fail' : differences.length ? 'warn' : 'ok';
  const run = operationsRepo.saveReconciliationRun({
    userId,
    runId,
    status,
    summary: {
      plannedIntents: intents.length,
      submittedOrders: orders.length,
      differences: differences.length,
      paperAccountId: account?.id || null,
    },
    differences,
  });

  if (status === 'fail') {
    const criticalCount = differences.filter((item) => item.severity === 'critical').length;
    settingsRepo.engageAutoKillSwitch(
      userId,
      'reconciliation_failure_kill_switch',
      `Reconciliation run ${runId} found ${criticalCount} critical difference(s) between planned intents and actual broker/position state.`
    );
    alertingService.alertReconciliationFailure({ userId, runId, criticalCount });
  }

  return run;
}

module.exports = { reconcilePaperRun };
