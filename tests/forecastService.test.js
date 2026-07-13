const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-forecast-service.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const webScrapeClient = require('../src/services/marketData/webScrapeClient');
const forecastService = require('../src/services/forecastService');

function syntheticCloses(count = 500) {
  const closes = [];
  let price = 150;
  for (let i = 0; i < count; i += 1) {
    price *= 1 + Math.sin(i / 12) * 0.01 + 0.0005;
    closes.push(price);
  }
  return closes;
}

describe('forecastService.getForecast', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `forecast-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  it('trains a forecast and returns a 90-day p10/p50/p90 series', async () => {
    vi.spyOn(webScrapeClient, 'getDailyCloses').mockResolvedValue(syntheticCloses());

    const forecast = await forecastService.getForecast(userId, 'TEST');

    expect(forecast.symbol).toBe('TEST');
    expect(forecast.cached).toBe(false);
    expect(forecast.days).toHaveLength(90);
    for (const [index, day] of forecast.days.entries()) {
      expect(day.day).toBe(index + 1);
      expect(day.p10).toBeLessThanOrEqual(day.p50);
      expect(day.p50).toBeLessThanOrEqual(day.p90);
    }
  }, 20000);

  it('returns a cached forecast on a second call within the TTL window without retraining', async () => {
    const spy = vi.spyOn(webScrapeClient, 'getDailyCloses').mockResolvedValue(syntheticCloses());

    const first = await forecastService.getForecast(userId, 'CACHED');
    const second = await forecastService.getForecast(userId, 'CACHED');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.days).toEqual(first.days);
  }, 20000);

  it('scopes cached forecasts per user', async () => {
    vi.spyOn(webScrapeClient, 'getDailyCloses').mockResolvedValue(syntheticCloses());
    const otherUser = userRepo.createUser({
      email: `forecast-other-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    await forecastService.getForecast(userId, 'SCOPED');
    const otherForecast = await forecastService.getForecast(otherUser.id, 'SCOPED');

    expect(otherForecast.cached).toBe(false);
  }, 20000);
});
