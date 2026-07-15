const unhcr = require('../src/services/unhcrRefugeeStatisticsService');

const YEARS_RESPONSE = {
  items: [{ year: '2026' }, { year: '2025' }, { year: '2024' }],
};

const AGGREGATE_2025 = {
  items: [{
    year: '2025',
    refugees: '28461306',
    asylum_seekers: '8998097',
    returned_refugees: '4362272',
    idps: '64239352',
    returned_idps: '10308567',
    stateless: '4477220',
    ooc: '2957025',
    oip: '7177473',
    hst: '26670162',
  }],
};

const ORIGIN_2025 = {
  items: [
    { year: '2025', coo: 'SYR', coo_name: 'Syrian Arab Republic', coo_iso: 'SYR', refugees: '6500000', asylum_seekers: '100000', idps: '7200000', stateless: '-' },
    { year: '2025', coo: 'AFG', coo_name: 'Afghanistan', coo_iso: 'AFG', refugees: '6100000', asylum_seekers: '250000', idps: '3200000' },
  ],
};

const HOST_2025 = {
  items: [
    { year: '2025', coa: 'TUR', coa_name: 'Turkiye', coa_iso: 'TUR', refugees: '3200000', asylum_seekers: '90000', idps: '0', stateless: '1000' },
    { year: '2025', coa: 'DEU', coa_name: 'Germany', coa_iso: 'DEU', refugees: '2600000', asylum_seekers: '360000', idps: '0', stateless: '12000' },
  ],
};

const COUNTRIES_RESPONSE = {
  items: [
    { code: 'SYR', iso: 'SYR', iso2: 'SY', name: 'Syrian Arab Republic', majorArea: 'Asia', region: 'Western Asia' },
    { code: 'DEU', iso: 'DEU', iso2: 'DE', name: 'Germany', majorArea: 'Europe', region: 'Western Europe' },
  ],
};

describe('unhcrRefugeeStatisticsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes population rows, country metadata, and available years', () => {
    const rows = unhcr.normalizePopulationRows([
      { year: '2025', coo: 'SYR', coo_name: 'Syrian Arab Republic', refugees: '12', asylum_seekers: '-', idps: '3', stateless: '2' },
    ]);
    const countries = unhcr.normalizeCountries(COUNTRIES_RESPONSE.items);
    const years = unhcr.normalizeYears(YEARS_RESPONSE.items);

    expect(rows[0]).toMatchObject({
      year: 2025,
      originCode: 'SYR',
      originName: 'Syrian Arab Republic',
      refugees: 12,
      asylumSeekers: 0,
      idps: 3,
      stateless: 2,
    });
    expect(countries[0]).toMatchObject({ code: 'SYR', iso: 'SYR', region: 'Western Asia' });
    expect(years).toEqual([2026, 2025, 2024]);
  });

  it('evaluates forced displacement context and scores exposed candidates', () => {
    const context = unhcr.evaluateRefugeeStatisticsContext({
      aggregate: unhcr.normalizePopulationRows(AGGREGATE_2025.items)[0],
      origins: unhcr.normalizePopulationRows(ORIGIN_2025.items),
      hosts: unhcr.normalizePopulationRows(HOST_2025.items),
      countries: unhcr.normalizeCountries(COUNTRIES_RESPONSE.items),
      years: [2026, 2025],
      selectedYear: 2025,
    });

    expect(context.available).toBe(true);
    expect(context.latestYear).toBe(2025);
    expect(context.totalForcedDisplacement).toBeGreaterThan(100_000_000);
    expect(context.refugeesAndAsylum).toBeGreaterThan(30_000_000);
    expect(context.aidDemandScore).toBeGreaterThan(60);
    expect(context.healthcareDemandScore).toBeGreaterThan(50);

    const shelter = unhcr.scoreCandidate({ candidate: { symbol: 'CAT', theme: 'construction infrastructure' }, refugeeContext: context });
    const logistics = unhcr.scoreCandidate({ candidate: { symbol: 'UPS', theme: 'logistics' }, refugeeContext: context });
    expect(shelter.compositeScore).toBeGreaterThan(logistics.compositeScore);
    expect(shelter.explanation).toMatch(/UNHCR/);
  });

  it('collects the latest non-empty UNHCR reporting year and compact BMCL payload', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      expect(options.headers['User-Agent']).toContain('AutoTrader');
      if (target.includes('/years/')) return jsonResponse(YEARS_RESPONSE);
      if (target.includes('/countries/')) return jsonResponse(COUNTRIES_RESPONSE);
      if (target.includes('year=2026')) return jsonResponse({ items: [] });
      if (target.includes('coo_all=true')) return jsonResponse(ORIGIN_2025);
      if (target.includes('coa_all=true')) return jsonResponse(HOST_2025);
      if (target.includes('year=2025')) return jsonResponse(AGGREGATE_2025);
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const context = await unhcr.collectRefugeeStatisticsContext({ onEvent: () => {}, limit: 50 });
    const compact = unhcr.compactForBmcl(context);

    expect(context.available).toBe(true);
    expect(context.latestYear).toBe(2025);
    expect(context.topOriginCountries[0].originName).toBe('Syrian Arab Republic');
    expect(context.topHostCountries[0].hostName).toBe('Turkiye');
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining([
      'unhcr-refugee-data-finder',
      'unhcr-population-api',
      'unhcr-years-api',
      'unhcr-countries-api',
    ]));
    expect(compact.totals.refugees).toBe(28461306);
    expect(compact.bmclUse).toMatch(/UNHCR Refugee Statistics/);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/population/?limit=10&page=1&year=2026'), expect.any(Object));
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/population/?limit=10&page=1&year=2025'), expect.any(Object));
  });
});

function jsonResponse(payload) {
  return {
    ok: true,
    text: async () => JSON.stringify(payload),
  };
}
