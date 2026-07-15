const blsPricing = require('../src/services/blsPricingService');

const BLS_RESPONSE = {
  status: 'REQUEST_SUCCEEDED',
  Results: {
    series: [
      {
        seriesID: 'CUUR0000SA0',
        data: [
          { year: '2026', period: 'M06', periodName: 'June', value: '320.000', footnotes: [{}] },
          { year: '2026', period: 'M05', periodName: 'May', value: '318.000', footnotes: [{}] },
          { year: '2025', period: 'M06', periodName: 'June', value: '310.000', footnotes: [{}] },
        ],
      },
      {
        seriesID: 'APU0000708111',
        data: [
          { year: '2026', period: 'M06', periodName: 'June', value: '3.200', footnotes: [{}] },
          { year: '2026', period: 'M05', periodName: 'May', value: '3.100', footnotes: [{}] },
          { year: '2025', period: 'M06', periodName: 'June', value: '2.900', footnotes: [{}] },
        ],
      },
      {
        seriesID: 'WPUFD4',
        data: [
          { year: '2026', period: 'M06', periodName: 'June', value: '145.000', footnotes: [{}] },
          { year: '2026', period: 'M05', periodName: 'May', value: '143.000', footnotes: [{}] },
          { year: '2025', period: 'M06', periodName: 'June', value: '139.000', footnotes: [{}] },
        ],
      },
    ],
  },
};

describe('blsPricingService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes BLS CPI, average-price, and PPI series rows', () => {
    const rows = blsPricing.normalizeBlsResponse(BLS_RESPONSE, [
      { id: 'CUUR0000SA0', name: 'CPI all items', family: 'cpi', category: 'all-items', unit: 'index', exposure: 'inflation' },
      { id: 'APU0000708111', name: 'Average price eggs', family: 'average-price', category: 'food-products', unit: 'dollars', exposure: 'food-price' },
      { id: 'WPUFD4', name: 'PPI final demand', family: 'ppi', category: 'final-demand', unit: 'index', exposure: 'producer-price' },
    ]);

    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatchObject({
      id: 'CUUR0000SA0',
      family: 'cpi',
      period: '2026-06',
      value: 320,
      source: 'BLS Consumer Price Index',
    });
    expect(rows.find((row) => row.id === 'APU0000708111')).toMatchObject({
      family: 'average-price',
      unit: 'dollars',
      source: 'BLS CPI average price data',
    });
    expect(rows.find((row) => row.id === 'WPUFD4')).toMatchObject({
      family: 'ppi',
      source: 'BLS Producer Price Index',
    });
  });

  it('evaluates pricing pressure and compacts it for BMCL', () => {
    const rows = blsPricing.normalizeBlsResponse(BLS_RESPONSE, [
      { id: 'CUUR0000SA0', name: 'CPI all items', family: 'cpi', category: 'all-items', unit: 'index', exposure: 'inflation' },
      { id: 'APU0000708111', name: 'Average price eggs', family: 'average-price', category: 'food-products', unit: 'dollars', exposure: 'food-price' },
      { id: 'WPUFD4', name: 'PPI final demand', family: 'ppi', category: 'final-demand', unit: 'index', exposure: 'producer-price' },
    ]);
    const context = blsPricing.evaluateBlsPricingContext({
      apiKeyConfigured: true,
      rows,
      selected: blsPricing.BLS_PRICING_SERIES.slice(0, 3),
    });

    expect(context.available).toBe(true);
    expect(context.seriesCount).toBe(3);
    expect(context.averageYearOverYearPct.cpi).toBeGreaterThan(3);
    expect(context.scores.marginPressure).toBeGreaterThan(50);
    expect(context.caveat).toMatch(/not unit-sales volume/i);

    const compact = blsPricing.compactForBmcl(context);
    expect(compact.provider).toBe('bls-pricing');
    expect(compact.apiKeyConfigured).toBe(true);
    expect(compact.latestSeries[0]).toHaveProperty('yearOverYearChangePct');
    expect(compact.bmclUse).toMatch(/official BLS consumer CPI/);
  });

  it('posts to the BLS API with optional registration key and returns evaluated context', async () => {
    let body = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => BLS_RESPONSE,
      };
    });
    const events = [];
    const context = await blsPricing.collectBlsPricingContext({
      apiKey: 'bls-key',
      startYear: 2025,
      endYear: 2026,
      seriesIds: ['CUUR0000SA0', 'APU0000708111', 'WPUFD4'],
      onEvent: (event) => events.push(event),
    });

    expect(body).toMatchObject({
      registrationkey: 'bls-key',
      startyear: '2025',
      endyear: '2026',
      seriesid: ['CUUR0000SA0', 'APU0000708111', 'WPUFD4'],
    });
    expect(context.available).toBe(true);
    expect(context.apiKeyConfigured).toBe(true);
    expect(events.map((event) => event.phase)).toContain('bls-pricing');
  });
});
