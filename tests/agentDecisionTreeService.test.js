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

  it('keeps analyst-driven ideas on hold when the practical analyst gate fails', () => {
    const result = agentDecisionTree.evaluateSignalForAgent({
      agent,
      personaBiasScore: 100,
      signal: {
        symbol: 'AAPL',
        price: 100,
        changePct: 1,
        volatilityPct: 1.2,
        momentum: 'bullish',
        actionBias: 'buy-candidate',
        localAiScore: 95,
        brokerFactorScore: 92,
        investorPlaybookScore: 94,
        jsonDatasetScore: 90,
        theme: 'software+consumer',
        evidence: {
          quote: { current: 100, open: 99, high: 101, low: 98, prevClose: 99 },
          explanation: ['Analyst says Buy, but no SEC or valuation corroboration is attached.'],
          analystDecisionGate: {
            version: 'analyst-decision-gate-v1',
            symbol: 'AAPL',
            analystDriven: true,
            passed: false,
            status: 'analyst-evidence-blocked',
            compositeScore: 38,
            summary: 'Analyst evidence is not sufficient for a buy candidate yet.',
            gates: [
              { key: 'analyst-upgrade-detected', passed: false },
              { key: 'sec-filing-data-supports-thesis', passed: false },
            ],
          },
        },
        discovery: {
          evidence: [{ reason: 'New product thesis found in crawled source.', url: 'https://example.com/source' }],
        },
      },
      context: { signals: [{ symbol: 'AAPL', localAiScore: 95 }], positions: [], accountState: { cash_balance_usd: 2000 } },
    });

    expect(result.gates.find((gate) => gate.name === 'analyst-recommendation-gate')).toMatchObject({
      status: 'warn',
      score: 38,
    });
    expect(result.recommendedAction).toBe('hold');
    expect(result.decision.decision).toBe('HOLD');
  });

  describe('applyInvestingMode', () => {
    const baseMandate = agentDecisionTree.buildAgentMandate({
      bias: { factors: { riskPenalty: 0.1, moat: 0.2, longHorizon: 0.2 } },
    });

    it('loosens the mandate for aggressive mode', () => {
      const mandate = agentDecisionTree.applyInvestingMode(baseMandate, 'aggressive');
      expect(mandate.requiredMarginOfSafety).toBeLessThan(baseMandate.requiredMarginOfSafety);
      expect(mandate.maximumPositionWeight).toBeGreaterThan(baseMandate.maximumPositionWeight);
      expect(mandate.targetHoldingPeriodMonths).toBeLessThan(baseMandate.targetHoldingPeriodMonths);
      expect(mandate.maximumExpectedDownside).toBeGreaterThan(baseMandate.maximumExpectedDownside);
      expect(mandate.investingMode).toBe('aggressive');
    });

    it('tightens the mandate for conservative mode', () => {
      const mandate = agentDecisionTree.applyInvestingMode(baseMandate, 'conservative');
      expect(mandate.requiredMarginOfSafety).toBeGreaterThan(baseMandate.requiredMarginOfSafety);
      expect(mandate.maximumPositionWeight).toBeLessThan(baseMandate.maximumPositionWeight);
      expect(mandate.targetHoldingPeriodMonths).toBeGreaterThan(baseMandate.targetHoldingPeriodMonths);
      expect(mandate.maximumExpectedDownside).toBeLessThan(baseMandate.maximumExpectedDownside);
    });

    it('leaves the mandate unchanged for balanced mode and defaults unknown modes to balanced', () => {
      const balanced = agentDecisionTree.applyInvestingMode(baseMandate, 'balanced');
      const unknown = agentDecisionTree.applyInvestingMode(baseMandate, 'not-a-real-mode');
      expect(balanced.requiredMarginOfSafety).toBe(baseMandate.requiredMarginOfSafety);
      expect(balanced.maximumPositionWeight).toBe(baseMandate.maximumPositionWeight);
      expect(unknown).toEqual(balanced);
      expect(unknown.investingMode).toBe('balanced');
    });
  });

  it('allows a larger buy position under aggressive mode than conservative mode for the same signal', () => {
    const signal = {
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
    };
    const baseContext = { signals: [{ symbol: 'MSFT', localAiScore: 92 }], positions: [], accountState: { cash_balance_usd: 100000 } };

    const aggressive = agentDecisionTree.evaluateSignalForAgent({
      agent, personaBiasScore: 20, signal, context: { ...baseContext, investingMode: 'aggressive' },
    });
    const conservative = agentDecisionTree.evaluateSignalForAgent({
      agent, personaBiasScore: 20, signal, context: { ...baseContext, investingMode: 'conservative' },
    });

    expect(aggressive.positionSizing.maximumAllowedWeight).toBeGreaterThan(conservative.positionSizing.maximumAllowedWeight);
    expect(aggressive.mandate.investingMode).toBe('aggressive');
    expect(conservative.mandate.investingMode).toBe('conservative');
  });
});
