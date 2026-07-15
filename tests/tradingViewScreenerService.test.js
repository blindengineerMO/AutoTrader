const tradingView = require('../src/services/tradingViewScreenerService');

const MARKET_HTML = `
<html>
  <body>
    <table>
      <tr>
        <th>Symbol</th><th>Name</th><th>Pre-mkt chg %</th><th>Pre-mkt price</th><th>Pre-mkt vol</th><th>Mkt cap</th>
      </tr>
      <tr>
        <td><a href="/symbols/NASDAQ-VEEE/">VEEE</a></td>
        <td><a href="/symbols/NASDAQ-VEEE/">Twin Vee PowerCats Co.</a></td>
        <td>18.45%</td><td>2.14 USD</td><td>1.8M</td><td>12.4M USD</td>
      </tr>
      <tr>
        <td><a href="/symbols/NASDAQ-QTTB/">QTTB</a></td>
        <td><a href="/symbols/NASDAQ-QTTB/">Q32 Bio Inc.</a></td>
        <td>7.10%</td><td>8.22 USD</td><td>720K</td><td>94.1M USD</td>
      </tr>
    </table>
  </body>
</html>`;

const SECTOR_HTML = `
<html>
  <body>
    <table>
      <tr><th>Sector</th><th>Market cap</th><th>Dividend yield</th><th>Change %</th><th>Volume</th><th>Industries</th><th>Stocks</th></tr>
      <tr>
        <td><a href="/markets/stocks-usa/sectorandindustry-sector/electronic-technology/">Electronic Technology</a></td>
        <td>24.3T USD</td><td>0.54%</td><td>2.21%</td><td>5.8B</td><td>12</td><td>814</td>
      </tr>
      <tr>
        <td><a href="/markets/stocks-usa/sectorandindustry-sector/finance/">Finance</a></td>
        <td>10.1T USD</td><td>1.91%</td><td>-0.30%</td><td>2.2B</td><td>14</td><td>932</td>
      </tr>
    </table>
  </body>
</html>`;

describe('tradingViewScreenerService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses TradingView symbol rows from public market pages', () => {
    const rows = tradingView.parseMarketRows(MARKET_HTML, {
      id: 'pre-market-gainers',
      label: 'Pre-market Gainers',
      url: 'https://www.tradingview.com/markets/stocks-usa/market-movers-pre-market-gainers/',
      stance: 'bullish',
      weight: 0.82,
      category: 'pre-market-momentum',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      symbol: 'VEEE',
      exchange: 'NASDAQ',
      companyName: 'Twin Vee PowerCats Co.',
      price: 2.14,
      changePct: 18.45,
      volumeRaw: '1.8M',
      marketCapRaw: '12.4M USD',
      screenId: 'pre-market-gainers',
      stance: 'bullish',
    });
    expect(rows[0].quoteUrl).toBe('https://www.tradingview.com/symbols/NASDAQ-VEEE/');
  });

  it('parses TradingView sector rows and scores context/candidates', () => {
    const rows = tradingView.parseMarketRows(MARKET_HTML, {
      id: 'all-time-highs',
      label: 'All-time Highs',
      url: 'https://www.tradingview.com/markets/stocks-usa/market-movers-ath/',
      stance: 'bullish',
      weight: 0.78,
      category: 'relative-strength',
    });
    const sectors = tradingView.parseSectorRows(SECTOR_HTML);
    const context = tradingView.evaluateTradingViewContext({
      screenResults: [{ screen: { id: 'all-time-highs' }, rows }],
      sectors,
    });

    expect(context.available).toBe(true);
    expect(context.signalCount).toBe(2);
    expect(context.sectorLeaders[0].name).toBe('Electronic Technology');
    expect(context.sourceList.map((source) => source.url)).toContain('https://www.tradingview.com/screener/');

    const score = tradingView.scoreCandidate({
      candidate: { symbol: 'VEEE', companyName: 'Twin Vee PowerCats Co.', theme: 'electronic technology momentum' },
      tradingViewContext: context,
    });
    expect(score.compositeScore).toBeGreaterThan(50);
    expect(score.signals.map((signal) => signal.signal)).toContain('All-time Highs');
    expect(score.sectorSignals.map((sector) => sector.name)).toContain('Electronic Technology');
  });

  it('collects configured TradingView screens and compacts snapshots for BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation((url) => Promise.resolve({
      ok: true,
      text: async () => String(url).includes('sectorandindustry-sector') ? SECTOR_HTML : MARKET_HTML,
    }));
    const events = [];
    const context = await tradingView.collectTradingViewScreenerContext({
      screenIds: ['pre-market-gainers'],
      limit: 1,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.records).toHaveLength(1);
    expect(context.sectorLeaders).toHaveLength(1);
    expect(events.map((event) => event.phase)).toContain('tradingview-screener');

    const compact = tradingView.compactForBmcl(context);
    expect(compact.provider).toBe('tradingview');
    expect(compact.topPreMarketGainers).toHaveLength(1);
    expect(compact.sectorLeaders).toHaveLength(1);
    expect(compact.bmclUse).toMatch(/pre-market movement/);
  });
});
