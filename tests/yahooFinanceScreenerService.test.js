const yahooFinance = require('../src/services/yahooFinanceScreenerService');

const MARKET_HTML = `
<html>
  <body>
    <table>
      <tr><th>Symbol</th><th>Name</th><th>Price</th><th>Change</th><th>Change %</th><th>Volume</th><th>Market Cap</th></tr>
      <tr>
        <td><a href="/quote/YHOO/">YHOO</a></td>
        <td><a href="/quote/YHOO/">Yahoo Signal Corp</a></td>
        <td>18.50</td><td>+1.42</td><td>8.31%</td><td>2.4M</td><td>1.2B</td>
      </tr>
      <tr>
        <td><a href="https://finance.yahoo.com/quote/ALLY/">ALLY</a></td>
        <td><a href="/quote/ALLY/">Ally Test Holdings</a></td>
        <td>44.10</td><td>-0.82</td><td>-1.90%</td><td>900K</td><td>8.4B</td>
      </tr>
    </table>
  </body>
</html>`;

describe('yahooFinanceScreenerService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses Yahoo Finance quote rows from public screener pages', () => {
    const rows = yahooFinance.parseMarketRows(MARKET_HTML, {
      id: 'gainers',
      label: 'Stock Gainers',
      url: 'https://finance.yahoo.com/markets/stocks/gainers/',
      stance: 'bullish',
      weight: 0.84,
      category: 'market-movers',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      symbol: 'YHOO',
      companyName: 'Yahoo Signal Corp',
      price: 18.5,
      changePct: 8.31,
      volumeRaw: '2.4M',
      marketCapRaw: '1.2B',
      screenId: 'gainers',
      stance: 'bullish',
    });
    expect(rows[0].quoteUrl).toBe('https://finance.yahoo.com/quote/YHOO/');
  });

  it('evaluates context and scores candidates using Yahoo screener signals', () => {
    const bullish = yahooFinance.parseMarketRows(MARKET_HTML, {
      id: 'gainers',
      label: 'Stock Gainers',
      url: 'https://finance.yahoo.com/markets/stocks/gainers/',
      stance: 'bullish',
      weight: 0.84,
    });
    const bearish = yahooFinance.parseMarketRows(MARKET_HTML, {
      id: 'losers',
      label: 'Stock Losers',
      url: 'https://finance.yahoo.com/markets/stocks/losers/',
      stance: 'bearish',
      weight: 0.84,
    });
    const context = yahooFinance.evaluateYahooFinanceContext({
      screenResults: [
        { screen: { id: 'gainers' }, rows: bullish },
        { screen: { id: 'losers' }, rows: bearish },
      ],
    });

    expect(context.available).toBe(true);
    expect(context.signalCount).toBe(4);
    expect(context.sourceList.map((source) => source.url)).toContain('https://finance.yahoo.com/research-hub/screener/analyst_ratings/');

    const score = yahooFinance.scoreCandidate({ candidate: { symbol: 'YHOO' }, yahooFinanceContext: context });
    expect(score.compositeScore).not.toBe(50);
    expect(score.signals.map((signal) => signal.signal)).toEqual(expect.arrayContaining(['Stock Gainers', 'Stock Losers']));
    expect(score.explanation).toMatch(/Verify scraped\/unsupported Yahoo Finance output/);
  });

  it('collects configured Yahoo screens and compacts snapshots for BMCL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => MARKET_HTML,
    });
    const events = [];
    const context = await yahooFinance.collectYahooFinanceScreenerContext({
      screenIds: ['gainers'],
      limit: 1,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.records).toHaveLength(1);
    expect(events.map((event) => event.phase)).toContain('yahoo-finance-screener');

    const compact = yahooFinance.compactForBmcl(context);
    expect(compact.provider).toBe('yahoo-finance');
    expect(compact.topGainers).toHaveLength(1);
    expect(compact.bmclUse).toMatch(/Yahoo Finance market-screener/);
  });
});
