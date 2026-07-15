const nasdaq = require('../src/services/nasdaqMarketResearchService');

const MARKET_HTML = `
<html>
  <body>
    <table>
      <tr><th>Symbol</th><th>Name</th><th>Price</th><th>Change %</th><th>Volume</th><th>Market Cap</th></tr>
      <tr>
        <td><a href="/market-activity/stocks/nqai">NQAI</a></td>
        <td><a href="/market-activity/stocks/nqai">Nasdaq AI Systems</a></td>
        <td>$18.50</td><td>8.31%</td><td>2.4M</td><td>1.2B USD</td>
      </tr>
      <tr>
        <td><a href="https://www.nasdaq.com/market-activity/stocks/hold/institutional-holdings">HOLD</a></td>
        <td><a href="/market-activity/stocks/hold">Holdings Test Corp</a></td>
        <td>$44.10</td><td>-1.90%</td><td>900K</td><td>8.4B USD</td>
      </tr>
    </table>
  </body>
</html>`;

describe('nasdaqMarketResearchService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses Nasdaq market activity stock links from public pages', () => {
    const rows = nasdaq.parseMarketRows(MARKET_HTML, {
      id: 'earnings-calendar',
      label: 'Earnings Calendar',
      url: 'https://www.nasdaq.com/market-activity/earnings',
      stance: 'attention',
      weight: 0.66,
      category: 'earnings-catalyst',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      symbol: 'NQAI',
      companyName: 'Nasdaq AI Systems',
      price: 18.5,
      changePct: 8.31,
      volumeRaw: '2.4M',
      marketCapRaw: '1.2BUSD',
      screenId: 'earnings-calendar',
      stance: 'attention',
    });
    expect(rows[0].quoteUrl).toBe('https://www.nasdaq.com/market-activity/stocks/nqai');
  });

  it('evaluates context and scores candidates using Nasdaq catalysts and company pages', () => {
    const earningsRows = nasdaq.parseMarketRows(MARKET_HTML, {
      id: 'earnings-calendar',
      label: 'Earnings Calendar',
      url: 'https://www.nasdaq.com/market-activity/earnings',
      stance: 'attention',
      weight: 0.66,
      category: 'earnings-catalyst',
    });
    const context = nasdaq.evaluateNasdaqContext({
      screenResults: [{ screen: { id: 'earnings-calendar' }, rows: earningsRows }],
      companyPages: [{
        symbol: 'NQAI',
        pageType: 'institutional-holdings',
        label: 'Institutional Holdings',
        focus: 'institutional ownership',
        url: 'https://www.nasdaq.com/market-activity/stocks/nqai/institutional-holdings',
        snippet: 'Top institutional holders increased ownership.',
      }],
    });

    expect(context.available).toBe(true);
    expect(context.signalCount).toBe(2);
    expect(context.earningsCatalystCount).toBe(2);
    expect(context.companyPageCount).toBe(1);
    expect(context.sourceList.map((source) => source.url)).toContain('https://www.nasdaq.com/market-activity/ipos');

    const score = nasdaq.scoreCandidate({ candidate: { symbol: 'NQAI' }, nasdaqContext: context });
    expect(score.compositeScore).not.toBe(50);
    expect(score.signals.map((signal) => signal.signal)).toContain('Earnings Calendar');
    expect(score.companyPages[0].pageType).toBe('institutional-holdings');
    expect(score.explanation).toMatch(/Verify scraped Nasdaq public-page output/);
  });

  it('collects configured Nasdaq screens and compacts snapshots for BMCL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => MARKET_HTML,
    });
    const events = [];
    const context = await nasdaq.collectNasdaqMarketResearchContext({
      screenIds: ['earnings-calendar'],
      limit: 1,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.records).toHaveLength(1);
    expect(events.map((event) => event.phase)).toContain('nasdaq-market-research');

    const compact = nasdaq.compactForBmcl(context);
    expect(compact.provider).toBe('nasdaq');
    expect(compact.earningsCatalysts).toHaveLength(1);
    expect(compact.bmclUse).toMatch(/Nasdaq market research/);
  });
});
