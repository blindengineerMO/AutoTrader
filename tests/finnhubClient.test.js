// Exercise Finnhub's error mapping directly without the resilientFetch retry
// delays (retry/backoff itself is covered by resilientFetch.test.js).
process.env.HTTP_RETRY_MAX = '0';

const finnhubClient = require('../src/services/marketData/finnhubClient');

describe('finnhubClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('rejects when no API key is supplied and none is configured', async () => {
    await expect(finnhubClient.getQuote('AAPL', '')).rejects.toThrow(/FINNHUB_API_KEY is not configured/);
  });

  it('parses a successful quote response and derives changePct from current vs previous close', async () => {
    global.fetch = async (url) => {
      expect(String(url)).toContain('/quote');
      expect(String(url)).toContain('symbol=AAPL');
      expect(String(url)).toContain('token=test-key');
      return { ok: true, json: async () => ({ c: 110, h: 112, l: 108, o: 109, pc: 100 }) };
    };
    const quote = await finnhubClient.getQuote('AAPL', 'test-key');
    expect(quote).toEqual({ symbol: 'AAPL', current: 110, high: 112, low: 108, open: 109, prevClose: 100, changePct: 10 });
  });

  it('treats a zero previous close as zero changePct instead of dividing by zero', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ c: 50, h: 55, l: 45, o: 48, pc: 0 }) });
    const quote = await finnhubClient.getQuote('NEWLIST', 'test-key');
    expect(quote.changePct).toBe(0);
  });

  it('throws a descriptive error when Finnhub responds with a non-2xx status', async () => {
    global.fetch = async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'rate limited' });
    await expect(finnhubClient.getQuote('AAPL', 'test-key')).rejects.toThrow(/429/);
  });

  it('getQuotes skips symbols that individually fail and still returns the ones that succeed', async () => {
    global.fetch = async (url) => {
      if (String(url).includes('symbol=BADSYM')) {
        return { ok: false, status: 500, statusText: 'Server Error', text: async () => '' };
      }
      return { ok: true, json: async () => ({ c: 10, h: 11, l: 9, o: 10, pc: 10 }) };
    };
    const quotes = await finnhubClient.getQuotes(['GOOD', 'BADSYM', 'ALSOGOOD'], { apiKey: 'test-key' });
    expect(quotes.map((q) => q.symbol)).toEqual(['GOOD', 'ALSOGOOD']);
  });

  it('researchCompany returns an unavailable, error-free result when no API key is provided', async () => {
    const result = await finnhubClient.researchCompany('AAPL', {});
    expect(result.available).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('researchCompany records per-call errors while still returning data for calls that succeeded', async () => {
    global.fetch = async (url) => {
      if (String(url).includes('/stock/profile2')) {
        return { ok: false, status: 500, statusText: 'Server Error', text: async () => '' };
      }
      return { ok: true, json: async () => ({ c: 10, h: 11, l: 9, o: 10, pc: 10 }) };
    };
    const result = await finnhubClient.researchCompany('AAPL', { apiKey: 'test-key' });
    expect(result.available).toBe(true);
    expect(result.quote).toBeDefined();
    expect(result.errors.some((e) => e.key === 'profile')).toBe(true);
  });
});
