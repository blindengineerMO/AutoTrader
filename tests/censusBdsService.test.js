const censusBds = require('../src/services/censusBdsService');

const VARIABLES_RESPONSE = {
  NAME: { label: 'Geographic Area Name' },
  YEAR: { label: 'Year' },
  FIRM: { label: 'Number of firms' },
  ESTABS_ENTRY: { label: 'Number of establishments born during the last 12 months' },
  ESTABS_ENTRY_RATE: { label: 'Rate of establishments born during the last 12 months' },
  ESTABS_EXIT: { label: 'Number of establishments exited during the last 12 months' },
  ESTABS_EXIT_RATE: { label: 'Rate of establishments exited during the last 12 months' },
  FIRMDEATH_FIRMS: { label: 'Number of firms that exited during the last 12 months' },
  JOB_CREATION: { label: 'Number of jobs created from expanding and opening establishments during the last 12 months' },
  JOB_CREATION_BIRTHS: { label: 'Number of jobs created from opening establishments during the last 12 months' },
  JOB_DESTRUCTION: { label: 'Number of jobs destroyed from contracting and closing establishments during the last 12 months' },
  NET_JOB_CREATION: { label: 'Net job creation' },
};

describe('censusBdsService', () => {
  it('selects exact BDS variables from the current variable listing', () => {
    const selected = censusBds.selectVariables(VARIABLES_RESPONSE);

    expect(selected).toEqual([
      'NAME',
      'YEAR',
      'FIRM',
      'ESTABS_ENTRY',
      'ESTABS_ENTRY_RATE',
      'ESTABS_EXIT',
      'ESTABS_EXIT_RATE',
      'FIRMDEATH_FIRMS',
      'JOB_CREATION',
      'JOB_CREATION_BIRTHS',
      'JOB_DESTRUCTION',
      'NET_JOB_CREATION',
    ]);
  });

  it('builds a Census BDS query with selected variables, start year, geography, and key', () => {
    const url = censusBds.buildBdsQueryUrl({
      getVariables: ['NAME', 'YEAR', 'JOB_CREATION'],
      startYear: '2020',
      geography: 'us:*',
      apiKey: 'abc123',
    });

    expect(url).toContain('https://api.census.gov/data/timeseries/bds?');
    expect(url).toContain('get=NAME%2CYEAR%2CJOB_CREATION');
    expect(url).toContain('time=from%202020');
    expect(url).toContain('for=us%3A*');
    expect(url).toContain('key=abc123');
  });

  it('evaluates aggregate BDS rows into annual business-dynamics momentum', () => {
    const rows = censusBds.parseCensusTable([
      ['NAME', 'YEAR', 'FIRM', 'ESTABS_ENTRY', 'ESTABS_EXIT', 'FIRMDEATH_FIRMS', 'JOB_CREATION', 'JOB_DESTRUCTION', 'NET_JOB_CREATION'],
      ['United States', '2022', '6000000', '420000', '390000', '300000', '8200000', '7600000', '600000'],
      ['United States', '2023', '6300000', '470000', '370000', '280000', '8800000', '7400000', '1400000'],
    ]);

    const context = censusBds.evaluateBdsRows(rows, {
      selectedVariables: Object.keys(VARIABLES_RESPONSE),
      variables: VARIABLES_RESPONSE,
      queryUrl: 'https://api.census.gov/data/timeseries/bds?get=NAME,YEAR',
    });

    expect(context.available).toBe(true);
    expect(context.latestYear).toBe(2023);
    expect(context.metricCount).toBeGreaterThan(5);
    expect(context.averagePositiveGrowthPct).toBeGreaterThan(0);
    expect(context.averageRiskGrowthPct).toBeLessThan(0);
    expect(context.opportunityScore).toBeGreaterThan(50);
    expect(context.momentum).toBe('business-dynamism-expanding');
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining(['business-dynamics-statistics', 'business-dynamics-api']));
  });

  it('scores SaaS and small-business exposure with higher BDS exposure', () => {
    const context = censusBds.evaluateBdsRows(censusBds.parseCensusTable([
      ['NAME', 'YEAR', 'FIRM', 'ESTABS_ENTRY', 'ESTABS_EXIT', 'FIRMDEATH_FIRMS', 'JOB_CREATION', 'JOB_DESTRUCTION'],
      ['United States', '2022', '6000000', '420000', '390000', '300000', '8200000', '7600000'],
      ['United States', '2023', '6300000', '470000', '370000', '280000', '8800000', '7400000'],
    ]));

    const score = censusBds.scoreCandidate({
      candidate: { symbol: 'DOCN', theme: 'saas-growth-profile' },
      bdsContext: context,
    });

    expect(score.exposure).toBeGreaterThan(70);
    expect(score.compositeScore).toBeGreaterThan(50);
    expect(score.explanation).toContain('Census BDS');
    expect(score.topMetrics.length).toBeGreaterThan(0);
  });
});
