const crossSourceAgreement = require('../src/services/crossSourceAgreementService');

describe('crossSourceAgreementService', () => {
  it('passes a buy when at least three independent lanes agree', () => {
    const result = crossSourceAgreement.evaluateSignalAgreement({
      action: 'buy',
      signal: {
        symbol: 'NVDA',
        momentum: 'bullish',
        changePct: 2.4,
        localAiScore: 74,
        financialEventScore: 61,
      },
      researchSummary: {
        sourceStack: [
          { type: 'market-data' },
          { type: 'news' },
          { type: 'financial' },
        ],
        reportNarrative: {
          topCandidates: [{ symbol: 'NVDA', bias: 'buy bullish opportunity' }],
        },
      },
    });

    expect(result.passed).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(3);
  });

  it('downgrades buy and sell actions to hold when agreement is too thin', () => {
    const [action] = crossSourceAgreement.enforcePlanAgreement({
      actions: [{ symbol: 'ABC', action: 'buy', quantity: 1, rationale: 'single source momentum' }],
      researchSnapshot: {
        summary: { sourceStack: [{ type: 'market-data' }] },
        signals: [{ symbol: 'ABC', momentum: 'bullish', changePct: 2 }],
      },
      positions: [],
    });

    expect(action.action).toBe('hold');
    expect(action.quantity).toBeNull();
    expect(action.rationale).toContain('Cross-source agreement gate downgraded this to HOLD');
  });
});
