const vehicleSales = require('../src/services/vehicleSalesService');

const TOTALSA_CSV = `observation_date,TOTALSA
2025-05-01,15.0
2025-06-01,15.4
2026-05-01,15.8
2026-06-01,16.2
`;

const ALTSALES_CSV = `observation_date,ALTSALES
2025-05-01,14.3
2025-06-01,14.6
2026-05-01,15.0
2026-06-01,15.5
`;

const DAUTOSAAR_CSV = `observation_date,DAUTOSAAR
2025-05-01,2.6
2025-06-01,2.7
2026-05-01,2.9
2026-06-01,3.1
`;

describe('vehicleSalesService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses FRED vehicle-sales CSV rows with BEA/FRED source lineage', () => {
    const rows = vehicleSales.parseFredCsv(TOTALSA_CSV, vehicleSales.FRED_VEHICLE_SERIES[0]);

    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({
      id: 'TOTALSA',
      metric: 'totalVehicleSales',
      period: '2026-06-01',
      value: 16.2,
      source: 'FRED direct CSV',
    });
    expect(rows[3].sourceOriginal).toMatch(/Bureau of Economic Analysis/);
  });

  it('evaluates aggregate vehicle-sales momentum and scores automakers differently than neutral candidates', () => {
    const context = vehicleSales.evaluateVehicleSalesContext({
      series: [
        ...vehicleSales.parseFredCsv(TOTALSA_CSV, vehicleSales.FRED_VEHICLE_SERIES[0]),
        ...vehicleSales.parseFredCsv(ALTSALES_CSV, vehicleSales.FRED_VEHICLE_SERIES[1]),
        ...vehicleSales.parseFredCsv(DAUTOSAAR_CSV, vehicleSales.FRED_VEHICLE_SERIES[2]),
      ],
    });

    const ford = vehicleSales.scoreCandidate({ candidate: { symbol: 'F', theme: 'automaker' }, vehicleSalesContext: context });
    const neutral = vehicleSales.scoreCandidate({ candidate: { symbol: 'MSFT', theme: 'software' }, vehicleSalesContext: context });

    expect(context.available).toBe(true);
    expect(context.momentum).toBe('vehicle-demand-expanding');
    expect(context.averageYoYChangePct).toBeGreaterThan(0);
    expect(ford.compositeScore).toBeGreaterThan(neutral.compositeScore);
    expect(ford.explanation).toMatch(/BEA\/FRED vehicle-sales/);
  });

  it('collects FRED CSV vehicle-sales context when no BEA API key is configured', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => {
        const target = String(url);
        if (target.includes('TOTALSA')) return TOTALSA_CSV;
        if (target.includes('ALTSALES')) return ALTSALES_CSV;
        if (target.includes('DAUTOSAAR')) return DAUTOSAAR_CSV;
        return '';
      },
    }));

    const context = await vehicleSales.collectVehicleSalesContext({ beaApiKey: '', onEvent: () => {} });

    expect(context.available).toBe(true);
    expect(context.beaApiConfigured).toBe(false);
    expect(context.fredCsvUsed).toBe(true);
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining(['bea-api', 'fred-vehicle-sales-csv']));
  });
});
