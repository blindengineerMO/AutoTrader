const eonetNaturalEvents = require('../src/services/eonetNaturalEventService');

const EVENTS_PAYLOAD = {
  title: 'EONET Events',
  events: [
    {
      id: 'EONET_1001',
      title: 'Wildfire in California',
      description: 'Large wildfire event.',
      link: 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_1001',
      closed: null,
      categories: [{ id: 'wildfires', title: 'Wildfires' }],
      sources: [{ id: 'InciWeb', url: 'https://inciweb.wildfire.gov/incident/1001' }],
      geometry: [
        {
          magnitudeValue: 12345,
          magnitudeUnit: 'acres',
          date: '2026-07-13T00:00:00Z',
          type: 'Point',
          coordinates: [-121.5, 39.4],
        },
      ],
    },
    {
      id: 'EONET_1002',
      title: 'Volcanic Ash Advisory',
      closed: '2026-07-12T00:00:00Z',
      categories: [{ id: 'volcanoes', title: 'Volcanoes' }],
      sources: [{ id: 'EO', url: 'https://earthobservatory.nasa.gov/' }],
      geometry: [
        {
          magnitudeValue: 38000,
          magnitudeUnit: 'ft',
          date: '2026-07-12T00:00:00Z',
          type: 'Point',
          coordinates: [-155.3, 19.4],
        },
      ],
    },
  ],
};

const CATEGORIES_PAYLOAD = {
  categories: [
    { id: 'wildfires', title: 'Wildfires', description: 'Fire events.', link: 'https://eonet.gsfc.nasa.gov/api/v3/categories/wildfires' },
    { id: 'volcanoes', title: 'Volcanoes', description: 'Volcanic events.', link: 'https://eonet.gsfc.nasa.gov/api/v3/categories/volcanoes' },
  ],
};

describe('eonetNaturalEventService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes EONET events with categories, source URLs, geometry, and magnitude', () => {
    const [event] = eonetNaturalEvents.normalizeEvents(EVENTS_PAYLOAD.events);

    expect(event).toMatchObject({
      id: 'EONET_1001',
      title: 'Wildfire in California',
      isOpen: true,
      categoryIds: ['wildfires'],
      sourceUrls: ['https://inciweb.wildfire.gov/incident/1001'],
      latitude: 39.4,
      longitude: -121.5,
      magnitudeValue: 12345,
      magnitudeUnit: 'acres',
    });
  });

  it('evaluates natural-event risk and candidate exposure', () => {
    const context = eonetNaturalEvents.evaluateNaturalEventContext({
      events: eonetNaturalEvents.normalizeEvents(EVENTS_PAYLOAD.events),
      categories: eonetNaturalEvents.normalizeCategories(CATEGORIES_PAYLOAD.categories),
    });

    expect(context.available).toBe(true);
    expect(context.categoryCounts).toMatchObject({ wildfires: 1, volcanoes: 1 });
    expect(context.wildfireRiskScore).toBeGreaterThan(50);
    expect(context.aviationVisibilityRiskScore).toBeGreaterThan(50);

    const builder = eonetNaturalEvents.scoreCandidate({ candidate: { symbol: 'CAT', theme: 'construction infrastructure' }, naturalEventContext: context });
    const airline = eonetNaturalEvents.scoreCandidate({ candidate: { symbol: 'DAL', theme: 'airline travel' }, naturalEventContext: context });
    expect(builder.compositeScore).toBeGreaterThan(airline.compositeScore);
    expect(builder.explanation).toMatch(/NASA EONET/);
  });

  it('collects open events, recent events, and categories from public EONET endpoints', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => String(url).includes('/categories')
        ? JSON.stringify(CATEGORIES_PAYLOAD)
        : JSON.stringify(EVENTS_PAYLOAD),
      headers: { get: () => 'application/rss+xml; charset=utf-8' },
    }));

    const context = await eonetNaturalEvents.collectNaturalEventContext({ onEvent: () => {}, days: 30, limit: 10 });

    expect(context.available).toBe(true);
    expect(context.eventCount).toBe(2);
    expect(context.openEventCount).toBe(1);
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining([
      'nasa-eonet-open-events',
      'nasa-eonet-recent-events',
      'nasa-eonet-categories',
    ]));
  });
});
