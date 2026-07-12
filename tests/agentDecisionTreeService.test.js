const agentDecisionTree = require('../src/services/agentDecisionTreeService');

describe('agentDecisionTreeService', () => {
  const agent = {
    id: 1,
    name: 'Quality Agent',
    bias: {
      factors: { riskPenalty: 0.1, moat: 0.2, longHorizon: 0.2 },
      sectors: { software: 0.2 },
    },
    model: {
      modelType: 'personality-bias-v1',
      decisionFramework: agentDecisionTree.buildDecisionFramework({
        bias: { factors: { riskPenalty: 0.1, moat: 0.2, longHorizon: 0.2 } },
      }),
    },
  };

  it('produces a full gated DECISION.md-style buy decision object', () => {
    const result = agentDecisionTree.evaluateSignalForAgent({
      agent,
      personaBiasScore: 20,
      signal: {
        symbol: 'MSFT',
        price: 100,
        changePct: 1.2,
        volatilityPct: 1.5,
        momentum: 'bullish',
        actionBias: 'buy-candidate',
        localAiScore: 92,
        brokerFactorScore: 88,
        investorPlaybookScore: 90,
        jsonDatasetScore: 82,
        theme: 'software+cloud+saas',
        evidence: {
          quote: { current: 100, open: 98, high: 101, low: 97, prevClose: 98 },
          explanation: ['Strong free-cash-flow proxy', 'Durable software demand'],
        },
        discovery: {
          evidence: [{ reason: 'New enterprise AI product adoption mentioned in crawled source.', url: 'https://example.com/source' }],
        },
        chatResearch: { reasons: ['Cloud demand appears resilient.'] },
      },
      context: { signals: [{ symbol: 'MSFT', localAiScore: 92 }, { symbol: 'SPY', localAiScore: 55 }], positions: [], accountState: { cash_balance_usd: 1000 } },
    });

    expect(result.version).toBe(agentDecisionTree.VERSION);
    expect(result.gates.map((gate) => gate.name)).toEqual(expect.arrayContaining([
      'data-quality',
      'intrinsic-value',
      'stress-tests',
      'position-sizing',
      'sell-decision-tree',
    ]));
    expect(result.decision.decision).toBe('BUY');
    expect(result.decision.position.initialWeight).toBeGreaterThan(0);
    expect(result.decision.requiredConditions.some((condition) => condition.includes('limit order'))).toBe(true);
    expect(result.investmentThesis.sellConditions.length).toBeGreaterThan(0);
  });

  it('fails hard gates for unusable price data and prevents buy recommendations', () => {
    const result = agentDecisionTree.evaluateSignalForAgent({
      agent,
      personaBiasScore: 100,
      signal: {
        symbol: 'BROKEN',
        price: 0,
        changePct: -5,
        volatilityPct: 20,
        actionBias: 'buy-candidate',
        localAiScore: 95,
        theme: 'software',
        evidence: {},
      },
      context: { signals: [], positions: [], accountState: {} },
    });

    expect(result.hardFailures).toEqual(expect.arrayContaining(['data-quality', 'hard-disqualifiers', 'stress-tests', 'independent-pretrade-controls']));
    expect(result.recommendedAction).not.toBe('buy');
    expect(result.decision.warnings.length).toBeGreaterThan(0);
  });
});
