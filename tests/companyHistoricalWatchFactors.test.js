const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-company-history-watch.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const companyIntelligence = require('../src/services/companyIntelligenceService');
const { scoreCandidates } = require('../src/services/autonomousResearchService');

function newUser() {
  return userRepo.createUser({
    email: `company-history-watch-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

function quote(symbol) {
  return {
    symbol,
    current: 160,
    open: 155,
    high: 162,
    low: 154,
    prevClose: 155,
    changePct: 3.23,
  };
}

describe('company historical watch factors', () => {
  it('adds growth, value, and five-year stock split factors to company summaries', () => {
    const summary = companyIntelligence.buildCompanySummary({
      symbol: 'GROW',
      companyName: 'Growth Co',
      quote: quote('GROW'),
      history: {
        firstClose: 40,
        lastClose: 160,
        fiveYearReturnPct: 300,
        annualizedReturnPct: 31.95,
        maxDrawdownPct: -22,
        stockSplitsPast5Years: 2,
        splitEvents: [{ date: '2024-01-01T00:00:00.000Z', splitRatio: '4:1' }],
      },
      macro: { riskBias: 'neutral' },
      consumer: { consumerBias: 'neutral' },
      population: { usPopulationGrowthPct: 0.5 },
      oil: { changePct: 0 },
    });

    expect(summary.factors.companyGrowthTrend.score).toBeGreaterThan(70);
    expect(summary.factors.companyValueTrend.valueChangePct).toBe(300);
    expect(summary.factors.fiveYearSplitActivity.stockSplitsPast5Years).toBe(2);

    const factorIntel = companyIntelligence.factorScoreForSymbol({ summary });
    expect(factorIntel.historicalWatchNormalized).toBeGreaterThan(0.6);
    expect(factorIntel.historicalWatchFactors.map((factor) => factor.key)).toEqual([
      'companyGrowthTrend',
      'companyValueTrend',
      'fiveYearSplitActivity',
    ]);
  });

  it('feeds historical watch factors into candidate scoring evidence', () => {
    const userId = newUser();
    const summary = companyIntelligence.buildCompanySummary({
      symbol: 'HIST',
      companyName: 'History Systems',
      quote: quote('HIST'),
      history: {
        firstClose: 50,
        lastClose: 125,
        fiveYearReturnPct: 150,
        annualizedReturnPct: 20.11,
        maxDrawdownPct: -18,
        stockSplitsPast5Years: 1,
        splitEvents: [{ date: '2025-06-01T00:00:00.000Z', splitRatio: '2:1' }],
      },
      macro: { riskBias: 'neutral' },
      consumer: { consumerBias: 'neutral' },
      population: { usPopulationGrowthPct: 0.4 },
      oil: { changePct: 0 },
    });

    const [signal] = scoreCandidates({
      userId,
      candidates: [{ symbol: 'HIST', companyName: 'History Systems', theme: 'watchlist', themeHits: 1 }],
      quotes: [quote('HIST')],
      news: { items: [] },
      macro: { riskBias: 'neutral' },
      consumer: { consumerBias: 'neutral' },
      learned: { observations: [] },
      companyIntel: { records: [{ symbol: 'HIST', summary }] },
      jsonDatasets: [],
      onEvent: () => {},
    });

    expect(signal.brainModelKey).toBe('candidate-factor-scorer-v9-census-bds');
    expect(signal.evidence.featureInput.historicalWatchFactors).toBeGreaterThan(0.6);
    expect(signal.evidence.featureInput.secFilingHistory).toBe(0.44);
    expect(signal.evidence.featureInput.businessFormation).toBe(0.5);
    expect(signal.evidence.featureInput.businessDynamics).toBe(0.5);
    expect(signal.evidence.businessFormation.score).toBe(50);
    expect(signal.evidence.businessDynamics.score).toBe(50);
    expect(signal.evidence.historicalWatchFactors).toHaveLength(3);
    expect(signal.evidence.explanation.join(' ')).toContain('Stock splits past 5 years');
  });

  it('adds SEC filing history as a company factor and candidate explanation', () => {
    const userId = newUser();
    const secSubmissions = {
      symbol: 'SECF',
      cik: '0000123456',
      entityType: 'operating',
      sic: '7372',
      sicDescription: 'Services-Prepackaged Software',
      exchanges: ['Nasdaq'],
      latestFiling: { form: '10-Q', filingDate: new Date().toISOString().slice(0, 10) },
      latestPeriodic: { form: '10-Q', filingDate: new Date().toISOString().slice(0, 10) },
      latestAnnual: { form: '10-K', filingDate: '2025-02-01' },
      latestQuarterly: { form: '10-Q', filingDate: new Date().toISOString().slice(0, 10) },
      latestMaterialEvent: { form: '8-K', filingDate: '2025-06-01' },
      formCounts: { '10-Q': 1, '10-K': 1, '8-K': 1 },
      recentFilings: [{ form: '10-Q' }, { form: '10-K' }, { form: '8-K' }],
      source: { name: 'SEC company submissions API', url: 'https://data.sec.gov/submissions/CIK0000123456.json' },
    };
    const summary = companyIntelligence.buildCompanySummary({
      symbol: 'SECF',
      companyName: 'SEC Filing Corp',
      quote: quote('SECF'),
      history: {
        firstClose: 50,
        lastClose: 80,
        fiveYearReturnPct: 60,
        annualizedReturnPct: 9.86,
        maxDrawdownPct: -20,
      },
      macro: { riskBias: 'neutral' },
      consumer: { consumerBias: 'neutral' },
      population: { usPopulationGrowthPct: 0.4 },
      oil: { changePct: 0 },
      secSubmissions,
    });

    expect(summary.factors.secFilingHistory.score).toBeGreaterThan(60);
    expect(summary.secSubmissions.source.url).toContain('CIK0000123456');

    const [signal] = scoreCandidates({
      userId,
      candidates: [{ symbol: 'SECF', companyName: 'SEC Filing Corp', theme: 'watchlist', themeHits: 1 }],
      quotes: [quote('SECF')],
      news: { items: [] },
      macro: { riskBias: 'neutral' },
      consumer: { consumerBias: 'neutral' },
      learned: { observations: [] },
      companyIntel: { records: [{ symbol: 'SECF', summary }] },
      jsonDatasets: [],
      onEvent: () => {},
    });

    expect(signal.evidence.featureInput.secFilingHistory).toBeGreaterThan(0.6);
    expect(signal.evidence.secFilingHistory.latestForm).toBe('10-Q');
    expect(signal.evidence.explanation.join(' ')).toContain('SEC filing history');
  });
});
