const consumerGoodsIndustry = require('../src/services/consumerGoodsIndustryService');

const INDUSTRY_HTML = `
<html>
  <body>
    <table>
      <thead>
        <tr><th>#</th><th>Company</th><th>Symbol</th><th>Market Cap</th><th>Revenue</th><th>Profit</th><th>P/E</th><th>Dividend</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>1</td>
          <td><a href="/stocks/pg/">Procter & Gamble</a></td>
          <td>PG</td>
          <td>$410.5B</td>
          <td>$84.0B</td>
          <td>$15.1B</td>
          <td>26.4</td>
          <td>2.3%</td>
        </tr>
        <tr>
          <td>2</td>
          <td><a href="/stocks/cl/">Colgate-Palmolive</a></td>
          <td>CL</td>
          <td>$75.2B</td>
          <td>$19.5B</td>
          <td>$2.4B</td>
          <td>24.1</td>
          <td>2.1%</td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`;

describe('consumerGoodsIndustryService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses consumer-goods industry rows with visible market metrics', () => {
    const rows = consumerGoodsIndustry.parseIndustryRows(INDUSTRY_HTML, {
      id: 'stockanalysis-household-personal-products',
      label: 'Stock Analysis Household and Personal Products Industry',
      url: 'https://stockanalysis.com/stocks/industry/household-and-personal-products/',
      provider: 'stockanalysis',
      focus: 'household-personal-products',
      metricMode: 'industry-fundamentals',
      weight: 0.88,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rank: 1,
      symbol: 'PG',
      companyName: 'Procter & Gamble',
      provider: 'stockanalysis',
      focus: 'household-personal-products',
      marketCapRaw: '$410.5B',
      revenueRaw: '$84.0B',
      profitRaw: '$15.1B',
      dividendYield: 2.3,
    });
    expect(rows[0].companyUrl).toBe('https://stockanalysis.com/stocks/pg/');
    expect(rows[0].signalScore).toBeGreaterThan(60);
  });

  it('evaluates, compacts, and scores candidate exposure for BMCL use', () => {
    const rows = consumerGoodsIndustry.parseIndustryRows(INDUSTRY_HTML, {
      id: 'stockanalysis-household-personal-products',
      label: 'Stock Analysis Household and Personal Products Industry',
      url: 'https://stockanalysis.com/stocks/industry/household-and-personal-products/',
      provider: 'stockanalysis',
      focus: 'household-personal-products',
      metricMode: 'industry-fundamentals',
      weight: 0.88,
    });
    const context = consumerGoodsIndustry.evaluateConsumerGoodsIndustryContext({
      sourceResults: [{ source: { id: 'stockanalysis-household-personal-products' }, rows }],
    });

    expect(context.available).toBe(true);
    expect(context.signalCount).toBe(2);
    expect(context.householdPersonalProductsCount).toBe(2);
    expect(context.caveat).toMatch(/scraped public-page discovery/i);

    const candidateScore = consumerGoodsIndustry.scoreCandidate({
      candidate: { symbol: 'PG', companyName: 'Procter & Gamble' },
      consumerGoodsContext: context,
    });
    expect(candidateScore.compositeScore).toBeGreaterThan(50);
    expect(candidateScore.signals[0]).toMatchObject({ symbol: 'PG' });

    const compact = consumerGoodsIndustry.compactForBmcl(context);
    expect(compact.provider).toBe('consumer-goods-industry');
    expect(compact.topCompanies[0]).toMatchObject({ symbol: 'PG' });
    expect(compact.bmclUse).toMatch(/household\/personal-products/);
    expect(compact.caveat).toMatch(/not primary filings/i);
  });

  it('collects selected sources and records failures without stopping the snapshot', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: !String(url).includes('fortune'),
      text: async () => String(url).includes('fortune') ? '' : INDUSTRY_HTML,
    }));
    const events = [];
    const context = await consumerGoodsIndustry.collectConsumerGoodsIndustryContext({
      sourceIds: ['stockanalysis-household-personal-products', 'fortune-500'],
      limit: 1,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.records).toHaveLength(1);
    expect(context.failures[0]).toMatchObject({ source: 'fortune-500' });
    expect(events.map((event) => event.phase)).toContain('consumer-goods-industry');
  });
});
