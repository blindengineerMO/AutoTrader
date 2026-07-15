const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-alpaca-rules.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const alpacaRules = require('../src/services/alpacaRulesService');

function createUser() {
  return userRepo.createUser({
    email: `alpaca-rules-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  });
}

describe('alpacaRulesService', () => {
  it('summarizes fractional-order settings for agents', () => {
    const user = createUser();
    settingsRepo.update(user.id, {
      fractionalTradingEnabled: 1,
      fractionalMinNotionalUsd: 1.25,
      maxBuyOrderNotionalUsd: 42,
    });

    const summary = alpacaRules.getRulesSummary({ userId: user.id });

    expect(summary).toMatchObject({
      provider: 'alpaca',
      fractionalTradingEnabled: true,
      fractionalMinNotionalUsd: 1.25,
      maxBuyOrderNotionalUsd: 42,
    });
    expect(summary.rules.join(' ')).toMatch(/fractionable=true/);
  });

  it('blocks disabled fractional orders, over-precision quantities, and max-buy violations', () => {
    const user = createUser();
    settingsRepo.update(user.id, {
      fractionalTradingEnabled: 0,
      fractionalMinNotionalUsd: 1,
      maxBuyOrderNotionalUsd: 10,
    });

    const disabled = alpacaRules.evaluateOrder({
      userId: user.id,
      symbol: 'AAPL',
      side: 'buy',
      quantity: 0.5,
      price: 100,
      asset: { fractionable: true },
    });
    expect(disabled.allowed).toBe(false);
    expect(disabled.failed).toEqual(expect.arrayContaining([
      'fractional-trading-disabled-in-settings',
      'max-buy-order-notional-exceeded',
    ]));

    const tooPrecise = alpacaRules.evaluateOrder({
      userId: user.id,
      symbol: 'AAPL',
      side: 'buy',
      quantity: 0.1234567891,
      price: 1,
      asset: { fractionable: true },
    });
    expect(tooPrecise.failed).toContain('fractional-quantity-exceeds-9-decimals');
  });

  it('allows compliant fractional orders for fractionable Alpaca assets', () => {
    const user = createUser();
    settingsRepo.update(user.id, {
      fractionalTradingEnabled: 1,
      fractionalMinNotionalUsd: 1,
      maxBuyOrderNotionalUsd: 25,
    });

    const evaluation = alpacaRules.evaluateOrder({
      userId: user.id,
      symbol: 'AAPL',
      side: 'buy',
      quantity: 0.25,
      price: 20,
      asset: { fractionable: true, tradable: true },
    });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.notionalUsd).toBe(5);
  });
});
