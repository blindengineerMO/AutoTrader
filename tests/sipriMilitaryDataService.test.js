const sipriMilitaryData = require('../src/services/sipriMilitaryDataService');

const PAGE_FIXTURES = {
  'https://www.sipri.org/databases': `
    <main><h1>SIPRI Databases</h1>
      <p>The SIPRI Arms Transfers Database is a publicly available source on international transfers of major conventional arms.</p>
      <p>The Arms Industry Database contains the Top 100 arms-producing and military services companies.</p>
      <p>The Multilateral Peace Operations Database includes personnel, country contributions, fatalities and budgets.</p>
      <p>The Military Expenditure Database gives annual military spending.</p>
      <p>Other resources include arms embargoes and nuclear forces.</p>
    </main>`,
  'https://www.sipri.org/databases/milex': `
    <main><h1>Military Expenditure Database</h1>
      <p>Consistent time series on military spending from 1949 to 2025 in local currency, current and constant US dollars, share of GDP, per-capita terms, and government expenditure share.</p>
    </main>`,
  'https://www.sipri.org/databases/armstransfers': `
    <main><h1>Arms Transfers Database</h1>
      <p>Transfers of major conventional arms from 1950 through the latest full calendar year.</p>
    </main>`,
  'https://www.sipri.org/databases/armstransfers/sources-and-methods': `
    <main><h1>Sources and methods</h1>
      <p>The Trend Indicator Value, or TIV, is a volume measure and does not represent sales prices or the financial value of a transfer.</p>
    </main>`,
  'https://www.sipri.org/databases/armsindustry': `
    <main><h1>Arms Industry Database</h1>
      <p>Financial data for arms-producing and military services companies, including the Top 100, is based on open sources and company annual reports.</p>
    </main>`,
  'https://www.sipri.org/databases/financial-value-global-arms-trade': `
    <main><h1>Financial value of the global arms trade</h1>
      <p>Official national arms export reports use terms such as exports, licences, agreements and orders, with methodology limitations.</p>
    </main>`,
  'https://www.sipri.org/databases/embargoes': `
    <main><h1>Arms embargoes</h1>
      <p>Arms embargoes provide regulatory risk and country restriction context.</p>
    </main>`,
};

describe('sipriMilitaryDataService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collects SIPRI dataset metadata and keeps measure distinctions explicit for BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => PAGE_FIXTURES[String(url)] || PAGE_FIXTURES['https://www.sipri.org/databases'],
    }));
    const events = [];

    const context = await sipriMilitaryData.collectSipriMilitaryContext({
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.datasetCount).toBeGreaterThanOrEqual(7);
    expect(context.datasets.map((dataset) => dataset.id)).toEqual(expect.arrayContaining([
      'military_expenditure',
      'arms_transfers',
      'arms_company_revenue',
      'financial_value_arms_trade',
    ]));
    expect(context.measureDistinctions.arms_transfers).toMatch(/volume indicator, not a transaction price/i);
    expect(context.analysisRules.join(' ')).toMatch(/Never treat SIPRI TIV as dollars/i);
    expect(events.map((event) => event.phase)).toContain('sipri-defense-data');

    const compact = sipriMilitaryData.compactForBmcl(context);
    expect(compact).toMatchObject({
      provider: 'sipri',
      available: true,
    });
    expect(compact.datasets.find((dataset) => dataset.id === 'arms_transfers')).toMatchObject({
      measureType: 'arms-transfer-volume',
    });
    expect(compact.bmclUse).toMatch(/measure-specific/);
    expect(compact.caveat).toMatch(/do not interchange TIV, spending, company revenue, and contract award values/i);
  });
});
