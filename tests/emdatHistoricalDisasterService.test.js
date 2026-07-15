const emdat = require('../src/services/emdatHistoricalDisasterService');

const PACKAGE_SEARCH_RESPONSE = {
  success: true,
  result: {
    results: [
      {
        id: 'pkg-1',
        name: 'emdat-country-profile',
        title: 'EM-DAT Country Profile historical disasters',
        notes: 'Historical disasters include deaths, injuries, people affected, people displaced, economic damage, floods, storms, drought, earthquake, and international assistance.',
        url: 'https://data.humdata.org/dataset/emdat-country-profile',
        dataset_date: '1900-01-01/2026-07-01',
        metadata_modified: '2026-07-11T00:00:00',
        data_update_frequency: 'Every month',
        dataset_source: 'Centre for Research on the Epidemiology of Disasters',
        license_id: 'other-pd-nr',
        license_title: 'Other',
        license_other: 'Open for non-commercial use subject to EM-DAT terms. Registration may be required for detailed downloads.',
        isopen: true,
        resources: [{
          id: 'res-1',
          name: 'EM-DAT country profile CSV',
          format: 'CSV',
          url: 'https://data.humdata.org/download/emdat-country-profile.csv',
          mimetype: 'text/csv',
          size: 1234,
        }],
      },
    ],
  },
};

const ORG_RESPONSE = {
  success: true,
  result: {
    id: 'cred',
    name: 'cred',
    title: 'Centre for Research on the Epidemiology of Disasters',
    description: 'CRED maintains EM-DAT disaster data products.',
    url: 'https://data.humdata.org/organization/cred',
    package_count: 135,
  },
};

describe('emdatHistoricalDisasterService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes HDX CRED package metadata', () => {
    const [dataset] = emdat.normalizeHdxPackages(PACKAGE_SEARCH_RESPONSE.result.results);

    expect(dataset).toMatchObject({
      id: 'pkg-1',
      name: 'emdat-country-profile',
      title: 'EM-DAT Country Profile historical disasters',
      datasetDate: { start: '1900-01-01', end: '2026-07-01' },
      datasetSource: 'Centre for Research on the Epidemiology of Disasters',
      isOpen: true,
    });
    expect(dataset.resources[0]).toMatchObject({
      name: 'EM-DAT country profile CSV',
      format: 'CSV',
    });
  });

  it('evaluates historical disaster context and scores exposed industries', () => {
    const context = emdat.evaluateHistoricalDisasterContext({
      datasets: emdat.normalizeHdxPackages(PACKAGE_SEARCH_RESPONSE.result.results),
      organization: emdat.normalizeOrganization(ORG_RESPONSE.result),
    });

    expect(context.available).toBe(true);
    expect(context.datasetCount).toBe(1);
    expect(context.historicalImpactModelingScore).toBeGreaterThan(45);
    expect(context.economicLossModelingScore).toBeGreaterThan(40);
    expect(context.registeredAccessRequired).toBe(true);

    const builder = emdat.scoreCandidate({ candidate: { symbol: 'CAT', theme: 'construction infrastructure' }, historicalDisasterContext: context });
    const insurer = emdat.scoreCandidate({ candidate: { symbol: 'ALL', theme: 'insurance' }, historicalDisasterContext: context });
    expect(builder.compositeScore).toBeGreaterThan(insurer.compositeScore);
    expect(builder.explanation).toMatch(/EM-DAT/);
  });

  it('collects public CRED/EM-DAT dataset inventory from HDX APIs', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => String(url).includes('package_search')
        ? JSON.stringify(PACKAGE_SEARCH_RESPONSE)
        : JSON.stringify(ORG_RESPONSE),
      headers: { get: () => 'application/json' },
    }));

    const context = await emdat.collectHistoricalDisasterContext({ onEvent: () => {}, limit: 5 });

    expect(context.available).toBe(true);
    expect(context.datasetCount).toBe(1);
    expect(context.organization.title).toBe('Centre for Research on the Epidemiology of Disasters');
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('package_search'), expect.any(Object));
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining([
      'emdat-main',
      'emdat-docs',
      'emdat-hdx-package-search',
    ]));
  });
});
