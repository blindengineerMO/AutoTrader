const finra = require('../src/services/finraMarketDataService');

const FINRA_HTML = `
<main>
  <h1>Corporate Bond Trade Activity</h1>
  <p>FINRA Fixed Income Data includes bond details, trade activity, and market statistics.</p>
  <table>
    <tr><th>Ticker</th><th>Issuer</th><th>CUSIP</th><th>Price</th><th>Yield</th><th>Spread</th><th>Trades</th><th>Volume</th><th>Rating</th><th>Date</th></tr>
    <tr>
      <td>ACME</td>
      <td>Acme Capital Corp</td>
      <td>123456AA1</td>
      <td>Price 82.50</td>
      <td>Yield 9.4%</td>
      <td>Spread 475 bps</td>
      <td>Trades 42</td>
      <td>Volume $5.2M</td>
      <td>Rating B+ Watch Negative</td>
      <td>2026-07-14</td>
    </tr>
    <tr>
      <td>SAFE</td>
      <td>Safe Utility Inc</td>
      <td>987654AA9</td>
      <td>Price 101.20</td>
      <td>Yield 4.1%</td>
      <td>Spread 95 bps</td>
      <td>Trades 4</td>
      <td>Volume $1.1M</td>
      <td>Rating A</td>
      <td>2026-07-14</td>
    </tr>
  </table>
</main>`;

describe('finraMarketDataService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses FINRA corporate bond trade rows and classifies credit stress', () => {
    const rows = finra.parseTradeRows(FINRA_HTML, {
      id: 'finra-corp-agency-trade-activity',
      url: finra.FINRA_CORP_AGENCY_TRADE_URL,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      symbol: 'ACME',
      issuer: 'Acme Capital Corp',
      cusip: '123456AA1',
      price: 82.5,
      yieldPct: 9.4,
      spreadBps: 475,
      tradeCount: 42,
      volume: 5200000,
      creditStance: 'stressed',
    });
    expect(rows[1]).toMatchObject({
      symbol: 'SAFE',
      creditStance: 'constructive',
    });
  });

  it('evaluates FINRA context and penalizes candidates with stressed bond signals', () => {
    const page = finra.parseFinraPage(FINRA_HTML, {
      id: 'finra-corp-agency-trade-activity',
      url: finra.FINRA_CORP_AGENCY_TRADE_URL,
    });
    const context = finra.evaluateFinraContext({ pages: [page] });

    expect(context.available).toBe(true);
    expect(context.tradeSignalCount).toBe(2);
    expect(context.creditStressScore).toBeGreaterThan(50);
    expect(context.topCreditWeakness[0].symbol).toBe('ACME');
    expect(context.sourceList.map((source) => source.url)).toContain('https://www.finra.org/finra-data/fixed-income/corp-and-agency/trade');

    const score = finra.scoreCandidate({
      candidate: { symbol: 'ACME', companyName: 'Acme Capital Corp', theme: 'capital intensive industrial' },
      finraContext: context,
    });
    expect(score.compositeScore).toBeLessThan(50);
    expect(score.signals[0].reason).toMatch(/spread 475/);
    expect(score.explanation).toMatch(/FINRA credit-market signals/);
  });

  it('collects FINRA sources and compacts snapshots for BMCL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => FINRA_HTML,
    });
    const events = [];
    const context = await finra.collectFinraMarketContext({
      sourceIds: ['finra-corp-agency-trade-activity'],
      limit: 1,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.tradeSignals).toHaveLength(1);
    expect(events.map((event) => event.phase)).toContain('finra-fixed-income');

    const compact = finra.compactForBmcl(context);
    expect(compact.provider).toBe('finra');
    expect(compact.topCreditWeakness).toHaveLength(1);
    expect(compact.bmclUse).toMatch(/FINRA fixed-income/);
  });
});
