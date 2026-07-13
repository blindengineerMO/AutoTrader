const censusBfs = require('../src/services/censusBfsService');

const VARIABLES_RESPONSE = {
  cell_value: { label: 'data value' },
  time_slot_id: { label: 'Time Slot' },
  time_slot_name: { label: 'Time Slot Name' },
  time_slot_date: { label: 'Time Slot Date' },
  category_code: { label: 'Industry list' },
  data_type_code: { label: 'item type' },
  seasonally_adj: { label: 'Seasonally adjusted yes or no' },
  geo_level_code: { label: 'geo level code' },
  error_data: { label: 'Error data yes or no' },
};

describe('censusBfsService', () => {
  it('selects exact BFS variables from the current variable listing', () => {
    const selected = censusBfs.selectVariables(VARIABLES_RESPONSE);

    expect(selected).toEqual([
      'cell_value',
      'time_slot_id',
      'time_slot_name',
      'time_slot_date',
      'category_code',
      'data_type_code',
      'seasonally_adj',
      'geo_level_code',
      'error_data',
    ]);
  });

  it('builds a Census BFS query with selected variables, start time, and redacted key support', () => {
    const url = censusBfs.buildBfsQueryUrl({
      getVariables: ['cell_value', 'time_slot_id', 'category_code'],
      startTime: '2025-01',
      apiKey: 'abc123',
    });

    expect(url).toContain('https://api.census.gov/data/timeseries/eits/bfs?');
    expect(url).toContain('get=cell_value%2Ctime_slot_id%2Ccategory_code');
    expect(url).toContain('time=from%202025-01');
    expect(url).toContain('key=abc123');
  });

  it('evaluates aggregate BFS rows into formation momentum and opportunity scores', () => {
    const rows = censusBfs.parseCensusTable([
      ['cell_value', 'time_slot_id', 'time_slot_date', 'category_code', 'data_type_code', 'seasonally_adj', 'error_data'],
      ['1200', '202502', '2025-02', 'TOTAL', 'BA', 'yes', 'no'],
      ['1000', '202501', '2025-01', 'TOTAL', 'BA', 'yes', 'no'],
      ['780', '202502', '2025-02', 'HBA', 'BF', 'yes', 'no'],
      ['800', '202501', '2025-01', 'HBA', 'BF', 'yes', 'no'],
    ]);

    const context = censusBfs.evaluateBfsRows(rows, {
      selectedVariables: Object.keys(VARIABLES_RESPONSE),
      variables: VARIABLES_RESPONSE,
      queryUrl: 'https://api.census.gov/data/timeseries/eits/bfs?get=cell_value',
    });

    expect(context.available).toBe(true);
    expect(context.latestPeriod).toBe('2025-02');
    expect(context.seriesCount).toBe(2);
    expect(context.averageGrowthPct).toBeGreaterThan(8);
    expect(context.opportunityScore).toBeGreaterThan(50);
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining(['business-formation-statistics', 'business-formation-api']));
  });

  it('scores SaaS and small-cap-like candidates with higher BFS exposure', () => {
    const context = censusBfs.evaluateBfsRows(censusBfs.parseCensusTable([
      ['cell_value', 'time_slot_id', 'time_slot_date', 'category_code', 'data_type_code', 'seasonally_adj', 'error_data'],
      ['1200', '202502', '2025-02', 'TOTAL', 'BA', 'yes', 'no'],
      ['1000', '202501', '2025-01', 'TOTAL', 'BA', 'yes', 'no'],
    ]));

    const score = censusBfs.scoreCandidate({
      candidate: { symbol: 'DOCN', theme: 'saas-growth-profile' },
      bfsContext: context,
    });

    expect(score.exposure).toBeGreaterThan(60);
    expect(score.compositeScore).toBeGreaterThan(50);
    expect(score.explanation).toContain('Census BFS');
  });
});
