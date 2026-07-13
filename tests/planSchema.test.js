const { tradingPlanSchema } = require('../src/services/strategy/planSchema');

describe('planSchema.tradingPlanSchema', () => {
  it('accepts a well-formed plan', () => {
    const result = tradingPlanSchema.safeParse({
      actions: [{ symbol: 'AAPL', action: 'buy', quantity: 10, rationale: 'Undervalued vs peers.' }],
      overallRationale: 'Broad market conditions favor selective buying.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an action with no quantity (e.g. a hold)', () => {
    const result = tradingPlanSchema.safeParse({
      actions: [{ symbol: 'AAPL', action: 'hold', rationale: 'No change in thesis.' }],
      overallRationale: 'Staying the course.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an action with an invalid side', () => {
    const result = tradingPlanSchema.safeParse({
      actions: [{ symbol: 'AAPL', action: 'short', rationale: 'Bearish.' }],
      overallRationale: 'Testing invalid action.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive quantity', () => {
    const result = tradingPlanSchema.safeParse({
      actions: [{ symbol: 'AAPL', action: 'buy', quantity: 0, rationale: 'Zero quantity should be rejected.' }],
      overallRationale: 'Testing zero quantity.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative quantity', () => {
    const result = tradingPlanSchema.safeParse({
      actions: [{ symbol: 'AAPL', action: 'buy', quantity: -5, rationale: 'Negative quantity should be rejected.' }],
      overallRationale: 'Testing negative quantity.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a plan with more than 10 actions', () => {
    const actions = Array.from({ length: 11 }, (_, i) => ({
      symbol: `SYM${i}`,
      action: 'hold',
      rationale: 'Filler action to exceed the cap.',
    }));
    const result = tradingPlanSchema.safeParse({ actions, overallRationale: 'Too many actions.' });
    expect(result.success).toBe(false);
  });

  it('rejects an action missing a rationale', () => {
    const result = tradingPlanSchema.safeParse({
      actions: [{ symbol: 'AAPL', action: 'buy', quantity: 1, rationale: '' }],
      overallRationale: 'Missing per-action rationale.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a plan missing overallRationale', () => {
    const result = tradingPlanSchema.safeParse({
      actions: [{ symbol: 'AAPL', action: 'buy', quantity: 1, rationale: 'Fine.' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a symbol that is empty or exceeds the max length', () => {
    expect(
      tradingPlanSchema.safeParse({
        actions: [{ symbol: '', action: 'buy', quantity: 1, rationale: 'Empty symbol.' }],
        overallRationale: 'Testing empty symbol.',
      }).success
    ).toBe(false);
    expect(
      tradingPlanSchema.safeParse({
        actions: [{ symbol: 'WAYTOOLONGSYMBOL', action: 'buy', quantity: 1, rationale: 'Oversized symbol.' }],
        overallRationale: 'Testing oversized symbol.',
      }).success
    ).toBe(false);
  });

  it('rejects entirely malformed input (missing actions array)', () => {
    expect(tradingPlanSchema.safeParse({ overallRationale: 'No actions field at all.' }).success).toBe(false);
    expect(tradingPlanSchema.safeParse(null).success).toBe(false);
    expect(tradingPlanSchema.safeParse('not an object').success).toBe(false);
  });
});
