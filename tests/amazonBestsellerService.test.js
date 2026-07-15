const amazonBestsellers = require('../src/services/amazonBestsellerService');

const BESTSELLER_HTML = `
<html>
  <body>
    <div id="gridItemRoot" data-asin="B0AAAA1111">
      <span class="zg-bdg-text">#1</span>
      <a href="/dp/B0AAAA1111/ref=zg_bs_home">
        <span class="_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">SparkleHome Microfiber Cleaning Cloths, 24 Pack</span>
      </a>
      <span>$12.99</span>
      <span>4.7 out of 5 stars</span>
      <span>12,345 ratings</span>
    </div>
    <div id="gridItemRoot" data-asin="B0BBBB2222">
      <span class="zg-bdg-text">#2</span>
      <a href="/dp/B0BBBB2222"><img alt="KitchenPro Silicone Spatula Set"/></a>
      <span>$9.49</span>
      <span>4.5 out of 5 stars</span>
      <span>876 reviews</span>
    </div>
  </body>
</html>`;

const MOVERS_HTML = `
<html>
  <body>
    <div class="zg-grid-general-faceout" data-asin="B0CCCC3333">
      <span>#1</span>
      <a href="/dp/B0CCCC3333">FreshWave Laundry Detergent Sheets</a>
      <span>2,400% increase in sales rank</span>
      <span>$18.00</span>
    </div>
  </body>
</html>`;

describe('amazonBestsellerService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses Amazon bestseller rows from visible rank/product metadata', () => {
    const rows = amazonBestsellers.parseBestsellerRows(BESTSELLER_HTML, {
      id: 'home-kitchen',
      label: 'Home and Kitchen Best Sellers',
      url: 'https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden',
      category: 'home-kitchen',
      sourceType: 'bestseller-rank',
      weight: 0.78,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rank: 1,
      asin: 'B0AAAA1111',
      title: 'SparkleHome Microfiber Cleaning Cloths, 24 Pack',
      category: 'home-kitchen',
      price: 12.99,
      rating: 4.7,
      reviewCount: 12345,
    });
    expect(rows[0].productUrl).toBe('https://www.amazon.com/dp/B0AAAA1111/ref=zg_bs_home');
  });

  it('evaluates product-rank context and compacts it for BMCL', () => {
    const rows = amazonBestsellers.parseBestsellerRows(BESTSELLER_HTML, {
      id: 'home-kitchen',
      label: 'Home and Kitchen Best Sellers',
      url: 'https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden',
      category: 'home-kitchen',
      sourceType: 'bestseller-rank',
      weight: 0.78,
    });
    const movers = amazonBestsellers.parseBestsellerRows(MOVERS_HTML, {
      id: 'movers-shakers',
      label: 'Amazon Movers and Shakers',
      url: 'https://www.amazon.com/gp/movers-and-shakers',
      category: 'all',
      sourceType: 'sales-rank-acceleration',
      weight: 0.9,
    });
    const context = amazonBestsellers.evaluateAmazonBestsellerContext({
      sourceResults: [
        { source: { id: 'home-kitchen' }, rows },
        { source: { id: 'movers-shakers' }, rows: movers },
      ],
    });

    expect(context.available).toBe(true);
    expect(context.signalCount).toBe(3);
    expect(context.fastestMovers[0]).toMatchObject({
      asin: 'B0CCCC3333',
      rankGainPct: 2400,
    });
    expect(context.caveat).toMatch(/not absolute sales volume/i);

    const compact = amazonBestsellers.compactForBmcl(context);
    expect(compact.provider).toBe('amazon-bestsellers');
    expect(compact.topProducts.length).toBeGreaterThan(0);
    expect(compact.fastestMovers[0].title).toMatch(/Laundry Detergent/);
    expect(compact.bmclUse).toMatch(/Census retail/);
  });

  it('collects selected pages and degrades failures into compact snapshots', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: !String(url).includes('movers-and-shakers'),
      text: async () => String(url).includes('movers-and-shakers') ? '' : BESTSELLER_HTML,
    }));
    const events = [];
    const context = await amazonBestsellers.collectAmazonBestsellerContext({
      sourceIds: ['home-kitchen', 'movers-shakers'],
      limit: 1,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.records).toHaveLength(1);
    expect(context.failures[0]).toMatchObject({ source: 'movers-shakers' });
    expect(events.map((event) => event.phase)).toContain('amazon-bestsellers');
  });
});
