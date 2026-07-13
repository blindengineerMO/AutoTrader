process.env.SEC_EDGAR_USER_AGENT = 'AutoTrader test test@example.com';

const secEdgarClient = require('../src/services/marketData/secEdgarClient');

const TICKERS_RESPONSE = {
  0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  1: { cik_str: 789019, ticker: 'MSFT', title: 'Microsoft Corporation' },
};

const COMPANY_FACTS_RESPONSE = {
  facts: {
    'us-gaap': {
      Revenues: {
        units: {
          USD: [
            { end: '2025-09-30', val: 400000000000, filed: '2025-11-01', form: '10-K' },
            { end: '2024-09-30', val: 380000000000, filed: '2024-11-01', form: '10-K' },
          ],
        },
      },
      NetIncomeLoss: {
        units: {
          USD: [{ end: '2025-09-30', val: 90000000000, filed: '2025-11-01', form: '10-K' }],
        },
      },
      StockholdersEquity: {
        units: {
          USD: [{ end: '2025-09-30', val: 60000000000, filed: '2025-11-01', form: '10-K' }],
        },
      },
      EarningsPerShareDiluted: {
        units: {
          'USD/shares': [{ end: '2025-09-30', val: 6.5, filed: '2025-11-01', form: '10-K' }],
        },
      },
    },
  },
};

const SUBMISSIONS_RESPONSE = {
  cik: '0000320193',
  entityType: 'operating',
  sic: '3571',
  sicDescription: 'Electronic Computers',
  name: 'Apple Inc.',
  tickers: ['AAPL'],
  exchanges: ['Nasdaq'],
  fiscalYearEnd: '0928',
  stateOfIncorporation: 'CA',
  flags: '',
  formerNames: [{ name: 'APPLE COMPUTER INC', from: '1994-01-01', to: '2007-01-09' }],
  filings: {
    recent: {
      accessionNumber: ['0000320193-26-000001', '0000320193-25-000099', '0000320193-25-000080'],
      filingDate: ['2026-01-30', '2025-11-01', '2025-08-01'],
      reportDate: ['2025-12-31', '2025-09-30', '2025-06-30'],
      acceptanceDateTime: ['20260130170000', '20251101170000', '20250801170000'],
      act: ['34', '34', '34'],
      form: ['10-Q', '10-K', '8-K'],
      fileNumber: ['001-36743', '001-36743', '001-36743'],
      filmNumber: ['26123456', '25123456', '25111111'],
      items: ['', '', '2.02'],
      size: [12345, 23456, 3456],
      isXBRL: [1, 1, 0],
      isInlineXBRL: [1, 1, 0],
      primaryDocument: ['aapl-20251231.htm', 'aapl-20250930.htm', 'aapl-20250801.htm'],
      primaryDocDescription: ['10-Q', '10-K', '8-K'],
    },
    files: [{ name: 'CIK0000320193-submissions-001.json', filingFrom: '1994-01-26', filingTo: '2024-01-01' }],
  },
};

describe('secEdgarClient', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).includes('company_tickers.json')) {
          return { ok: true, status: 200, json: async () => TICKERS_RESPONSE };
        }
        if (String(url).includes('companyfacts')) {
          return { ok: true, status: 200, json: async () => COMPANY_FACTS_RESPONSE };
        }
        if (String(url).includes('/submissions/CIK0000320193.json')) {
          return { ok: true, status: 200, json: async () => SUBMISSIONS_RESPONSE };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when SEC_EDGAR_USER_AGENT is unset rather than sending an anonymous request', async () => {
    const previous = process.env.SEC_EDGAR_USER_AGENT;
    delete process.env.SEC_EDGAR_USER_AGENT;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/services/marketData/secEdgarClient')];
    const freshClient = require('../src/services/marketData/secEdgarClient');
    await expect(freshClient.getCompanyTickers({ force: true })).rejects.toThrow(/SEC_EDGAR_USER_AGENT/);
    process.env.SEC_EDGAR_USER_AGENT = previous;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/services/marketData/secEdgarClient')];
  });

  it('maps a ticker to a zero-padded CIK', async () => {
    const identity = await secEdgarClient.getCik('AAPL');
    expect(identity.cik).toBe('0000320193');
    expect(identity.title).toBe('Apple Inc.');
  });

  it('returns null for a symbol with no CIK mapping', async () => {
    const identity = await secEdgarClient.getCik('NOPE');
    expect(identity).toBeNull();
  });

  it('picks the most recently filed fact for a concept, not the most recent period end', () => {
    const fact = secEdgarClient.pickLatestFact(COMPANY_FACTS_RESPONSE, 'Revenues');
    expect(fact.filed).toBe('2025-11-01');
    expect(fact.val).toBe(400000000000);
  });

  it('builds point-in-time fundamentals with a filing-based availableAt', async () => {
    const fundamentals = await secEdgarClient.getFundamentalFacts('AAPL');
    expect(fundamentals.cik).toBe('0000320193');
    expect(fundamentals.facts.Revenues.value).toBe(400000000000);
    expect(fundamentals.availableAt).toBe(new Date('2025-11-01').toISOString());
  });

  it('loads and summarizes SEC company submission history by ticker', async () => {
    const summary = await secEdgarClient.getSubmissionSummary('AAPL');

    expect(summary.cik).toBe('0000320193');
    expect(summary.companyName).toBe('Apple Inc.');
    expect(summary.latestFiling.form).toBe('10-Q');
    expect(summary.latestAnnual.form).toBe('10-K');
    expect(summary.latestMaterialEvent.form).toBe('8-K');
    expect(summary.formCounts).toMatchObject({ '10-Q': 1, '10-K': 1, '8-K': 1 });
    expect(summary.source.url).toBe('https://data.sec.gov/submissions/CIK0000320193.json');
    expect(summary.source.tickerDirectoryUrl).toBe('https://www.sec.gov/files/company_tickers.json');
    expect(summary.recentFilings[0].filingUrl).toContain('/Archives/edgar/data/320193/000032019326000001/aapl-20251231.htm');
  });

  it('pads CIKs when loading raw SEC company submissions', async () => {
    await secEdgarClient.getCompanySubmissions(320193);

    expect(fetch).toHaveBeenCalledWith(
      'https://data.sec.gov/submissions/CIK0000320193.json',
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) })
    );
  });
});
