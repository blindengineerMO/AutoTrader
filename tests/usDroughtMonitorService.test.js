const usDroughtMonitor = require('../src/services/usDroughtMonitorService');

const SEVERITY_ROWS = [
  {
    mapDate: '2026-07-07T00:00:00',
    areaOfInterest: 'CONUS',
    none: 33.1,
    d0: 66.9,
    d1: 47.2,
    d2: 29.99,
    d3: 11.23,
    d4: 0.96,
    validStart: '2026-07-07T00:00:00',
    validEnd: '2026-07-13T00:00:00',
    statisticFormatID: 1,
  },
  {
    mapDate: '2026-06-30T00:00:00',
    areaOfInterest: 'CONUS',
    none: 34.3,
    d0: 65.7,
    d1: 45.8,
    d2: 27.2,
    d3: 10.1,
    d4: 0.8,
    statisticFormatID: 1,
  },
  {
    mapDate: '2026-07-07T00:00:00',
    areaOfInterest: 'Total',
    none: 42,
    d0: 58,
    d1: 39,
    d2: 22,
    d3: 6,
    d4: 0.5,
  },
];

const DSCI_ROWS = [
  { name: 'CONUS', mapDate: '2026-06-30T00:00:00', dsci: 151 },
  { name: 'CONUS', mapDate: '2026-07-07T00:00:00', dsci: 156 },
  { name: 'Total', mapDate: '2026-07-07T00:00:00', dsci: 122 },
];

describe('usDroughtMonitorService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes USDM severity and DSCI rows', () => {
    const severity = usDroughtMonitor.normalizeSeverityRows(SEVERITY_ROWS);
    const dsci = usDroughtMonitor.normalizeDsciRows(DSCI_ROWS);

    expect(severity[0]).toMatchObject({
      mapDate: '2026-07-07',
      areaOfInterest: 'CONUS',
      d0: 66.9,
      d2: 29.99,
      d4: 0.96,
      statisticFormatID: 1,
    });
    expect(dsci[0]).toMatchObject({
      name: 'CONUS',
      mapDate: '2026-07-07',
      dsci: 156,
    });
  });

  it('scores drought context and candidate exposure by sector role', () => {
    const context = usDroughtMonitor.evaluateDroughtContext({
      severityRows: usDroughtMonitor.normalizeSeverityRows(SEVERITY_ROWS),
      dsciRows: usDroughtMonitor.normalizeDsciRows(DSCI_ROWS),
      pageSummary: { mapReleaseDate: '2026-07-09', dataValidDate: '2026-07-07' },
    });

    expect(context.available).toBe(true);
    expect(context.areaOfInterest).toBe('CONUS');
    expect(context.dsci).toBe(156);
    expect(context.dsciChange).toBe(5);
    expect(context.severeDroughtPct).toBe(29.99);
    expect(context.agricultureRiskScore).toBeGreaterThan(50);
    expect(context.wildfireAmplificationRiskScore).toBeGreaterThan(50);

    const water = usDroughtMonitor.scoreCandidate({ candidate: { symbol: 'XYL', theme: 'water infrastructure' }, droughtContext: context });
    const food = usDroughtMonitor.scoreCandidate({ candidate: { symbol: 'TSN', theme: 'food processor livestock' }, droughtContext: context });
    expect(water.compositeScore).toBeGreaterThan(food.compositeScore);
    expect(food.explanation).toMatch(/crop, grain, livestock/);
  });

  it('collects USDM REST severity, DSCI, and release metadata', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      expect(options.headers['User-Agent']).toContain('AutoTrader');
      if (target.includes('GetDroughtSeverityStatisticsByAreaPercent')) return jsonResponse(SEVERITY_ROWS);
      if (target.includes('GetDSCI')) return jsonResponse(DSCI_ROWS);
      if (target === usDroughtMonitor.US_DROUGHT_MONITOR_URL) {
        return textResponse('<html><body>Map released July 9, 2026 Data valid July 7, 2026 Data Cutoff is Tuesday at 8 a.m. EDT.</body></html>');
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const context = await usDroughtMonitor.collectDroughtContext({
      startDate: '7/1/2026',
      endDate: '7/7/2026',
      onEvent: () => {},
    });

    expect(context.available).toBe(true);
    expect(context.mapReleaseDate).toBe('2026-07-09');
    expect(context.dataValidDate).toBe('2026-07-07');
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining([
      'usdm-home',
      'usdm-rest-web-service-info',
      'usdm-area-percent-statistics',
      'usdm-dsci-statistics',
      'usdm-gis-data',
    ]));
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/USStatistics/GetDroughtSeverityStatisticsByAreaPercent?'),
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: expect.stringContaining('application/json') }),
      })
    );
  });
});

function jsonResponse(payload) {
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function textResponse(text) {
  return {
    ok: true,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}
