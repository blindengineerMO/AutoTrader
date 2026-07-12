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
});
