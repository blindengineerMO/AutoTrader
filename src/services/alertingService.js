const { config } = require('../config');
const logger = require('../utils/logger');

/**
 * Best-effort outbound alerting: fires a webhook POST (and, if configured,
 * would fan out to email) on safety-relevant events. Never throws and never
 * blocks/delays the caller — a failed alert must not affect the risk-engine
 * decision that triggered it.
 */
async function sendAlert({ type, severity = 'warning', userId, message, details = {} }) {
  const payload = {
    type,
    severity,
    userId,
    message,
    details,
    sentAt: new Date().toISOString(),
  };

  if (!config.alerting.webhookUrl) {
    logger.info('Alert generated but no ALERT_WEBHOOK_URL configured; logging only.', payload);
    return { delivered: false, reason: 'no-webhook-configured' };
  }

  try {
    const res = await fetch(config.alerting.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn('Alert webhook responded with a non-OK status.', { type, status: res.status });
      return { delivered: false, reason: `webhook-status-${res.status}` };
    }
    return { delivered: true };
  } catch (error) {
    logger.warn('Alert webhook delivery failed; continuing without blocking caller.', { type, error: error.message });
    return { delivered: false, reason: error.message };
  }
}

function alertKillSwitch({ userId, switchName, reason }) {
  return sendAlert({
    type: 'kill-switch-engaged',
    severity: 'critical',
    userId,
    message: `Kill switch engaged: ${switchName}`,
    details: { switchName, reason },
  });
}

function alertModelDrift({ userId, drop, baselineAccuracy, currentAccuracy }) {
  return sendAlert({
    type: 'model-drift-detected',
    severity: 'critical',
    userId,
    message: `Model drift detected: accuracy dropped ${drop.toFixed(1)} points.`,
    details: { baselineAccuracy, currentAccuracy, drop },
  });
}

function alertReconciliationFailure({ userId, runId, criticalCount }) {
  return sendAlert({
    type: 'reconciliation-failure',
    severity: 'critical',
    userId,
    message: `Reconciliation run ${runId} found ${criticalCount} critical difference(s).`,
    details: { runId, criticalCount },
  });
}

module.exports = {
  sendAlert,
  alertKillSwitch,
  alertModelDrift,
  alertReconciliationFailure,
};
