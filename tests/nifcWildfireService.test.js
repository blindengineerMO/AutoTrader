const nifcWildfires = require('../src/services/nifcWildfireService');

const WFIGS_PAYLOAD = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[-121.2, 38.4], [-121.0, 38.4], [-121.0, 38.6], [-121.2, 38.6], [-121.2, 38.4]]],
      },
      properties: {
        OBJECTID: 1,
        poly_IncidentName: 'Quartz Ridge',
        poly_IRWINID: '{IRWIN-1}',
        poly_GISAcres: 42000,
        poly_Acres_AutoCalc: 42110,
        poly_FeatureStatus: 'Active',
        poly_DateCurrent: 1783968000000,
        attr_IncidentName: 'Quartz Ridge',
        attr_IncidentTypeCategory: 'WF',
        attr_IncidentSize: 42000,
        attr_PercentContained: 22,
        attr_POOState: 'CA',
        attr_POOCounty: 'El Dorado',
        attr_FireDiscoveryDateTime: 1783795200000,
        attr_TotalIncidentPersonnel: 840,
        attr_EstimatedCostToDate: 12000000,
      },
    },
    {
      type: 'Feature',
      geometry: null,
      properties: {
        OBJECTID: 2,
        poly_IncidentName: 'Prairie Creek',
        poly_IRWINID: '{IRWIN-2}',
        poly_GISAcres: 1800,
        poly_FeatureStatus: 'Mapped',
        attr_IncidentTypeCategory: 'WF',
        attr_PercentContained: 85,
        attr_POOState: 'MT',
        attr_POOCounty: 'Lewis and Clark',
      },
    },
  ],
};

const DCAT_PAYLOAD = {
  dataset: [
    {
      identifier: 'current-perimeters',
      title: 'WFIGS Current Interagency Fire Perimeters',
      description: '<p>Best available perimeters for recent and ongoing wildland fires.</p>',
      landingPage: 'https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-interagency-fire-perimeters/about',
      modified: '2026-07-13T12:00:00Z',
      keyword: ['WFIGS', 'wildfire', 'perimeter'],
      distribution: [{ title: 'GeoJSON', format: 'GeoJSON', accessURL: 'https://example.com/wfigs.geojson' }],
    },
    { identifier: 'unrelated', title: 'Office locations', keyword: ['administrative'] },
  ],
};

describe('nifcWildfireService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes WFIGS GeoJSON perimeter features with acres, containment, and geometry', () => {
    const [incident] = nifcWildfires.normalizePerimeterFeatures(WFIGS_PAYLOAD.features);

    expect(incident).toMatchObject({
      id: '{IRWIN-1}',
      name: 'Quartz Ridge',
      irwinId: '{IRWIN-1}',
      incidentStatus: 'Active',
      incidentType: 'WF',
      state: 'CA',
      county: 'El Dorado',
      acres: 42000,
      percentContained: 22,
      geometryType: 'Polygon',
    });
    expect(incident.centroid.latitude).toBeCloseTo(38.48, 1);
    expect(incident.bbox).toEqual([-121.2, 38.4, -121, 38.6]);
    expect(incident.impactScore).toBeGreaterThan(70);
  });

  it('scores wildfire context and candidate exposure by industry role', () => {
    const context = nifcWildfires.evaluateWildfireContext({
      incidents: nifcWildfires.normalizePerimeterFeatures(WFIGS_PAYLOAD.features),
      discoveredDatasets: nifcWildfires.normalizeDcatDatasets(DCAT_PAYLOAD.dataset),
      preparednessLevel: 4,
    });

    expect(context.available).toBe(true);
    expect(context.incidentCount).toBe(2);
    expect(context.largeFireCount).toBe(1);
    expect(context.totalAcres).toBe(43800);
    expect(context.preparednessLevel).toBe(4);
    expect(context.wildfireRiskScore).toBeGreaterThan(70);
    expect(context.discoveredDatasets[0].title).toBe('WFIGS Current Interagency Fire Perimeters');

    const builder = nifcWildfires.scoreCandidate({ candidate: { symbol: 'CAT', theme: 'construction equipment recovery' }, wildfireContext: context });
    const insurer = nifcWildfires.scoreCandidate({ candidate: { symbol: 'ALL', theme: 'insurance' }, wildfireContext: context });
    expect(builder.compositeScore).toBeGreaterThan(insurer.compositeScore);
    expect(insurer.explanation).toMatch(/wildfire catastrophe/);
  });

  it('collects NIFC/WFIGS context from ArcGIS and fire-information sources', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      expect(options.headers['User-Agent']).toContain('AutoTrader');
      if (target.includes('/FeatureServer/0/query')) return jsonResponse(WFIGS_PAYLOAD);
      if (target.includes('/api/feed/dcat-us/1.1.json')) return jsonResponse(DCAT_PAYLOAD);
      if (target === nifcWildfires.NIFC_FIRE_INFORMATION_URL) return textResponse('<html><body>Current Preparedness Level PL 4</body></html>');
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const context = await nifcWildfires.collectWildfireContext({ limit: 10, onEvent: () => {} });

    expect(context.available).toBe(true);
    expect(context.incidentCount).toBe(2);
    expect(context.preparednessLevel).toBe(4);
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining([
      'nifc-fire-information',
      'nifc-open-data-dcat',
      'nifc-wfigs-current-perimeters-featureserver',
    ]));
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/FeatureServer/0/query?'),
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: expect.stringContaining('application/geo+json') }),
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
