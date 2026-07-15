const analystDecisionGate = require('../src/services/analystDecisionGateService');

describe('analystDecisionGateService', () => {
  it('blocks generic analyst Buy evidence from becoming a direct buy signal', () => {
    const result = analystDecisionGate.evaluateAnalystDecisionGate({
      candidate: {
        symbol: 'XYZ',
        localAiScore: 88,
        volatilityPct: 2,
        changePct: 1,
        evidence: { quote: { current: 25 } },
      },
      marketBeatIntel: {
        signals: [
          {
            symbol: 'XYZ',
            action: 'Buy',
            newRating: 'Buy',
            reason: 'Analyst says Buy.',
          },
        ],
      },
    });

    expect(result.analystDriven).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.status).toBe('analyst-evidence-blocked');
    expect(result.directBuyAllowed).toBe(false);
    expect(result.gates.find((gate) => gate.key === 'analyst-upgrade-detected').passed).toBe(false);
    expect(result.gates.find((gate) => gate.key === 'sec-filing-data-supports-thesis').passed).toBe(false);
  });

  it('passes only when the full analyst upgrade rule clears for further evaluation', () => {
    const result = analystDecisionGate.evaluateAnalystDecisionGate({
      now: new Date('2026-07-14T12:00:00Z'),
      candidate: {
        symbol: 'ABC',
        localAiScore: 84,
        brokerFactorScore: 76,
        volatilityPct: 2.5,
        changePct: 0.7,
        evidence: { quote: { current: 40 } },
      },
      quote: { current: 40, dollarVolume: 25000000 },
      marketBeatIntel: {
        compositeScore: 78,
        signals: [
          {
            symbol: 'ABC',
            source: 'marketbeat',
            action: 'upgrade',
            previousRating: 'Hold',
            newRating: 'Buy',
            previousTarget: 50,
            newTarget: 60,
            analystFirm: 'Example Capital',
            publishedAt: '2026-07-13T13:00:00Z',
            reason: 'Example Capital upgraded ABC and raised its price target.',
          },
        ],
      },
      factorIntel: {
        compositeScore: 72,
        secFilingFactor: {
          score: 74,
          stance: 'constructive',
          latestForm: '10-Q',
          latestFilingDate: '2026-07-11',
        },
      },
      secOwnershipIntel: { compositeScore: 64 },
    });

    expect(result.passed).toBe(true);
    expect(result.status).toBe('possible-candidate-for-further-evaluation');
    expect(result.directBuyAllowed).toBe(false);
    expect(result.gates.map((gate) => gate.passed)).toEqual([true, true, true, true, true, true, true]);
    expect(analystDecisionGate.compactForBmcl(result)).toMatchObject({
      version: analystDecisionGate.RULE_VERSION,
      directBuyAllowed: false,
      bmclUse: expect.stringMatching(/further/i),
    });
  });
});
