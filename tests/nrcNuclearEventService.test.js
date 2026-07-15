const nrc = require('../src/services/nrcNuclearEventService');

const EVENT_TEXT = `Event Desc|En No|Site Name|Licensee Name|Region No|City Name|State Cd|County Name|License No|Agreement State Ind|Docket No|Notification Dt|Notification Time|Event Dt|Event Time|Time Zone|Last Updated Dt|Emergency Class|Cfr Cd1|Cfr Descr1|Scram Code 1|RX CRIT 1|Initial PWR 1|Current PWR 1|Event Text|
| Power Reactor|58001|Example Nuclear Station|Example Utility|2|Example City|GA|Example County|NPF-1|N|05000111|07/13/2026|11:05|07/13/2026|10:45|EDT|07/13/2026|Alert|50.72|Immediate notification|Y|Y|100|0|AUTOMATIC REACTOR SCRAM DUE TO TURBINE TRIP. Current power reduced to zero while the licensee evaluates the issue.
| Part 21|58002|Component Vendor|Valve Supplier|1|Vendor City|PA|Vendor County|N/A|N||07/12/2026|09:10|07/11/2026|08:15|EDT|07/12/2026|Non Emergency|21.21|Defect report|||||Part 21 report for a potential valve defect affecting nuclear facility safety-related equipment.`;

const REACTOR_STATUS_TEXT = `ReportDt|Unit|Power
7/13/2026 12:00:00 AM|Example Nuclear Station 1|0
7/13/2026 12:00:00 AM|Example Nuclear Station 2|82
7/12/2026 12:00:00 AM|Example Nuclear Station 1|100
7/13/2026 12:00:00 AM|Another Station 1|100`;

describe('nrcNuclearEventService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses NRC event notifications and reactor status raw feeds', () => {
    const events = nrc.normalizeEventNotificationRecords(nrc.parseEventNotificationRecords(EVENT_TEXT));
    const statuses = nrc.normalizeReactorStatusRecords(nrc.parsePipeRecords(REACTOR_STATUS_TEXT));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      eventDescription: 'Power Reactor',
      eventNumber: '58001',
      siteName: 'Example Nuclear Station',
      currentPower: 0,
    });
    expect(events[0].impactScore).toBeGreaterThan(70);
    expect(statuses.find((status) => status.unit === 'Example Nuclear Station 1')).toMatchObject({
      power: 0,
      status: 'offline',
    });
  });

  it('scores context for nuclear utilities, services, and replacement-power beneficiaries', () => {
    const context = nrc.evaluateNuclearEventContext({
      events: nrc.normalizeEventNotificationRecords(nrc.parseEventNotificationRecords(EVENT_TEXT)),
      reactorStatuses: nrc.normalizeReactorStatusRecords(nrc.parsePipeRecords(REACTOR_STATUS_TEXT)),
    });

    expect(context.available).toBe(true);
    expect(context.offlineUnitCount).toBe(1);
    expect(context.deratedUnitCount).toBe(1);
    expect(context.riskScore).toBeGreaterThan(60);

    const utility = nrc.scoreCandidate({ candidate: { symbol: 'DUK', theme: 'nuclear utility' }, nuclearEventContext: context });
    const services = nrc.scoreCandidate({ candidate: { symbol: 'PWR', theme: 'grid maintenance infrastructure' }, nuclearEventContext: context });

    expect(utility.compositeScore).toBeLessThan(50);
    expect(services.compositeScore).toBeGreaterThan(50);
    expect(services.explanation).toMatch(/NRC/);
  });

  it('collects NRC context and exposes compact BMCL-safe payloads', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('event-notification-rpt-lastmonth')) return textResponse(EVENT_TEXT);
      if (target.includes('PowerReactorStatusForLast365Days')) return textResponse(REACTOR_STATUS_TEXT);
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const context = await nrc.collectNuclearEventContext({ onEvent: () => {}, eventLimit: 10, reactorLimit: 10 });
    const compact = nrc.compactForBmcl(context);

    expect(context.available).toBe(true);
    expect(compact.scores).toMatchObject({
      risk: context.riskScore,
      reactorOutage: context.reactorOutageScore,
    });
    expect(compact.topEvents[0].sourceUrl).toContain('event-notification-rpt-lastmonth');
    expect(compact.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'nrc-event-notification-reports',
      'nrc-power-reactor-status-last365-raw',
    ]));
  });
});

function textResponse(text) {
  return {
    ok: true,
    status: 200,
    text: async () => text,
  };
}
