const walmartRetailDemand = require('../src/services/walmartRetailDemandService');

const WALMART_HTML = `
<html>
  <body>
    <div data-item-id="12345">
      <span>#1</span>
      <a href="/ip/FreshClean-Microfiber-Sponges/12345">
        <span data-automation-id="product-title">FreshClean Microfiber Sponges, 12 Count</span>
      </a>
      <span>$4.98</span>
      <span>$0.42/count</span>
      <span>4.6 out of 5 stars</span>
      <span>2,345 reviews</span>
      <span>1K+ bought since yesterday</span>
      <span>Best seller</span>
      <span>Low stock</span>
    </div>
    <div data-us-item-id="67890">
      <span>#2</span>
      <a href="/ip/HomeGlow-Storage-Bins/67890">
        <span data-testid="product-title">HomeGlow Stackable Storage Bins, 6 Pack</span>
      </a>
      <span>$19.97</span>
      <span>4.3 out of 5 stars</span>
      <span>786 ratings</span>
      <span>500+ bought since yesterday</span>
      <span>Available for pickup and delivery</span>
    </div>
  </body>
</html>`;

describe('walmartRetailDemandService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses Walmart storefront demand, availability, and review metadata', () => {
    const rows = walmartRetailDemand.parseProductRows(WALMART_HTML, {
      id: 'cleaning-sponges-bestsellers',
      label: 'Walmart Cleaning Sponges Best Sellers',
      url: 'https://www.walmart.com/c/best-sellers/household-cleaning-sponges',
      category: 'cleaning-sponges',
      sourceType: 'bestseller-rank',
      weight: 0.82,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rank: 1,
      productId: '12345',
      title: 'FreshClean Microfiber Sponges, 12 Count',
      category: 'cleaning-sponges',
      price: 4.98,
      unitPrice: '$0.42/count',
      rating: 4.6,
      reviewCount: 2345,
      boughtSinceYesterday: 1000,
      availability: 'low-stock',
      lowStock: true,
      bestsellerLabel: true,
    });
    expect(rows[0].productUrl).toBe('https://www.walmart.com/ip/FreshClean-Microfiber-Sponges/12345');
  });

  it('evaluates Walmart product-demand context and compacts it for BMCL', () => {
    const bestsellers = walmartRetailDemand.parseProductRows(WALMART_HTML, {
      id: 'household-supply-bestsellers',
      label: 'Walmart Household Supply Best Sellers',
      url: 'https://www.walmart.com/c/best-sellers/household-supplies',
      category: 'household-supplies',
      sourceType: 'bestseller-rank',
      weight: 0.82,
    });
    const trending = walmartRetailDemand.parseProductRows(WALMART_HTML, {
      id: 'top-100-home-trending',
      label: 'Walmart Top 100 Trending Home Products',
      url: 'https://www.walmart.com/shop/top-100-home-trending',
      category: 'home',
      sourceType: 'trending-rank',
      weight: 0.86,
    });
    const context = walmartRetailDemand.evaluateWalmartRetailDemandContext({
      sourceResults: [
        { source: { id: 'household-supply-bestsellers' }, rows: bestsellers },
        { source: { id: 'top-100-home-trending' }, rows: trending },
      ],
    });

    expect(context.available).toBe(true);
    expect(context.signalCount).toBe(4);
    expect(context.lowStockProducts[0]).toMatchObject({
      productId: '12345',
      lowStock: true,
    });
    expect(context.caveat).toMatch(/not audited sales figures/i);

    const compact = walmartRetailDemand.compactForBmcl(context);
    expect(compact.provider).toBe('walmart-retail-demand');
    expect(compact.trendingProducts.length).toBeGreaterThan(0);
    expect(compact.lowStockProducts[0].title).toMatch(/Microfiber Sponges/);
    expect(compact.bmclUse).toMatch(/bought-since-yesterday/);
  });

  it('collects selected pages and records source failures', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: !String(url).includes('top-100-home-trending'),
      text: async () => String(url).includes('top-100-home-trending') ? '' : WALMART_HTML,
    }));
    const events = [];
    const context = await walmartRetailDemand.collectWalmartRetailDemandContext({
      sourceIds: ['household-supply-bestsellers', 'top-100-home-trending'],
      limit: 1,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.records).toHaveLength(1);
    expect(context.failures[0]).toMatchObject({ source: 'top-100-home-trending' });
    expect(events.map((event) => event.phase)).toContain('walmart-retail-demand');
  });
});
