const { generateRulesBasedPlan, buildProviders } = require('../src/services/strategy/aiClient');

function signal(overrides) {
  return { symbol: 'AAPL', changePct: 2, volatilityPct: 1, momentum: 'bullish', localAiScore: 80, price: 100, ...overrides };
}

describe('aiClient.generateRulesBasedPlan (deterministic no-AI-credentials fallback)', () => {
  it('buys the top-ranked bullish signal when buying power covers the price and score is strong', () => {
    const plan = generateRulesBasedPlan({
      researchSnapshot: { signals: [signal()] },
      accountState: { cashUsd: 1000 },
      recentTradeCounts: {},
    });
    expect(plan.modelUsed).toBe('rules:fallback');
    expect(plan.raw.actions[0]).toMatchObject({ symbol: 'AAPL', action: 'buy', quantity: 1 });
  });

  it('holds instead of buying when available cash is below the signal price', () => {
    const plan = generateRulesBasedPlan({
      researchSnapshot: { signals: [signal({ price: 100 })] },
      accountState: { cashUsd: 50 },
      recentTradeCounts: {},
    });
    expect(plan.raw.actions[0].action).toBe('hold');
  });

  it('holds a symbol that already has 3+ trades in the last 24h regardless of signal strength', () => {
    const plan = generateRulesBasedPlan({
      researchSnapshot: { signals: [signal()] },
      accountState: { cashUsd: 1000 },
      recentTradeCounts: { AAPL: 3 },
    });
    expect(plan.raw.actions[0].action).toBe('hold');
    expect(plan.raw.actions[0].rationale).toMatch(/already has 3 trades/);
  });

  it('holds a bearish or neutral top signal even with strong local score and available cash', () => {
    const plan = generateRulesBasedPlan({
      researchSnapshot: { signals: [signal({ momentum: 'bearish' })] },
      accountState: { cashUsd: 1000 },
      recentTradeCounts: {},
    });
    expect(plan.raw.actions[0].action).toBe('hold');
  });

  it('holds when the local AI score is weak even if momentum is bullish', () => {
    const plan = generateRulesBasedPlan({
      researchSnapshot: { signals: [signal({ localAiScore: 40 })] },
      accountState: { cashUsd: 1000 },
      recentTradeCounts: {},
    });
    expect(plan.raw.actions[0].action).toBe('hold');
  });

  it('only ever buys the single top-ranked signal, holding the rest even if also bullish', () => {
    const plan = generateRulesBasedPlan({
      researchSnapshot: {
        signals: [
          signal({ symbol: 'AAPL', localAiScore: 90 }),
          signal({ symbol: 'MSFT', localAiScore: 85 }),
        ],
      },
      accountState: { cashUsd: 100000 },
      recentTradeCounts: {},
    });
    const buys = plan.raw.actions.filter((a) => a.action === 'buy');
    expect(buys).toHaveLength(1);
    expect(buys[0].symbol).toBe('AAPL');
  });

  it('caps proposed actions at 5 even with a larger signal set', () => {
    const signals = Array.from({ length: 8 }, (_, i) => signal({ symbol: `SYM${i}`, localAiScore: 50 + i }));
    const plan = generateRulesBasedPlan({
      researchSnapshot: { signals },
      accountState: { cashUsd: 1000 },
      recentTradeCounts: {},
    });
    expect(plan.raw.actions).toHaveLength(5);
  });

  it('includes the provided reason in overallRationale when given', () => {
    const plan = generateRulesBasedPlan({
      researchSnapshot: { signals: [signal()] },
      accountState: { cashUsd: 1000 },
      recentTradeCounts: {},
      reason: 'custom fallback reason',
    });
    expect(plan.raw.overallRationale).toBe('custom fallback reason');
  });
});

describe('aiClient.buildProviders', () => {
  it('always appends a local Ollama provider last, after any configured hosted providers', () => {
    const providers = buildProviders(null);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[providers.length - 1].provider).toBe('ollama');
  });
});
