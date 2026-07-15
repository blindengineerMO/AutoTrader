const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-decision-report-service.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const decisionReportService = require('../src/services/decisionReportService');

describe('decisionReportService.buildDecisionReport', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `decision-report-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  it('joins each plan action to its matching research signal by symbol and persists the report', () => {
    const plan = {
      id: null,
      model_used: 'gpt-test',
      status: 'proposed',
      rawResponse: { overallRationale: 'Buy the dip.' },
      actions: [
        { symbol: 'AAPL', action: 'buy', quantity: 1, status: 'proposed', rationale: 'Undervalued' },
        { symbol: 'MSFT', action: 'hold', quantity: 0, status: 'proposed', rationale: 'No signal' },
        { symbol: 'F', action: 'sell', quantity: 2, status: 'proposed', rationale: 'Current owned position review recommends sell after weak score.' },
      ],
    };
    const researchSnapshot = {
      id: null,
      source: 'safe-mvp',
      summary: { sourceStack: ['sec-filings'], reportNarrative: 'Markets calm.', prePlan: null },
      signals: [
        { symbol: 'AAPL', price: 190, changePct: 1.2, volatilityPct: 0.5, momentum: 'up', actionBias: 'buy', localAiScore: 0.8, theme: 'value', newsSentiment: 0.4, macroRisk: 'low', consumerBias: 'neutral', brokerFactorScore: 0.6, investorPlaybookScore: 0.7, jsonDatasetScore: 0.5, brainModelKey: 'aapl-v1', evidence: { discovery: 'sec-10k', historicalWatchFactors: ['margin-expansion'], explanation: ['strong margins'], quote: 'Revenue up 12%.' } },
        { symbol: 'F', price: 13, changePct: -1.1, volatilityPct: 1.8, momentum: 'down', actionBias: 'sell-or-avoid', localAiScore: 32, theme: 'auto', evidence: { explanation: ['auto demand weakening'] } },
      ],
    };

    const report = decisionReportService.buildDecisionReport({
      userId,
      plan,
      researchSnapshot,
      mode: 'simulation',
      liveReady: false,
      modeReason: 'Model not yet promoted to champion',
      accountState: { cashUsd: 1000 },
      brokerAccount: { status: 'connected' },
      positions: [
        { id: 7, symbol: 'F', quantity: 2, avg_cost_usd: 14, updated_at: '2026-07-14 10:00:00' },
        { id: 8, symbol: 'TSLA', quantity: 1, avg_cost_usd: 220, updated_at: '2026-07-14 10:00:00' },
      ],
    });

    expect(report.summary.actions).toHaveLength(3);
    const aaplAction = report.summary.actions.find((a) => a.symbol === 'AAPL');
    expect(aaplAction.evidence.price).toBe(190);
    expect(aaplAction.evidence.discovery).toBe('sec-10k');
    expect(aaplAction.evidence.historicalWatchFactors).toEqual(['margin-expansion']);

    const msftAction = report.summary.actions.find((a) => a.symbol === 'MSFT');
    expect(msftAction.evidence).toBeNull();
    const fordAction = report.summary.actions.find((a) => a.symbol === 'F');
    expect(fordAction.ownedPosition).toMatchObject({ quantity: 2, avgCostUsd: 14, currentResearchPriceUsd: 13 });
    expect(fordAction.positionReviewAction).toBe('sell');
    expect(report.summary.ownedPositionReviews).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: 'F',
        action: 'sell',
        executableAction: 'sell',
        position: expect.objectContaining({ unrealizedPnlUsd: -2 }),
      }),
      expect.objectContaining({
        symbol: 'TSLA',
        action: 'hold',
        executableAction: 'hold',
        rationale: expect.stringMatching(/no explicit plan action/i),
      }),
    ]));

    expect(report.summary.mode).toBe('simulation');
    expect(report.summary.liveReady).toBe(false);
    expect(report.summary.brokerAccountStatus).toBe('connected');
    expect(report.summary.researchNarrative).toBe('Markets calm.');
  });

  it('defaults brokerAccountStatus to not_connected when no broker account is supplied', () => {
    const report = decisionReportService.buildDecisionReport({
      userId,
      plan: { id: null, actions: [], rawResponse: {} },
      researchSnapshot: { id: null, source: 'safe-mvp', summary: {}, signals: [] },
      mode: 'simulation',
      liveReady: false,
      modeReason: 'n/a',
      accountState: {},
      brokerAccount: null,
    });
    expect(report.summary.brokerAccountStatus).toBe('not_connected');
    expect(report.summary.actions).toEqual([]);
  });
});
