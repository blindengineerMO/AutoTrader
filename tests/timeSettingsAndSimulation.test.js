const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-time-settings.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const timeSettings = require('../src/services/timeSettingsService');
const agentResearch = require('../src/services/agentResearchService');

describe('time settings and simulation configuration', () => {
  it('persists timezone, trading hours, simulation, and evening agent refresh settings', () => {
    const user = userRepo.createUser({
      email: `time-settings-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    settingsRepo.update(user.id, {
      applicationTimezone: 'America/Chicago',
      tradingStartTime: '08:45',
      tradingEndTime: '15:15',
      simulationModeEnabled: 1,
      simulationStartingCashUsd: 250,
      agentPersonalityRefreshEnabled: 1,
      agentPersonalityRefreshTime: '19:30',
    });

    const settings = settingsRepo.get(user.id);
    expect(settings.application_timezone).toBe('America/Chicago');
    expect(settings.trading_start_time).toBe('08:45');
    expect(settings.trading_end_time).toBe('15:15');
    expect(settings.simulation_mode_enabled).toBe(1);
    expect(settings.simulation_starting_cash_usd).toBe(250);
    expect(settings.agent_personality_refresh_enabled).toBe(1);
    expect(settings.agent_personality_refresh_time).toBe('19:30');
  });

  it('defaults investing_mode to balanced and persists changes to it', () => {
    const user = userRepo.createUser({
      email: `investing-mode-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    expect(settingsRepo.get(user.id).investing_mode).toBe('balanced');

    settingsRepo.update(user.id, { investingMode: 'aggressive' });
    expect(settingsRepo.get(user.id).investing_mode).toBe('aggressive');

    settingsRepo.update(user.id, { investingMode: 'conservative' });
    expect(settingsRepo.get(user.id).investing_mode).toBe('conservative');
  });

  it('enforces weekday-only trading windows in the configured timezone', () => {
    const settings = {
      application_timezone: 'America/Chicago',
      trading_start_time: '08:30',
      trading_end_time: '15:00',
    };

    expect(timeSettings.isTradingWeekday(new Date('2026-07-11T16:00:00Z'), 'America/Chicago')).toBe(false);
    expect(timeSettings.isWithinTradingHours(settings, new Date('2026-07-13T14:00:00Z'))).toBe(true);
    expect(timeSettings.isWithinTradingHours(settings, new Date('2026-07-13T22:00:00Z'))).toBe(false);
    expect(timeSettings.cronFromLocalTime('19:30')).toBe('30 19 * * 1-5');
  });

  it('builds evening personality refresh questions around public trades, conviction changes, news, and net worth', () => {
    const questions = agentResearch.buildResearchQuestions('Example Investor').join('\n');
    expect(questions).toContain('losing faith');
    expect(questions).toContain('trade recently');
    expect(questions).toContain('buy or sell any stocks recently');
    expect(questions).toContain('news has Example Investor been involved in');
    expect(questions).toContain('net worth');
  });
});
