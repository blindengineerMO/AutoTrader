const cheerio = require('cheerio');
const {
  scoreText,
  extractLocalEventResearchQueries,
  buildSearchRequests,
  buildSearchFallbackRequests,
  buildMarketNewsSiteSearchRequests,
  CURATED_MARKET_NEWS_SITES,
  buildDuckDuckGoResultRequests,
  extractDuckDuckGoResultLinks,
  extractLinks,
  selectPageSubLinks,
  classifyArticleEventCategories,
  resetSearchRoundRobin,
  nextRoundRobinProviders,
  isRateLimited,
  nextFallbackProvider,
  recordSearchProviderResult,
  getSearchProviderHealthSnapshot,
  scoreSearchProviderHealth,
  sortProvidersByHealth,
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

  it('keeps slow DuckDuckGo and hostile Yandex pages out of the direct Crawlee search frontier', () => {
    resetSearchRoundRobin();
    const requests = buildSearchRequests('AI chip market news');
    const types = requests.map((request) => request.userData.type);

    expect(types).toEqual(['google-search', 'google-news-rss']);
    expect(requests.some((request) => request.url.includes('duckduckgo.com'))).toBe(false);
    expect(requests.some((request) => request.url.includes('yandex.com'))).toBe(false);
  });

  it('rotates the starting provider round-robin across consecutive queries', () => {
    resetSearchRoundRobin();
    const first = buildSearchRequests('query one').map((request) => request.userData.searchProvider);
    const second = buildSearchRequests('query two').map((request) => request.userData.searchProvider);

    expect(first[0]).toBe('google');
    expect(second[0]).not.toBe('google');
  });

  it('weights provider rotation away from recently unhealthy providers', () => {
    resetSearchRoundRobin();
    const now = Date.now();
    recordSearchProviderResult('google', 'rate-limit', now);
    recordSearchProviderResult('google', 'failure', now + 100);
    recordSearchProviderResult('bing', 'success', now + 200);
    recordSearchProviderResult('mojeek', 'success', now + 300);

    const selected = nextRoundRobinProviders(2);
    const health = getSearchProviderHealthSnapshot(now + 400);

    expect(selected).toEqual(expect.arrayContaining(['bing', 'mojeek']));
    expect(selected).not.toContain('google');
    expect(health.find((provider) => provider.provider === 'google')).toMatchObject({
      cooldownMs: expect.any(Number),
      lastOutcome: 'failure',
    });
    expect(scoreSearchProviderHealth('google', now + 400)).toBeLessThan(scoreSearchProviderHealth('bing', now + 400));
  });

  it('orders fallback candidates by provider health without dropping exploration candidates', () => {
    resetSearchRoundRobin();
    const now = Date.now();
    recordSearchProviderResult('bing', 'rate-limit', now);
    recordSearchProviderResult('mojeek', 'success', now + 100);

    expect(sortProvidersByHealth(['bing', 'mojeek', 'dogpile'])[0]).toBe('mojeek');
    expect(nextFallbackProvider({ searchProvider: 'google', attemptedSearchProviders: ['google'] })).toBe('mojeek');
  });

  it('includes Mojeek and Dogpile in the round-robin provider policy', () => {
    resetSearchRoundRobin();
    const requests = buildSearchRequests('public company product launch', { providerCount: 5 });

    expect(requests.map((request) => request.userData.searchProvider)).toEqual(expect.arrayContaining([
      'mojeek',
      'dogpile',
    ]));
    expect(requests.some((request) => request.url.includes('mojeek.com/search'))).toBe(true);
    expect(requests.some((request) => request.url.includes('dogpile.com/serp'))).toBe(true);
    expect(requests.some((request) => request.url.includes('yandex.com'))).toBe(false);
  });

  it('builds scraper-friendlier Mojeek and Dogpile fallback requests instead of Yandex', () => {
    const requests = buildSearchFallbackRequests([
      {
        userData: {
          query: 'defense contractor backlog',
          searchProvider: 'google',
          attemptedSearchProviders: ['google', 'bing', 'duckduckgo-html'],
        },
      },
    ]);
    const providers = requests.map((request) => request.userData.searchProvider);
    expect(providers).toEqual(expect.arrayContaining(['mojeek', 'dogpile']));
    expect(providers).not.toContain('yandex');
    expect(requests.find((request) => request.userData.searchProvider === 'mojeek').url).toContain('mojeek.com/search');
    expect(requests.find((request) => request.userData.searchProvider === 'dogpile').url).toContain('dogpile.com/serp');
  });

  it('detects a 429 error and names the next fallback provider', () => {
    expect(isRateLimited({ message: 'Request blocked with status code 429' })).toBe(true);
    expect(isRateLimited({ statusCode: 429 })).toBe(true);
    expect(isRateLimited({ message: 'ECONNRESET' })).toBe(false);
    expect(nextFallbackProvider({ searchProvider: 'google', attemptedSearchProviders: ['google'] })).toBe('bing');
  });

  it('queues Bing and DuckDuckGo fallback searches when Google fails after retries', () => {
    const events = [];
    const requests = buildSearchFallbackRequests([
      {
        url: 'https://www.google.com/search?q=semiconductor+earnings',
        error: 'request failed after 2 retries',
        userData: {
          query: 'semiconductor earnings',
          searchProvider: 'google',
          attemptedSearchProviders: ['google'],
        },
      },
    ], { onEvent: (event) => events.push(event) });

    expect(requests.map((request) => request.userData.searchProvider)).toEqual(expect.arrayContaining([
      'bing',
      'mojeek',
      'dogpile',
      'duckduckgo-html',
    ]));
    expect(requests.map((request) => request.userData.fallbackForProvider)).toEqual(expect.arrayContaining(['google']));
    expect(requests.some((request) => request.url.includes('bing.com/search'))).toBe(true);
    expect(requests.some((request) => request.url.includes('duckduckgo.com/html'))).toBe(true);
    expect(events[0]).toMatchObject({
      phase: 'crawlee-search-fallback',
      level: 'warn',
    });
  });

  it('does not requeue already-attempted search providers during fallback', () => {
    const requests = buildSearchFallbackRequests([
      {
        userData: {
          query: 'EV battery recall',
          searchProvider: 'google',
          attemptedSearchProviders: ['google', 'bing', 'duckduckgo-html', 'mojeek', 'dogpile'],
        },
      },
    ]);

    expect(requests.map((request) => request.userData.searchProvider)).toEqual(['google-news']);
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

  it('classifies an article into multiple relevant event categories, not just the first match', () => {
    const categories = classifyArticleEventCategories(
      'A missile attack has escalated the war, prompting new tariffs and export controls on affected suppliers.'
    );

    expect(categories).toContain('war or geopolitical conflict');
    expect(categories).toContain('sanctions or trade policy');
  });

  it('returns no categories for a routine, non-eventful article', () => {
    expect(classifyArticleEventCategories('Local bakery celebrates its tenth anniversary with a community bake sale.')).toEqual([]);
  });
});
