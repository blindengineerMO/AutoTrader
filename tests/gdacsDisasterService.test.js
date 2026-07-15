const gdacsDisasters = require('../src/services/gdacsDisasterService');

const GDACS_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:gdacs="http://www.gdacs.org" xmlns:georss="http://www.georss.org/georss">
  <channel>
    <item>
      <title>Orange tropical cyclone in Philippines</title>
      <description>Cyclone potentially affecting exposed population.</description>
      <link>https://www.gdacs.org/report.aspx?eventtype=TC&amp;eventid=1001</link>
      <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
      <gdacs:eventtype>TC</gdacs:eventtype>
      <gdacs:alertlevel>Orange</gdacs:alertlevel>
      <gdacs:alertscore>2</gdacs:alertscore>
      <gdacs:eventid>1001</gdacs:eventid>
      <gdacs:episodeid>2001</gdacs:episodeid>
      <geo:Point><geo:lat>13.4</geo:lat><geo:long>122.5</geo:long></geo:Point>
      <georss:point>13.4 122.5</georss:point>
      <gdacs:severity unit="km/h" value="165">Wind 165km/h</gdacs:severity>
      <gdacs:population unit="people" value="1500000">1.5 million people</gdacs:population>
      <gdacs:vulnerability value="2.5" />
      <gdacs:country>Philippines</gdacs:country>
      <gdacs:iso3>PHL</gdacs:iso3>
      <gdacs:cap>https://www.gdacs.org/cap.xml</gdacs:cap>
    </item>
    <item>
      <title>Green earthquake in Papua New Guinea</title>
      <link>https://www.gdacs.org/report.aspx?eventtype=EQ&amp;eventid=1002</link>
      <pubDate>Mon, 13 Jul 2026 09:00:00 GMT</pubDate>
      <gdacs:eventtype>EQ</gdacs:eventtype>
      <gdacs:alertlevel>Green</gdacs:alertlevel>
      <gdacs:eventid>1002</gdacs:eventid>
      <geo:Point><geo:lat>-3.2</geo:lat><geo:long>148.5</geo:long></geo:Point>
      <gdacs:severity unit="M" value="6.4">Magnitude 6.4M</gdacs:severity>
      <gdacs:population unit="in MMI IV" value="55234">60 thousand in MMI IV</gdacs:population>
      <gdacs:country>Papua New Guinea</gdacs:country>
      <gdacs:iso3>PNG</gdacs:iso3>
    </item>
  </channel>
</rss>`;

describe('gdacsDisasterService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses GDACS RSS/GeoRSS events with alert, location, severity, and population exposure', () => {
    const events = gdacsDisasters.parseGdacsRss(GDACS_XML);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      eventType: 'TC',
      eventTypeName: 'tropical cyclone',
      alertLevel: 'Orange',
      country: 'Philippines',
      iso3: 'PHL',
      lat: 13.4,
      lon: 122.5,
      population: { value: 1500000 },
      severity: { value: 165 },
    });
    expect(events[0].link).toContain('&eventid=1001');
  });

  it('evaluates GDACS disaster risk and scores exposed industries differently', () => {
    const context = gdacsDisasters.evaluateDisasterContext({
      events: gdacsDisasters.parseGdacsRss(GDACS_XML),
    });

    const builder = gdacsDisasters.scoreCandidate({ candidate: { symbol: 'CAT', theme: 'construction infrastructure' }, disasterContext: context });
    const insurer = gdacsDisasters.scoreCandidate({ candidate: { symbol: 'ALL', theme: 'insurance' }, disasterContext: context });

    expect(context.available).toBe(true);
    expect(context.highImpactCount).toBeGreaterThan(0);
    expect(context.momentum).toMatch(/^global-disaster-risk-/);
    expect(builder.compositeScore).toBeGreaterThan(insurer.compositeScore);
    expect(insurer.explanation).toMatch(/claims/);
  });

  it('collects a compact context from the public GDACS RSS feed', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => GDACS_XML,
      headers: { get: () => 'application/xml' },
    });

    const context = await gdacsDisasters.collectDisasterContext({ onEvent: () => {} });

    expect(context.available).toBe(true);
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining(['gdacs-rss-georss', 'gdacs-openapi']));
    expect(context.events[0].eventType).toBe('TC');
  });
});
