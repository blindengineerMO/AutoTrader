const usgsEarthquakes = require('../src/services/usgsEarthquakeService');

const GEOJSON_PAYLOAD = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'us7000abcd',
      properties: {
        mag: 7.1,
        place: 'near Honshu, Japan',
        time: Date.parse('2026-07-13T10:00:00Z'),
        updated: Date.parse('2026-07-13T10:15:00Z'),
        url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd',
        detail: 'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us7000abcd&format=geojson',
        felt: 240,
        cdi: 6.2,
        mmi: 7.1,
        alert: 'orange',
        status: 'reviewed',
        tsunami: 1,
        sig: 980,
        net: 'us',
        code: '7000abcd',
        ids: ',us7000abcd,',
        sources: ',us,',
        types: ',dyfi,losspager,moment-tensor,shakemap,',
        nst: 120,
        dmin: 0.4,
        rms: 0.8,
        gap: 25,
        magType: 'mww',
        type: 'earthquake',
        title: 'M 7.1 - near Honshu, Japan',
      },
      geometry: { type: 'Point', coordinates: [142.1, 38.2, 32] },
    },
    {
      type: 'Feature',
      id: 'us7000efgh',
      properties: {
        mag: 4.8,
        place: 'central California',
        time: Date.parse('2026-07-12T09:00:00Z'),
        updated: Date.parse('2026-07-12T09:05:00Z'),
        url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000efgh',
        detail: 'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us7000efgh&format=geojson',
        alert: 'green',
        tsunami: 0,
        sig: 385,
        magType: 'ml',
        type: 'earthquake',
        title: 'M 4.8 - central California',
      },
      geometry: { type: 'Point', coordinates: [-121.3, 36.8, 95] },
    },
  ],
};

describe('usgsEarthquakeService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes USGS GeoJSON features with seismic scoring fields', () => {
    const [event] = usgsEarthquakes.normalizeGeoJsonFeatures(GEOJSON_PAYLOAD.features);

    expect(event).toMatchObject({
      id: 'us7000abcd',
      title: 'M 7.1 - near Honshu, Japan',
      place: 'near Honshu, Japan',
      magnitude: 7.1,
      depthKm: 32,
      longitude: 142.1,
      latitude: 38.2,
      alert: 'orange',
      tsunami: true,
      cdi: 6.2,
      mmi: 7.1,
      significance: 980,
    });
  });

  it('evaluates earthquake risk and scores exposed industries differently', () => {
    const context = usgsEarthquakes.evaluateEarthquakeContext({
      events: usgsEarthquakes.normalizeGeoJsonFeatures(GEOJSON_PAYLOAD.features),
    });

    expect(context.available).toBe(true);
    expect(context.highMagnitudeCount).toBe(1);
    expect(context.shallowHighMagnitudeCount).toBe(1);
    expect(context.tsunamiCount).toBe(1);
    expect(context.momentum).toMatch(/^seismic-risk-/);
    expect(context.earthquakeRiskScore).toBeGreaterThan(60);

    const builder = usgsEarthquakes.scoreCandidate({ candidate: { symbol: 'CAT', theme: 'construction infrastructure' }, earthquakeContext: context });
    const insurer = usgsEarthquakes.scoreCandidate({ candidate: { symbol: 'ALL', theme: 'insurance' }, earthquakeContext: context });
    expect(builder.compositeScore).toBeGreaterThan(insurer.compositeScore);
    expect(insurer.explanation).toMatch(/catastrophe/);
  });

  it('collects catalog query and real-time feed data from USGS endpoints', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => GEOJSON_PAYLOAD,
      headers: { get: () => 'application/geo+json' },
    });

    const context = await usgsEarthquakes.collectEarthquakeContext({
      onEvent: () => {},
      minMagnitude: 4.5,
      days: 30,
      limit: 10,
    });

    expect(context.available).toBe(true);
    expect(context.eventCount).toBe(2);
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining([
      'usgs-earthquake-docs',
      'usgs-earthquake-query',
      'usgs-earthquake-m25-day-feed',
    ]));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
