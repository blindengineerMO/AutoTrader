const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-rules-engine.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const orderRepo = require('../src/db/repositories/orderRepo');
const pnlRepo = require('../src/db/repositories/pnlRepo');
const brokerAccountRepo = require('../src/db/repositories/brokerAccountRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const rulesEngine = require('../src/services/rulesEngine');

describe('rulesEngine.checkTradeAllowed', () => {
  let userId;
  let brokerAccountId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `rules-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
    brokerAccountId = brokerAccountRepo.ensureDefault(userId).id;
  });

  it('blocks trades when trading is not enabled', () => {
    const result = rulesEngine.checkTradeAllowed({ userId, symbol: 'AAPL', side: 'buy', estimatedUsd: 10 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not enabled/);
  });

  it('allows trades once enabled, with no kill switch and no limits hit', () => {
    settingsRepo.update(userId, { tradingEnabled: 1 });
    const result = rulesEngine.checkTradeAllowed({ userId, symbol: 'AAPL', side: 'buy', estimatedUsd: 10 });
    expect(result.allowed).toBe(true);
  });

  it('blocks trades when the kill switch is engaged', () => {
    rulesEngine.engageKillSwitch(userId, 'test', 'safety check');
    const result = rulesEngine.checkTradeAllowed({ userId, symbol: 'AAPL', side: 'buy', estimatedUsd: 10 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/[Kk]ill switch/);
    rulesEngine.releaseKillSwitch(userId, 'test', 'resume');
  });

  it('blocks the 4th trade on the same symbol within 24h (limit is 3)', () => {
    for (let i = 0; i < 3; i++) {
      orderRepo.create({
        userId,
        brokerAccountId,
        planActionId: null,
        symbol: 'NVDA',
        side: 'buy',
        quantity: 1,
        orderType: 'market',
        status: 'filled',
        brokerOrderId: `test-${i}`,
      });
    }
    const result = rulesEngine.checkTradeAllowed({ userId, symbol: 'NVDA', side: 'buy', estimatedUsd: 10 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/already has 3 trades/);
  });

  it('does not block a different symbol after another hit its trade limit', () => {
    const result = rulesEngine.checkTradeAllowed({ userId, symbol: 'TSLA', side: 'buy', estimatedUsd: 10 });
    expect(result.allowed).toBe(true);
  });

  it('blocks trades once the daily loss limit is breached, and latches as a real kill switch', () => {
    pnlRepo.record({
      userId,
      brokerAccountId,
      orderId: null,
      realizedPnlUsd: -15,
      balanceAfterUsd: 85,
      note: 'simulated loss',
    });
    const result = rulesEngine.checkTradeAllowed({ userId, symbol: 'TSLA', side: 'buy', estimatedUsd: 10 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/loss limit/);
    expect(settingsRepo.get(userId).daily_loss_limit_kill_switch_engaged).toBe(1);

    // Unlike a live threshold check, it must stay engaged even once today's
    // running P&L is no longer below the limit — only an explicit clear can reset it.
    pnlRepo.record({
      userId,
      brokerAccountId,
      orderId: null,
      realizedPnlUsd: 100,
      balanceAfterUsd: 185,
      note: 'recovered',
    });
    const stillBlocked = rulesEngine.checkTradeAllowed({ userId, symbol: 'TSLA', side: 'buy', estimatedUsd: 10 });
    expect(stillBlocked.allowed).toBe(false);
    expect(stillBlocked.reason).toMatch(/daily_loss_limit_kill_switch is engaged/);

    settingsRepo.clearAutoKillSwitch(userId, 'daily_loss_limit_kill_switch', 'operator-ack');
    const clearedResult = rulesEngine.checkTradeAllowed({ userId, symbol: 'TSLA', side: 'buy', estimatedUsd: 10 });
    expect(clearedResult.allowed).toBe(true);
  });

  it('never allows a deposit/transfer_in action regardless of other state', () => {
    const freshUser = userRepo.createUser({
      email: `rules-deposit-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(freshUser.id, { tradingEnabled: 1 });
    const result = rulesEngine.checkTradeAllowed({ userId: freshUser.id, symbol: 'CASH', side: 'deposit', estimatedUsd: 50 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/never permitted/);
  });
});
