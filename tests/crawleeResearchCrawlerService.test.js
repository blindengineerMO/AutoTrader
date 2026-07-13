const cheerio = require('cheerio');
const {
  scoreText,
  extractLocalEventResearchQueries,
  buildSearchRequests,
  buildMarketNewsSiteSearchRequests,
  CURATED_MARKET_NEWS_SITES,
  buildDuckDuckGoResultRequests,
  extractDuckDuckGoResultLinks,
  extractLinks,
  selectPageSubLinks,
} = require('../src/services/crawleeResearchCrawlerService');

describe('crawleeResearchCrawlerService relevance scoring', () => {
  it('boosts company-specific weighted financial events above generic pages', () => {
    const weightedCompanySignal = scoreText(
      'NVDA NVIDIA raised guidance above consensus after revenue beat and margin expansion in earnings.'
    );
    const genericPage = scoreText('privacy policy contact preferences newsletter archive');

    expect(weightedCompanySignal).toBeGreaterThan(genericPage + 2);
  });

  it('spawns location-aware follow-up questions from local events and company leads', () => {
    const queries = extractLocalEventResearchQueries(
      {
        title: 'Florida hurricane threatens Walmart and Target retail demand',
        excerpt: 'A major hurricane in Florida may disrupt stores, customers, and distribution routes.',
      },
      [{ name: 'Walmart', symbol: 'WMT' }]
    );

    expect(queries).toEqual(expect.arrayContaining([
      expect.stringContaining('Will Florida area be affected by weather or natural disaster'),
      expect.stringContaining('Will Walmart customers offices retail locations in Florida be affected by weather or natural disaster'),
    ]));
  });

  it('keeps slow DuckDuckGo pages out of the direct Crawlee search frontier', () => {
    const requests = buildSearchRequests('AI chip market news');
    const types = requests.map((request) => request.userData.type);

    expect(types).toEqual(expect.arrayContaining([
      'google-search',
      'google-news-rss',
    ]));
    expect(requests.some((request) => request.url.includes('duckduckgo.com'))).toBe(false);
  });

  it('adds bounded market-news site searches for company announcements and products', () => {
    const requests = buildMarketNewsSiteSearchRequests(['new products market news'], { queryLimit: 1, siteLimit: 3 });
    const urls = requests.map((request) => decodeURIComponent(request.url).replace(/\+/g, ' '));

    expect(CURATED_MARKET_NEWS_SITES.map((site) => site.domain)).toEqual(expect.arrayContaining([
      'bloomberg.com',
      'wsj.com',
      'reuters.com',
      'finance.yahoo.com',
      'cnbc.com',
      'marketwatch.com',
      'kiplinger.com',
      'investopedia.com',
      'economist.com',
      'forbes.com',
    ]));
    expect(requests).toHaveLength(3);
    expect(urls.some((url) => url.includes('site:bloomberg.com'))).toBe(true);
    expect(urls.some((url) => url.includes('company announcement new product earnings acquisition stock'))).toBe(true);
    expect(requests.map((request) => request.userData.type)).toEqual(expect.arrayContaining([
      'market-news-site-google-search',
    ]));
    expect(requests.some((request) => request.url.includes('duckduckgo.com'))).toBe(false);
  });

  it('preflights DuckDuckGo with a short fetch and returns result URLs for Crawlee', async () => {
    const html = `
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fmarkets%2Fatt-offices">
        AT&amp;T corporate offices expansion
      </a>
    `;
    const requests = await buildDuckDuckGoResultRequests(['Where does T have corporate offices'], {
      fetchImpl: async () => ({ ok: true, text: async () => html }),
      timeoutMs: 25,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: 'https://example.com/markets/att-offices',
      userData: {
        type: 'duckduckgo-result',
        sourceSearch: 'duckduckgo',
      },
    });
  });

  it('detects DuckDuckGo result links without keeping DuckDuckGo redirect URLs', () => {
    const html = `
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fmarkets%2Fnvda%3Futm_source%3Dddg">
        Nvidia earnings revenue guidance
      </a>
    `;
    const links = extractDuckDuckGoResultLinks(html, 'https://duckduckgo.com/html/?q=nvda');

    expect(links[0]).toMatchObject({
      url: 'https://example.com/markets/nvda',
      title: 'Nvidia earnings revenue guidance',
    });
  });

  it('unwraps DuckDuckGo result redirects into target hyperlinks', () => {
    const html = `
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fmarkets%2Fnvda%3Futm_source%3Dddg">
        Nvidia earnings revenue guidance
      </a>
    `;
    const links = extractLinks(cheerio.load(html), 'https://duckduckgo.com/html/?q=nvda');

    expect(links[0]).toMatchObject({
      url: 'https://example.com/markets/nvda',
      text: 'Nvidia earnings revenue guidance',
    });
  });

  it('selects scored sub-links for deeper autonomous follow-up within depth limits', () => {
    const page = {
      url: 'https://example.com/business/ai-market',
      userData: { depth: 1 },
      score: { relevance: 8, weightedFinancialEvents: { aggregateScore: 3 } },
      links: [
        { url: 'https://example.com/business/nvidia-earnings-contract', text: 'Nvidia earnings contract revenue guidance' },
        { url: 'https://example.com/privacy', text: 'Privacy policy' },
      ],
    };

    const selected = selectPageSubLinks({ page, maxSubLinksPerPage: 4, maxDepth: 5 });

    expect(selected[0]).toMatchObject({
      url: 'https://example.com/business/nvidia-earnings-contract',
      discoveryMethod: 'sub-link-follow-up',
      depth: 2,
    });
    expect(selected.some((link) => link.url.includes('/privacy'))).toBe(false);
  });
});
