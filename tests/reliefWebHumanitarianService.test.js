const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-reliefweb.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const providerCredentialRepo = require('../src/db/repositories/providerCredentialRepo');
const reliefWeb = require('../src/services/reliefWebHumanitarianService');

const DISASTERS_RESPONSE = {
  data: [
    {
      id: 'DR-1001',
      href: 'https://api.reliefweb.int/v2/disasters/1001',
      fields: {
        name: 'Floods in Country A',
        status: 'ongoing',
        type: [{ id: 4618, name: 'Flood' }],
        country: [{ id: 1, name: 'Country A' }],
        date: { created: '2026-07-12T00:00:00+00:00', changed: '2026-07-13T00:00:00+00:00' },
        url: 'https://reliefweb.int/disaster/fl-2026-000001-cta',
      },
    },
  ],
};

const REPORTS_RESPONSE = {
  data: [
    {
      id: 'RP-2001',
      href: 'https://api.reliefweb.int/v2/reports/2001',
      fields: {
        title: 'Country A floods situation report: displaced families need shelter and water',
        body: 'Humanitarian partners report displaced people, damaged roads, health risks, aid requirements, and emergency response activity.',
        url: 'https://reliefweb.int/report/country-a/floods-situation-report',
        source: [{ id: 10, name: 'UN Office for the Coordination of Humanitarian Affairs' }],
        country: [{ id: 1, name: 'Country A' }],
        disaster: [{ id: 'DR-1001', name: 'Floods in Country A' }],
        theme: [{ id: 100, name: 'Shelter and Non-Food Items' }],
        format: [{ id: 8, name: 'Situation Report' }],
        date: { original: '2026-07-13T06:00:00+00:00', created: '2026-07-13T08:00:00+00:00' },
      },
    },
  ],
};

describe('reliefWebHumanitarianService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes ReliefWeb disaster and report records', () => {
    const [disaster] = reliefWeb.normalizeDisasters(DISASTERS_RESPONSE.data);
    const [report] = reliefWeb.normalizeReports(REPORTS_RESPONSE.data);

    expect(disaster).toMatchObject({
      id: 'DR-1001',
      name: 'Floods in Country A',
      status: 'ongoing',
      type: [{ id: '4618', name: 'Flood' }],
      country: [{ id: '1', name: 'Country A' }],
    });
    expect(report).toMatchObject({
      id: 'RP-2001',
      title: 'Country A floods situation report: displaced families need shelter and water',
      sourceOrganizations: [{ id: '10', name: 'UN Office for the Coordination of Humanitarian Affairs' }],
      disaster: [{ id: 'DR-1001', name: 'Floods in Country A' }],
    });
  });

  it('evaluates humanitarian impact and scores exposed industries', () => {
    const context = reliefWeb.evaluateHumanitarianContext({
      disasters: reliefWeb.normalizeDisasters(DISASTERS_RESPONSE.data),
      reports: reliefWeb.normalizeReports(REPORTS_RESPONSE.data),
      appConfigured: true,
    });

    expect(context.available).toBe(true);
    expect(context.humanitarianImpactScore).toBeGreaterThan(40);
    expect(context.aidRequirementScore).toBeGreaterThan(40);
    expect(context.supplyChainDisruptionScore).toBeGreaterThan(40);

    const builder = reliefWeb.scoreCandidate({ candidate: { symbol: 'CAT', theme: 'construction infrastructure' }, humanitarianContext: context });
    const insurer = reliefWeb.scoreCandidate({ candidate: { symbol: 'ALL', theme: 'insurance' }, humanitarianContext: context });
    expect(builder.compositeScore).toBeGreaterThan(insurer.compositeScore);
    expect(builder.explanation).toMatch(/ReliefWeb/);
  });

  it('collects ReliefWeb disasters and reports using the configured appName', async () => {
    const user = userRepo.createUser({
      email: `reliefweb-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    providerCredentialRepo.save({
      userId: user.id,
      providerType: 'data-source',
      providerKey: 'reliefweb',
      displayName: 'ReliefWeb',
      fields: { appName: 'approved-test-app' },
    });
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => String(url).includes('/disasters')
        ? JSON.stringify(DISASTERS_RESPONSE)
        : JSON.stringify(REPORTS_RESPONSE),
      headers: { get: () => 'application/json' },
    }));

    const context = await reliefWeb.collectHumanitarianContext({ userId: user.id, onEvent: () => {}, limit: 5 });

    expect(context.available).toBe(true);
    expect(context.appConfigured).toBe(true);
    expect(context.disasterCount).toBe(1);
    expect(context.reportCount).toBe(1);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('appname=approved-test-app'), expect.any(Object));
    expect(context.sourceList.map((source) => source.type)).toEqual(expect.arrayContaining([
      'reliefweb-disasters',
      'reliefweb-reports',
      'reliefweb-api-docs',
    ]));
  });

  it('returns a non-fatal unavailable context when no appName is configured', async () => {
    const context = await reliefWeb.collectHumanitarianContext({ onEvent: () => {} });

    expect(context.available).toBe(false);
    expect(context.appConfigured).toBe(false);
    expect(context.failures[0].source).toBe('reliefweb-config');
  });
});
