const finviz = require('../src/services/finvizScreenerService');

const SAMPLE_HTML = `
<html>
  <body>
    <table class="screener_table">
      <tr>
        <th>No.</th><th>Ticker</th><th>Company</th><th>Sector</th><th>Industry</th><th>Country</th><th>Market Cap</th><th>P/E</th><th>Price</th><th>Change</th><th>Volume</th>
      </tr>
      <tr>
        <td>1</td><td><a href="quote.ashx?t=ABCD&p=d">ABCD</a></td><td>Alpha Beta Cloud</td><td>Technology</td><td>Software</td><td>USA</td><td>12.4B</td><td>24.8</td><td>18.50</td><td>12.40%</td><td>1.5M</td>
      </tr>
      <tr>
        <td>2</td><td><a href="/quote.ashx?t=EFGH&p=d">EFGH</a></td><td>Energy Future Grid</td><td>Utilities</td><td>Electric</td><td>USA</td><td>8.2B</td><td>18.1</td><td>44.10</td><td>-4.20%</td><td>800K</td>
      </tr>
    </table>
  </body>
</html>`;

describe('finvizScreenerService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses FINVIZ screener rows from ticker links and visible cells', () => {
    const rows = finviz.parseScreenerRows(SAMPLE_HTML, {
      id: 'top-gainers',
      label: 'Top Gainers',
      url: 'https://finviz.com/screener.ashx?v=111&s=ta_topgainers',
      stance: 'bullish',
      weight: 0.86,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      symbol: 'ABCD',
      companyName: 'Alpha Beta Cloud',
      sector: 'Technology',
      price: 18.5,
      changePct: 12.4,
      volume: 1500000,
      screenId: 'top-gainers',
      stance: 'bullish',
    });
    expect(rows[0].quoteUrl).toBe('https://finviz.com/quote.ashx?t=ABCD&p=d');
  });

  it('evaluates context and scores candidates using screener signals', () => {
    const bullish = finviz.parseScreenerRows(SAMPLE_HTML, {
      id: 'top-gainers',
      label: 'Top Gainers',
      url: 'https://finviz.com/screener.ashx?v=111&s=ta_topgainers',
      stance: 'bullish',
      weight: 0.86,
    });
    const bearish = finviz.parseScreenerRows(SAMPLE_HTML, {
      id: 'top-losers',
      label: 'Top Losers',
      url: 'https://finviz.com/screener.ashx?v=111&s=ta_toplosers',
      stance: 'bearish',
      weight: 0.84,
    });
    const context = finviz.evaluateFinvizContext({
      screenResults: [
        { screen: { id: 'top-gainers' }, rows: bullish },
        { screen: { id: 'top-losers' }, rows: bearish },
      ],
    });

    expect(context.available).toBe(true);
    expect(context.signalCount).toBe(4);
    expect(context.sourceList.map((source) => source.url)).toContain('https://finviz.com/screener.ashx?v=111&s=ta_unusualvolume');

    const score = finviz.scoreCandidate({ candidate: { symbol: 'ABCD' }, finvizContext: context });
    expect(score.compositeScore).not.toBe(50);
    expect(score.signals.map((signal) => signal.signal)).toEqual(expect.arrayContaining(['Top Gainers', 'Top Losers']));
    expect(score.explanation).toMatch(/verify delayed scraped screener output/);
  });

  it('collects configured screens and compacts snapshots for BMCL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_HTML,
    });
    const events = [];
    const context = await finviz.collectFinvizScreenerContext({
      presetIds: ['top-gainers'],
      includeFundamental: false,
      limit: 1,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.records).toHaveLength(1);
    expect(events.map((event) => event.phase)).toContain('finviz-screener');

    const compact = finviz.compactForBmcl(context);
    expect(compact.provider).toBe('finviz');
    expect(compact.topBullish).toHaveLength(1);
    expect(compact.bmclUse).toMatch(/broker quotes/);
  });
});
