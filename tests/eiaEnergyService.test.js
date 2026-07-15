const eiaEnergy = require('../src/services/eiaEnergyService');

const GAS_DIESEL_HTML = `
  <h2>U.S. Regular Gasoline Prices</h2>
  <p>Gasoline Release Date: July 13, 2026</p>
  <table><tr><td>U.S.</td><td>3.475</td><td>3.445</td><td>3.512</td><td>NA</td><td>NA</td><td>0.067</td></tr></table>
  <h2>U.S. On-Highway Diesel Fuel Prices</h2>
  <table><tr><td>U.S.</td><td>4.020</td><td>4.080</td><td>4.175</td><td>NA</td><td>NA</td><td>0.095</td></tr></table>
  <h2>Residential Propane</h2>
`;

describe('eiaEnergyService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds EIA API v2 query URLs with key support and redaction', () => {
    const url = eiaEnergy.buildEiaQueryUrl(eiaEnergy.API_SERIES_PACKS[0], { apiKey: 'eia-secret', length: 3 });

    expect(url).toContain('https://api.eia.gov/v2/petroleum/pri/gnd/data/?');
    expect(url).toContain('frequency=weekly');
    expect(url).toContain('data%5B0%5D=value');
    expect(url).toContain('facets%5Bduoarea%5D%5B%5D=NUS');
    expect(url).toContain('facets%5Bproduct%5D%5B%5D=EPM0_PTE_NUS_DPG');
    expect(url).toContain('api_key=eia-secret');
    expect(eiaEnergy.stripKey(url)).not.toContain('eia-secret');
  });

  it('parses public EIA gasoline and diesel prices as a no-key fallback', () => {
    const series = eiaEnergy.parseGasDieselPage(GAS_DIESEL_HTML);

    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({
      metric: 'gasolinePrice',
      value: 3.512,
      weekOverWeekChange: 0.067,
      source: 'EIA Gasoline and Diesel Fuel Update',
    });
    expect(series[1]).toMatchObject({
      metric: 'dieselPrice',
      value: 4.175,
      weekOverWeekChange: 0.095,
    });
  });

  it('evaluates fuel pressure and scores energy versus fuel-sensitive candidates differently', () => {
    const context = eiaEnergy.evaluateEnergyContext({
      apiConfigured: false,
      fallbackUsed: true,
      series: eiaEnergy.parseGasDieselPage(GAS_DIESEL_HTML),
    });

    const energy = eiaEnergy.scoreCandidate({ candidate: { symbol: 'XOM', theme: 'energy' }, energyContext: context });
    const logistics = eiaEnergy.scoreCandidate({ candidate: { symbol: 'FDX', theme: 'logistics' }, energyContext: context });

    expect(context.available).toBe(true);
    expect(context.energyPricePressureScore).toBeGreaterThan(50);
    expect(energy.compositeScore).toBeGreaterThan(logistics.compositeScore);
    expect(energy.explanation).toContain('EIA');
    expect(logistics.explanation).toMatch(/shipping/i);
  });

  it('collects public EIA fallback context when no API key is configured', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => GAS_DIESEL_HTML,
      headers: { get: () => 'text/html' },
    });

    const context = await eiaEnergy.collectEnergyFuelContext({ apiKey: '', onEvent: () => {} });

    expect(context.available).toBe(true);
    expect(context.apiConfigured).toBe(false);
    expect(context.fallbackUsed).toBe(true);
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining(['eia-public-fuel-prices']));
  });
});
