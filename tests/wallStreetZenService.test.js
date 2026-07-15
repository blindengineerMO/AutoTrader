const wallStreetZen = require('../src/services/wallStreetZenService');

const SCREENER_HTML = `
<html>
  <body>
    <table>
      <tr><th>Ticker</th><th>Company</th><th>Exchange</th><th>Industry</th><th>Zen Rating</th><th>Market Cap</th><th>Price</th><th>1d %</th><th>EBITDA</th><th>P/E</th><th>D/E</th><th>Country</th></tr>
      <tr>
        <td><a href="/stocks/us/nasdaq/zena">ZENA</a></td>
        <td>ZEN ALPHA INC</td>
        <td>NASDAQ</td>
        <td>Software - Infrastructure</td>
        <td>A Strong Buy</td>
        <td>$3.20B</td>
        <td>$12.40</td>
        <td>4.20%</td>
        <td>$180.00M</td>
        <td>24.50x</td>
        <td>0.42</td>
        <td>United States</td>
      </tr>
      <tr>
        <td><a href="https://www.wallstreetzen.com/stocks/us/nyse/zenf">ZENF</a></td>
        <td>ZEN FALLING CO</td>
        <td>NYSE</td>
        <td>Retail</td>
        <td>F Strong Sell</td>
        <td>$900.00M</td>
        <td>$8.10</td>
        <td>-2.40%</td>
        <td>$40.00M</td>
        <td>92.00x</td>
        <td>4.80</td>
        <td>United States</td>
      </tr>
    </table>
  </body>
</html>`;

const TICKER_HTML = `
<main>
  <h1>ZENA Stock</h1>
  <section>
    <h2>Zen Rating</h2>
    <h3>Our proven quant model uses 115 proprietary factors</h3>
    <p>A Strong Buy</p>
    <h3>Zen Rating Component Grades</h3>
    <p>A Value</p>
    <p>B Growth</p>
    <p>A Momentum</p>
    <p>B Sentiment</p>
    <p>A Safety</p>
    <p>B Financials</p>
    <p>A Artificial Intelligence</p>
    <p>Industry : Software Infrastructure Industry Rating A</p>
  </section>
  <section>
    <p>Market Cap $3.20B</p>
    <p>Fair Value Price $18.50</p>
    <p>P/E 24.50</p>
    <p>PEG 0.92</p>
    <p>Profit Margin 18.4%</p>
    <p>Debt to Equity 0.42</p>
  </section>
</main>`;

describe('wallStreetZenService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses WallStreetZen screener rows from public stock links', () => {
    const rows = wallStreetZen.parseMarketRows(SCREENER_HTML, {
      id: 'stock-screener',
      label: 'Stock Screener',
      url: wallStreetZen.WALLSTREETZEN_STOCK_SCREENER_URL,
      stance: 'attention',
      weight: 0.68,
      category: 'quant-screener',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      symbol: 'ZENA',
      exchange: 'NASDAQ',
      companyName: 'ZEN ALPHA INC',
      zenRating: 'A',
      recommendation: 'Strong Buy',
      stance: 'bullish',
      price: 12.4,
      changePct: 4.2,
      pe: 24.5,
    });
    expect(rows[0].quoteUrl).toBe('https://www.wallstreetzen.com/stocks/us/nasdaq/zena');
    expect(rows[1]).toMatchObject({
      symbol: 'ZENF',
      stance: 'bearish',
      zenRating: 'F',
    });
  });

  it('evaluates WallStreetZen context and scores candidates with ticker summaries', () => {
    const rows = wallStreetZen.parseMarketRows(SCREENER_HTML, {
      id: 'stock-screener',
      label: 'Stock Screener',
      url: wallStreetZen.WALLSTREETZEN_STOCK_SCREENER_URL,
      stance: 'attention',
      weight: 0.68,
      category: 'quant-screener',
    });
    const tickerPage = wallStreetZen.parseTickerPage(TICKER_HTML, {
      symbol: 'ZENA',
      exchange: 'NASDAQ',
      url: wallStreetZen.tickerUrl('ZENA', 'NASDAQ'),
    });
    const context = wallStreetZen.evaluateWallStreetZenContext({
      screenResults: [{ screen: { id: 'stock-screener' }, rows }],
      tickerPages: [tickerPage],
    });

    expect(context.available).toBe(true);
    expect(context.signalCount).toBe(2);
    expect(context.ratedCount).toBe(2);
    expect(context.tickerPageCount).toBe(1);
    expect(context.sourceList.map((source) => source.url)).toContain('https://www.wallstreetzen.com/stock-screener');

    const score = wallStreetZen.scoreCandidate({ candidate: { symbol: 'ZENA' }, wallStreetZenContext: context });
    expect(score.compositeScore).toBeGreaterThan(50);
    expect(score.signals[0].zenRating).toBe('A');
    expect(score.tickerPages[0].componentGrades).toMatchObject({ value: 'A', growth: 'B' });
    expect(score.explanation).toMatch(/Verify scraped WallStreetZen ratings/);
  });

  it('collects configured WallStreetZen screens and compacts snapshots for BMCL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SCREENER_HTML,
    });
    const events = [];
    const context = await wallStreetZen.collectWallStreetZenContext({
      screenIds: ['stock-screener'],
      limit: 1,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.records).toHaveLength(1);
    expect(events.map((event) => event.phase)).toContain('wallstreetzen-research');

    const compact = wallStreetZen.compactForBmcl(context);
    expect(compact.provider).toBe('wallstreetzen');
    expect(compact.topRated).toHaveLength(1);
    expect(compact.bmclUse).toMatch(/WallStreetZen quantitative-rating/);
  });
});
