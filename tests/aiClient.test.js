const {
  generateRulesBasedPlan,
  buildProviders,
  buildTradingPlanPrompt,
  requestStructuredCompletion,
  estimatePromptTokens,
} = require('../src/services/strategy/aiClient');
const { config } = require('../src/config');

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

  it('uses fractional quantity when cash is below share price and Alpaca marks the asset fractionable', () => {
    const plan = generateRulesBasedPlan({
      researchSnapshot: { signals: [signal({ price: 200, alpacaAsset: { tradable: true, fractionable: true } })] },
      accountState: { cashUsd: 50 },
      recentTradeCounts: {},
    });
    expect(plan.raw.actions[0]).toMatchObject({
      symbol: 'AAPL',
      action: 'buy',
      quantity: 0.25,
    });
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

  it('caps fresh signal actions at 5 but still appends current owned-position holds', () => {
    const signals = Array.from({ length: 8 }, (_, i) => signal({ symbol: `SYM${i}`, localAiScore: 50 + i }));
    const plan = generateRulesBasedPlan({
      researchSnapshot: { signals },
      accountState: { cashUsd: 1000 },
      recentTradeCounts: {},
      positions: [{ symbol: 'HELD', quantity: 3, avg_cost_usd: 12 }],
    });
    expect(plan.raw.actions).toHaveLength(6);
    expect(plan.raw.actions.find((action) => action.symbol === 'HELD')).toMatchObject({
      action: 'hold',
      rationale: expect.stringMatching(/current owned position/i),
    });
  });

  it('reviews owned positions as sell or buy-more candidates when matching research signals exist', () => {
    const plan = generateRulesBasedPlan({
      researchSnapshot: {
        signals: [
          signal({ symbol: 'F', actionBias: 'sell-or-avoid', localAiScore: 30, momentum: 'bearish', price: 13 }),
          signal({ symbol: 'NVDA', localAiScore: 95, price: 100 }),
        ],
      },
      accountState: { cashUsd: 1000 },
      recentTradeCounts: {},
      positions: [{ symbol: 'F', quantity: 2, avg_cost_usd: 14 }],
    });
    expect(plan.raw.actions.find((action) => action.symbol === 'F')).toMatchObject({
      action: 'sell',
      quantity: 2,
      rationale: expect.stringMatching(/owned position/i),
    });
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

describe('aiClient local-model context compaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    config.ollamaMaxPromptTokens = 4096;
  });

  it('builds a compact trading-plan prompt instead of serializing massive research summaries', () => {
    config.ollamaMaxPromptTokens = 1400;
    const huge = 'crawler evidence '.repeat(15000);
    const prompt = buildTradingPlanPrompt({
      researchSnapshot: {
        id: 42,
        source: 'autonomous',
        signals: [
          signal({
            symbol: 'NVDA',
            evidence: {
              explanation: [huge, 'GPU demand remains relevant.'],
              brokerFactors: { raw: huge },
            },
          }),
          signal({ symbol: 'MSFT', localAiScore: 79 }),
        ],
        summary: {
          learnedResearch: { observations: [{ title: 'Huge page', excerpt: huge }] },
          reportNarrative: {
            summary: `Important concise summary. ${huge}`,
            topCandidates: [{ symbol: 'NVDA', score: 91, bias: 'buy', reasons: [huge] }],
          },
          chatResearch: {
            summary: huge,
            candidateHints: [{ symbol: 'NVDA', companyName: 'NVIDIA', confidence: 0.9, reason: huge }],
          },
          sourceStack: Array.from({ length: 50 }, (_, index) => ({ name: `${huge}-${index}`, type: 'learned' })),
        },
      },
      accountState: { cashUsd: 100 },
      positions: [{ symbol: 'NVDA', quantity: 2, avg_cost_usd: 80 }],
      recentTradeCounts: {},
    });

    expect(estimatePromptTokens('', prompt)).toBeLessThanOrEqual(1400);
    expect(prompt).toContain('NVDA');
    expect(prompt).toContain('positions');
    expect(prompt).toContain('positionInstructions');
    expect(prompt).toContain('alpacaOrderRules');
    expect(prompt.length).toBeLessThan(5600);
    expect(prompt).not.toContain('learnedResearch');
  });

  it('compacts oversized direct Ollama structured-completion prompts before sending them', async () => {
    config.ollamaMaxPromptTokens = 1200;
    const create = vi.fn(async (request) => {
      const userMessage = request.messages.find((message) => message.role === 'user')?.content || '';
      expect(estimatePromptTokens('system', userMessage)).toBeLessThanOrEqual(1200);
      expect(userMessage).toContain('compacted');
      return { choices: [{ message: { content: '{"actions":[],"overallRationale":"ok"}' } }] };
    });

    const events = [];
    const result = await requestStructuredCompletion({
      providers: [{
        provider: 'ollama',
        model: 'deepseek-r1:latest',
        client: { chat: { completions: { create } } },
      }],
      systemPrompt: 'system',
      userPrompt: JSON.stringify({ giant: 'x '.repeat(50000), keep: 'small' }),
      onEvent: (event) => events.push(event),
    });

    expect(result.provider).toBe('ollama');
    expect(create).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.message.includes('Compacted oversized local Ollama strategy prompt'))).toBe(true);
  });
});
