const fs = require('fs');
const path = require('path');

const investorPlaybookService = require('../src/services/investorPlaybookService');

describe('investorPlaybookService', () => {
  it('loads the researched investor artifact even when citation notes trail the JSON object', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'tmp', 'data.json'), 'utf8');
    const parsed = JSON.parse(investorPlaybookService.extractFirstJsonObject(raw));

    expect(parsed.investors.length).toBeGreaterThanOrEqual(7);
    expect(parsed.cross_investor_consensus.most_common_purchase_indicators[0].indicator).toMatch(/Price relative/i);
  });

  it('scores a candidate with consensus investor indicators and sell-risk context', () => {
    const score = investorPlaybookService.scoreCandidate({
      candidate: { symbol: 'AMZN', themeHits: 4 },
      quote: { current: 42 },
      changePct: 2.4,
      volatilityPct: 2.2,
      sentiment: 2,
      macro: { riskBias: 'risk-on' },
      consumer: { consumerBias: 'constructive' },
      factorIntel: { normalized: 0.72, compositeScore: 72 },
      companyRecord: {
        summary: {
          compositeScore: 72,
          history: { fiveYearReturnPct: 38 },
          factors: {
            lowCostHighYield: { score: 72 },
            requiredEnergyValuation: { score: 45 },
            populationDemand: { score: 68 },
            deepHistoryTrend: { score: 72 },
          },
        },
      },
    });

    expect(score.available).toBe(true);
    expect(score.compositeScore).toBeGreaterThan(55);
    expect(score.indicators.map((item) => item.indicator)).toContain('Price relative to estimated value');
    expect(score.investorMatches.length).toBeGreaterThan(0);
  });
});
