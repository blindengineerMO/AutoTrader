const marketBeat = require('../src/services/marketBeatAnalystService');

const MARKETBEAT_HTML = `
<html>
  <body>
    <table>
      <tr><th>Ticker</th><th>Firm</th><th>Action</th><th>Rating</th><th>Target</th><th>Date</th></tr>
      <tr>
        <td><a href="/stocks/NASDAQ/MBUY/forecast/">MBUY</a></td>
        <td>Example Capital</td>
        <td>upgraded</td>
        <td>Hold to Buy</td>
        <td>$21.00 to $27.50</td>
        <td>2026-07-14</td>
      </tr>
      <tr>
        <td><a href="https://www.marketbeat.com/stocks/NYSE/MSLL/forecast/">MSLL</a></td>
        <td>Risk Desk</td>
        <td>downgraded</td>
        <td>Buy to Sell</td>
        <td>$44.00 to $35.00</td>
        <td>Jul 13, 2026</td>
      </tr>
    </table>
  </body>
</html>`;

describe('marketBeatAnalystService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses MarketBeat analyst recommendation rows from public pages', () => {
    const rows = marketBeat.parseAnalystRows(MARKETBEAT_HTML, {
      id: 'upgrades',
      label: 'Analyst Upgrades',
      url: 'https://www.marketbeat.com/ratings/upgrades/',
      stance: 'bullish',
      weight: 0.78,
      category: 'broker-upgrades',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      symbol: 'MBUY',
      exchange: 'NASDAQ',
      analystFirm: 'Example Capital',
      action: 'upgrade',
      previousRating: 'Hold',
      newRating: 'Buy',
      previousTarget: 21,
      newTarget: 27.5,
      publishedAt: '2026-07-14',
      screenId: 'upgrades',
      stance: 'bullish',
    });
    expect(rows[0].quoteUrl).toBe('https://www.marketbeat.com/stocks/NASDAQ/MBUY/forecast/');
  });

  it('evaluates context and scores candidates using broker actions and consensus pages', () => {
    const upgradeRows = marketBeat.parseAnalystRows(MARKETBEAT_HTML, {
      id: 'upgrades',
      label: 'Analyst Upgrades',
      url: 'https://www.marketbeat.com/ratings/upgrades/',
      stance: 'bullish',
      weight: 0.78,
      category: 'broker-upgrades',
    });
    const context = marketBeat.evaluateMarketBeatContext({
      screenResults: [{ screen: { id: 'upgrades' }, rows: upgradeRows }],
      consensusPages: [{
        symbol: 'MBUY',
        pageType: 'consensus-forecast',
        label: 'Consensus Forecast',
        url: 'https://www.marketbeat.com/stocks/NASDAQ/MBUY/forecast/',
        snippet: 'Consensus rating Buy with rising price target.',
      }],
    });

    expect(context.available).toBe(true);
    expect(context.signalCount).toBe(2);
    expect(context.bullishCount).toBeGreaterThan(0);
    expect(context.targetChangeCount).toBe(2);
    expect(context.sourceList.map((source) => source.url)).toContain('https://www.marketbeat.com/ratings/price-target-changes/');

    const score = marketBeat.scoreCandidate({ candidate: { symbol: 'MBUY' }, marketBeatContext: context });
    expect(score.compositeScore).toBeGreaterThan(50);
    expect(score.signals.map((signal) => signal.action)).toContain('upgrade');
    expect(score.consensusPages[0].pageType).toBe('consensus-forecast');
    expect(score.explanation).toMatch(/Verify scraped MarketBeat output/);
  });

  it('collects configured MarketBeat screens and compacts snapshots for BMCL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => MARKETBEAT_HTML,
    });
    const events = [];
    const context = await marketBeat.collectMarketBeatAnalystContext({
      screenIds: ['upgrades'],
      limit: 1,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.records).toHaveLength(1);
    expect(events.map((event) => event.phase)).toContain('marketbeat-analyst-research');

    const compact = marketBeat.compactForBmcl(context);
    expect(compact.provider).toBe('marketbeat');
    expect(compact.topPositive).toHaveLength(1);
    expect(compact.bmclUse).toMatch(/MarketBeat analyst/);
  });
});
