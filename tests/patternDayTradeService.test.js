const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-pattern-day-trade.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const db = require('../src/db/connection');
const userRepo = require('../src/db/repositories/userRepo');
const brokerAccountRepo = require('../src/db/repositories/brokerAccountRepo');
const patternDayTradeService = require('../src/services/patternDayTradeService');

const settings = { application_timezone: 'America/New_York' };

function insertFilledOrder({ userId, brokerAccountId, symbol, side, filledAt }) {
  db.prepare(
    `INSERT INTO orders (user_id, broker_account_id, plan_action_id, symbol, side, quantity, order_type, status, broker_order_id, filled_at)
     VALUES (?, ?, NULL, ?, ?, 1, 'market', 'filled', ?, ?)`
  ).run(userId, brokerAccountId, symbol, side, `test-${userId}-${symbol}-${side}-${filledAt}`, filledAt);
}

describe('patternDayTradeService', () => {
  let userId;
  let brokerAccountId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `pdt-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
    brokerAccountId = brokerAccountRepo.ensureDefault(userId).id;
  });

  it('allows unlimited trades when equity is at or above $25,000', () => {
    const result = patternDayTradeService.checkPatternDayTradeLimit({
      userId,
      symbol: 'AAPL',
      side: 'sell',
      settings,
      equityUsd: 25000,
    });
    expect(result.allowed).toBe(true);
  });

  it('counts a same-day buy+sell pair on the same symbol as one day trade', () => {
    insertFilledOrder({ userId, brokerAccountId, symbol: 'NVDA', side: 'buy', filledAt: '2026-07-14 14:00:00' });
    insertFilledOrder({ userId, brokerAccountId, symbol: 'NVDA', side: 'sell', filledAt: '2026-07-14 15:00:00' });
    const now = new Date('2026-07-14T18:00:00Z');
    const count = patternDayTradeService.countDayTradesInWindow(userId, settings, now);
    expect(count).toBe(1);
  });

  it('blocks the 4th day trade in the rolling window when equity is below $25,000', () => {
    // Day trade #1 already inserted above (NVDA 2026-07-14). Add two more distinct
    // symbol/day round trips to reach 3 total, then confirm a 4th is blocked.
    insertFilledOrder({ userId, brokerAccountId, symbol: 'TSLA', side: 'buy', filledAt: '2026-07-13 14:00:00' });
    insertFilledOrder({ userId, brokerAccountId, symbol: 'TSLA', side: 'sell', filledAt: '2026-07-13 15:00:00' });
    insertFilledOrder({ userId, brokerAccountId, symbol: 'MSFT', side: 'buy', filledAt: '2026-07-10 14:00:00' });
    insertFilledOrder({ userId, brokerAccountId, symbol: 'MSFT', side: 'sell', filledAt: '2026-07-10 15:00:00' });

    const now = new Date('2026-07-14T18:00:00Z');
    const preCount = patternDayTradeService.countDayTradesInWindow(userId, settings, now);
    expect(preCount).toBe(3);

    // A 4th round trip today on a brand new symbol would push the total to 4.
    insertFilledOrder({ userId, brokerAccountId, symbol: 'AMD', side: 'buy', filledAt: '2026-07-14 14:30:00' });
    const wouldTrade = patternDayTradeService.wouldCreateDayTrade(userId, 'AMD', 'sell', settings, now);
    expect(wouldTrade).toBe(true);

    const blocked = patternDayTradeService.checkPatternDayTradeLimit({
      userId,
      symbol: 'AMD',
      side: 'sell',
      settings,
      equityUsd: 1000,
      now,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/[Pp]attern day trader/);
  });

  it('allows the 3rd day trade in the window (at the limit, not over it)', () => {
    const freshUser = userRepo.createUser({
      email: `pdt-fresh-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const freshBrokerAccountId = brokerAccountRepo.ensureDefault(freshUser.id).id;

    insertFilledOrder({ userId: freshUser.id, brokerAccountId: freshBrokerAccountId, symbol: 'NVDA', side: 'buy', filledAt: '2026-07-14 14:00:00' });
    insertFilledOrder({ userId: freshUser.id, brokerAccountId: freshBrokerAccountId, symbol: 'NVDA', side: 'sell', filledAt: '2026-07-14 15:00:00' });
    insertFilledOrder({ userId: freshUser.id, brokerAccountId: freshBrokerAccountId, symbol: 'TSLA', side: 'buy', filledAt: '2026-07-13 14:00:00' });
    insertFilledOrder({ userId: freshUser.id, brokerAccountId: freshBrokerAccountId, symbol: 'TSLA', side: 'sell', filledAt: '2026-07-13 15:00:00' });

    const now = new Date('2026-07-14T18:00:00Z');
    const result = patternDayTradeService.checkPatternDayTradeLimit({
      userId: freshUser.id,
      symbol: 'AMD',
      side: 'buy',
      settings,
      equityUsd: 1000,
      now,
    });
    expect(result.allowed).toBe(true);
  });

  it('excludes trades outside the 5-trading-day window', () => {
    const freshUser = userRepo.createUser({
      email: `pdt-window-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const freshBrokerAccountId = brokerAccountRepo.ensureDefault(freshUser.id).id;

    // Old round trip well outside the 5-trading-day window ending 2026-07-14.
    insertFilledOrder({ userId: freshUser.id, brokerAccountId: freshBrokerAccountId, symbol: 'OLD', side: 'buy', filledAt: '2026-06-01 14:00:00' });
    insertFilledOrder({ userId: freshUser.id, brokerAccountId: freshBrokerAccountId, symbol: 'OLD', side: 'sell', filledAt: '2026-06-01 15:00:00' });

    const now = new Date('2026-07-14T18:00:00Z');
    const count = patternDayTradeService.countDayTradesInWindow(freshUser.id, settings, now);
    expect(count).toBe(0);
  });
});
