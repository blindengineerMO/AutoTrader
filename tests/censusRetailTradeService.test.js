const censusRetailTrade = require('../src/services/censusRetailTradeService');

const VARIABLES_RESPONSE = {
  cell_value: { label: 'data value' },
  data_type_code: { label: 'item type' },
  category_code: { label: 'Industry list' },
  time_slot_id: { label: 'Time Slot' },
  time_slot_name: { label: 'Time Slot Name' },
  time_slot_date: { label: 'Time Slot Date' },
  seasonally_adj: { label: 'Seasonally adjusted yes or no' },
  geo_level_code: { label: 'geo level code' },
  program_code: { label: 'Component Name' },
  error_data: { label: 'Error data yes or no' },
};

function datasetRows(baseValue = 1000) {
  return [
    ['cell_value', 'data_type_code', 'category_code', 'time_slot_id', 'time_slot_date', 'seasonally_adj', 'error_data'],
    [String(baseValue + 120), 'SM', 'TOTAL', '202502', '2025-02', 'yes', 'no'],
    [String(baseValue), 'SM', 'TOTAL', '202501', '2025-01', 'yes', 'no'],
    [String(baseValue + 25), 'INVENTORY', 'TOTAL', '202502', '2025-02', 'yes', 'no'],
    [String(baseValue + 10), 'INVENTORY', 'TOTAL', '202501', '2025-01', 'yes', 'no'],
  ];
}

describe('censusRetailTradeService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects required Census retail/trade variables from current metadata', () => {
    expect(censusRetailTrade.selectVariables(VARIABLES_RESPONSE)).toEqual([
      'cell_value',
      'data_type_code',
      'category_code',
      'time_slot_id',
      'time_slot_name',
      'time_slot_date',
      'seasonally_adj',
      'geo_level_code',
      'program_code',
      'error_data',
    ]);
  });

  it('builds MRTS/MARTS/MTIS query URLs with key redaction support fields', () => {
    const url = censusRetailTrade.buildDatasetQueryUrl({
      dataset: censusRetailTrade.DATASETS.find((dataset) => dataset.id === 'mtis'),
      getVariables: ['cell_value', 'data_type_code', 'category_code'],
      startTime: '2025-01',
      apiKey: 'abc123',
    });

    expect(url).toContain('https://api.census.gov/data/timeseries/eits/mtis?');
    expect(url).toContain('get=cell_value%2Cdata_type_code%2Ccategory_code');
    expect(url).toContain('time=from%202025-01');
    expect(url).toContain('for=us%3A*');
    expect(url).toContain('key=abc123');
  });

  it('evaluates dataset rows and compacts Census retail/trade context for BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      json: async () => String(url).includes('/variables')
        ? { variables: VARIABLES_RESPONSE }
        : datasetRows(String(url).includes('/mtis') ? 2000 : 1000),
    }));

    const context = await censusRetailTrade.collectRetailTradeContext({
      apiKey: 'census-key',
      startTime: '2025-01',
      datasets: ['mrts', 'marts', 'mtis'],
    });

    expect(context.available).toBe(true);
    expect(context.rows).toBeGreaterThan(0);
    expect(context.datasets.map((dataset) => dataset.id)).toEqual(['mrts', 'marts', 'mtis']);
    expect(context.retailDemandScore).toBeGreaterThan(50);
    expect(context.caveat).toMatch(/not identify individual products/i);

    const compact = censusRetailTrade.compactForBmcl(context);
    expect(compact).toMatchObject({
      provider: 'census-retail-trade',
      available: true,
      apiKeyConfigured: true,
    });
    expect(compact.bmclUse).toMatch(/category-level retail/);
    expect(compact.bmclUse).toMatch(/Never treat it as UPC/);
  });

  it('returns metadata-only context when no Census API key is configured', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ variables: VARIABLES_RESPONSE }),
    }));

    const context = await censusRetailTrade.collectRetailTradeContext({
      apiKey: false,
      datasets: ['mrts'],
      includeData: true,
    });

    expect(context.available).toBe(false);
    expect(context.apiKeyConfigured).toBe(false);
    expect(context.datasets[0]).toMatchObject({
      id: 'mrts',
      reason: 'missing-census-api-key',
    });
    expect(context.narrative).toMatch(/Census API key is required/);
  });
});
