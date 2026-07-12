const jsonDatasetIndicators = require('../src/services/jsonDatasetIndicatorService');

function dataset(id, category, data) {
  return {
    source: { id, category, name: id, url: `https://example.test/${id}` },
    ok: true,
    data,
  };
}

describe('jsonDatasetIndicatorService', () => {
  it('evaluates currency, climate, food, disasters, population, GDP, and travel datasets into scored categories', () => {
    const context = jsonDatasetIndicators.evaluateDatasets([
      dataset('currency-usd', 'currency', { rates: { EUR: 0.9, GBP: 0.8, JPY: 150, CNY: 7.2, INR: 83, CAD: 1.3, MXN: 17 } }),
      dataset('currency-gbp', 'currency', { rates: { USD: 1.25 } }),
      dataset('climate-temperature', 'climate', { data: { 2016: { value: '54.9', anomaly: '2.1' } } }),
      dataset('climate-precipitation', 'climate', { data: { 2016: { value: '31.0', anomaly: '1.2' } } }),
      dataset('food-recalls', 'food', { results: [{ classification: 'Class I' }, { classification: 'Class II' }, { classification: 'Class III' }] }),
      dataset('food-product-profile', 'food', { product: { categories_tags: ['en:beverages'] } }),
      dataset('natural-disasters-earthquakes', 'naturalDisasters', { features: [{ properties: { mag: 5 } }, { properties: { mag: 2 } }] }),
      dataset('population-usa', 'population', worldBankRows('United States', 100, 108)),
      dataset('population-china', 'population', worldBankRows('China', 100, 103)),
      dataset('population-india', 'population', worldBankRows('India', 100, 111)),
      dataset('gdp-usa', 'gdp', worldBankRows('United States', 100, 118)),
      dataset('gdp-china', 'gdp', worldBankRows('China', 100, 130)),
      dataset('gdp-india', 'gdp', worldBankRows('India', 100, 135)),
      dataset('travel-airline-delays', 'travel', [{ Statistics: { Flights: { Delayed: 500 } } }, { Statistics: { Flights: { Delayed: 700 } } }]),
      dataset('travel-jfk', 'travel', { IATA: 'JFK', delay: false, status: { type: 'No known delays' } }),
      dataset('travel-atl', 'travel', { IATA: 'ATL', delay: true, status: { reason: 'Weather' } }),
    ]);

    expect(context.categories.currency.riskScore).toBeGreaterThan(0);
    expect(context.categories.population.opportunityScore).toBeGreaterThan(50);
    expect(context.categories.gdp.opportunityScore).toBeGreaterThan(50);
    expect(context.categories.travel.riskScore).toBeGreaterThan(30);
    expect(context.compositeRiskScore).toBeGreaterThan(0);
    expect(context.sourceList).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'json-dataset:currency' })]));
  });

  it('scores candidate exposure using dataset category risk and opportunity', () => {
    const context = jsonDatasetIndicators.evaluateDatasets([
      dataset('currency-usd', 'currency', { rates: { EUR: 0.9, GBP: 0.8, JPY: 150, CNY: 7.2, INR: 83, CAD: 1.3, MXN: 17 } }),
      dataset('population-usa', 'population', worldBankRows('United States', 100, 110)),
      dataset('gdp-usa', 'gdp', worldBankRows('United States', 100, 120)),
      dataset('natural-disasters-earthquakes', 'naturalDisasters', { features: [] }),
    ]);

    const score = jsonDatasetIndicators.scoreCandidate({
      candidate: { symbol: 'AMZN', theme: 'watchlist+consumer' },
      companyRecord: { summary: { factors: { populationDemand: { score: 68 } } } },
      datasetContext: context,
    });

    expect(score.compositeScore).toBeGreaterThan(40);
    expect(score.categoryImpacts.length).toBeGreaterThan(0);
    expect(score.explanations.some((line) => line.includes('dataset impact'))).toBe(true);
  });
});

function worldBankRows(country, prior, latest) {
  return [
    {},
    [
      { country: { value: country }, date: '2025', value: latest },
      { country: { value: country }, date: '2020', value: prior },
    ],
  ];
}
