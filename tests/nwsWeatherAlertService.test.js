const nwsWeatherAlerts = require('../src/services/nwsWeatherAlertService');

const ALERTS_PAYLOAD = {
  type: 'FeatureCollection',
  features: [
    {
      id: 'https://api.weather.gov/alerts/urn:oid:test-tornado',
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[-90.8, 38.3], [-90.7, 38.3], [-90.7, 38.4], [-90.8, 38.4], [-90.8, 38.3]]],
      },
      properties: {
        id: 'urn:oid:test-tornado',
        '@id': 'https://api.weather.gov/alerts/urn:oid:test-tornado',
        areaDesc: 'St. Louis County',
        geocode: { SAME: ['029189'], UGC: ['MOC189'] },
        affectedZones: ['https://api.weather.gov/zones/county/MOC189'],
        sent: '2026-07-13T15:00:00-05:00',
        effective: '2026-07-13T15:05:00-05:00',
        onset: '2026-07-13T15:10:00-05:00',
        expires: '2026-07-13T15:45:00-05:00',
        status: 'Actual',
        messageType: 'Alert',
        category: 'Met',
        severity: 'Extreme',
        certainty: 'Observed',
        urgency: 'Immediate',
        event: 'Tornado Warning',
        sender: 'w-nws.webmaster@noaa.gov',
        senderName: 'NWS St Louis MO',
        headline: 'Tornado Warning issued for St. Louis County',
        description: 'A severe thunderstorm capable of producing a tornado was located near St. Louis.',
        instruction: 'Take shelter now.',
        response: 'Shelter',
        parameters: { NWSheadline: ['Tornado Warning'] },
      },
    },
    {
      id: 'https://api.weather.gov/alerts/urn:oid:test-heat',
      type: 'Feature',
      geometry: null,
      properties: {
        id: 'urn:oid:test-heat',
        '@id': 'https://api.weather.gov/alerts/urn:oid:test-heat',
        areaDesc: 'Central Missouri',
        sent: '2026-07-13T13:00:00-05:00',
        effective: '2026-07-13T13:00:00-05:00',
        expires: '2026-07-13T20:00:00-05:00',
        status: 'Actual',
        messageType: 'Alert',
        category: 'Met',
        severity: 'Moderate',
        certainty: 'Likely',
        urgency: 'Expected',
        event: 'Heat Advisory',
        headline: 'Heat Advisory remains in effect',
        description: 'Heat index values up to 105 expected.',
        instruction: 'Drink plenty of fluids.',
      },
    },
  ],
};

describe('nwsWeatherAlertService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes NWS GeoJSON alert features with timing, severity, and geometry', () => {
    const [alert] = nwsWeatherAlerts.normalizeAlertFeatures(ALERTS_PAYLOAD.features);

    expect(alert).toMatchObject({
      id: 'urn:oid:test-tornado',
      event: 'Tornado Warning',
      areaDesc: 'St. Louis County',
      severity: 'Extreme',
      urgency: 'Immediate',
      certainty: 'Observed',
      category: 'Met',
      response: 'Shelter',
      affectedZones: ['https://api.weather.gov/zones/county/MOC189'],
      sameCodes: ['029189'],
      ugcCodes: ['MOC189'],
      geometryType: 'Polygon',
    });
    expect(alert.centroid.latitude).toBeCloseTo(38.34, 1);
    expect(alert.bbox).toEqual([-90.8, 38.3, -90.7, 38.4]);
  });

  it('evaluates active weather-alert risk and scores exposed industries differently', () => {
    const context = nwsWeatherAlerts.evaluateWeatherAlertContext({
      alerts: nwsWeatherAlerts.normalizeAlertFeatures(ALERTS_PAYLOAD.features),
      userAgentConfigured: true,
    });

    expect(context.available).toBe(true);
    expect(context.alertCount).toBe(2);
    expect(context.severeAlertCount).toBeGreaterThan(0);
    expect(context.weatherAlertRiskScore).toBeGreaterThan(70);
    expect(context.eventFamilyCounts).toMatchObject({ 'severe-convective': 1, temperature: 1 });

    const builder = nwsWeatherAlerts.scoreCandidate({ candidate: { symbol: 'HD', theme: 'home improvement repair' }, weatherAlertContext: context });
    const insurer = nwsWeatherAlerts.scoreCandidate({ candidate: { symbol: 'ALL', theme: 'insurance' }, weatherAlertContext: context });
    expect(builder.compositeScore).toBeGreaterThan(insurer.compositeScore);
    expect(insurer.explanation).toMatch(/weather catastrophe/);
  });

  it('collects active alerts from NWS with an identifying User-Agent', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ALERTS_PAYLOAD,
      headers: { get: () => 'application/geo+json' },
    });

    const context = await nwsWeatherAlerts.collectWeatherAlertContext({
      onEvent: () => {},
      area: 'MO',
      limit: 10,
    });

    expect(context.available).toBe(true);
    expect(context.alertCount).toBe(2);
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining([
      'nws-api-docs',
      'nws-active-alerts',
      'nws-active-alerts-area',
    ]));
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.weather.gov/alerts/active?area=MO',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': expect.stringContaining('AutoTrader') }),
      })
    );
  });
});
