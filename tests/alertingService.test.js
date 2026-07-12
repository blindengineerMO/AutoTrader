const { config } = require('../src/config');
const alertingService = require('../src/services/alertingService');

describe('alertingService', () => {
  const originalWebhookUrl = config.alerting.webhookUrl;
  const originalFetch = global.fetch;

  afterEach(() => {
    config.alerting.webhookUrl = originalWebhookUrl;
    global.fetch = originalFetch;
  });

  it('reports not-delivered without throwing when no webhook is configured', async () => {
    config.alerting.webhookUrl = '';
    const result = await alertingService.sendAlert({ type: 'test-event', userId: 1, message: 'hi' });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('no-webhook-configured');
  });

  it('POSTs the expected payload shape to the configured webhook', async () => {
    config.alerting.webhookUrl = 'https://example.com/webhook';
    let capturedUrl;
    let capturedOptions;
    global.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, status: 200 };
    };

    const result = await alertingService.sendAlert({
      type: 'kill-switch-engaged',
      severity: 'critical',
      userId: 42,
      message: 'Kill switch engaged: model_drift_kill_switch',
      details: { switchName: 'model_drift_kill_switch' },
    });

    expect(result.delivered).toBe(true);
    expect(capturedUrl).toBe('https://example.com/webhook');
    expect(capturedOptions.method).toBe('POST');
    const body = JSON.parse(capturedOptions.body);
    expect(body.type).toBe('kill-switch-engaged');
    expect(body.severity).toBe('critical');
    expect(body.userId).toBe(42);
    expect(body.details.switchName).toBe('model_drift_kill_switch');
    expect(body.sentAt).toBeTruthy();
  });

  it('does not throw and reports not-delivered when the webhook request fails', async () => {
    config.alerting.webhookUrl = 'https://example.com/webhook';
    global.fetch = async () => {
      throw new Error('network down');
    };

    await expect(
      alertingService.sendAlert({ type: 'test-event', userId: 1, message: 'hi' })
    ).resolves.toEqual({ delivered: false, reason: 'network down' });
  });

  it('does not throw and reports not-delivered when the webhook responds non-OK', async () => {
    config.alerting.webhookUrl = 'https://example.com/webhook';
    global.fetch = async () => ({ ok: false, status: 500 });

    const result = await alertingService.sendAlert({ type: 'test-event', userId: 1, message: 'hi' });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('webhook-status-500');
  });

  it('alertKillSwitch, alertModelDrift, and alertReconciliationFailure never reject even on webhook failure', async () => {
    config.alerting.webhookUrl = 'https://example.com/webhook';
    global.fetch = async () => {
      throw new Error('boom');
    };

    await expect(
      alertingService.alertKillSwitch({ userId: 1, switchName: 'model_drift_kill_switch', reason: 'test' })
    ).resolves.toEqual({ delivered: false, reason: 'boom' });
    await expect(
      alertingService.alertModelDrift({ userId: 1, drop: 30, baselineAccuracy: 80, currentAccuracy: 50 })
    ).resolves.toEqual({ delivered: false, reason: 'boom' });
    await expect(
      alertingService.alertReconciliationFailure({ userId: 1, runId: 1, criticalCount: 2 })
    ).resolves.toEqual({ delivered: false, reason: 'boom' });
  });
});
