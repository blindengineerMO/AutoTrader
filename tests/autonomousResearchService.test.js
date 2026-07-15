const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-autonomous-research-service.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const brainMesh = require('../src/services/brainMeshService');
const { NEWS_FEEDS, selectValuableArticles, scoreCandidates, listRecentWatcherSignals } = require('../src/services/autonomousResearchService');

function newUser() {
  return userRepo.createUser({
    email: `autonomous-research-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

function quote(symbol, current) {
  return {
    symbol,
    current,
    open: current,
    high: current * 1.01,
    low: current * 0.99,
    prevClose: current,
    changePct: 0,
  };
}

function reportWatcherSignal(userId, symbol, predictedAction, localAiScore) {
  brainMesh.tell({
    from: `agent.watcher.${symbol.toLowerCase()}`,
    to: 'agent.research.top-level',
    kind: 'event',
    op: 'watcher.research.reported',
    ctx: { userId },
    body: { symbol, predictedAction, localAiScore, priceAtResearch: 10, priceTier: 'standard', rationale: {}, theme: 'watcher' },
  });
}

describe('autonomousResearchService.NEWS_FEEDS', () => {
  it('includes market, discovery, regulatory, filing, and contract feeds', () => {
    expect(NEWS_FEEDS).toHaveLength(45);
  });

  it('has a well-formed name, region, and https url for every feed', () => {
    for (const feed of NEWS_FEEDS) {
      expect(typeof feed.name).toBe('string');
      expect(feed.name.length).toBeGreaterThan(0);
      expect(typeof feed.region).toBe('string');
      expect(feed.region.length).toBeGreaterThan(0);
      expect(feed.url).toMatch(/^https:\/\//);
    }
  });

  it('contains no duplicate feed URLs', () => {
    const urls = NEWS_FEEDS.map((feed) => feed.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('includes each curated market feed URL', () => {
    const expectedUrls = [
      'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',
      'https://feeds.content.dowjones.io/public/rss/mw_topstories',
      'https://feeds.content.dowjones.io/public/rss/mw_bulletins',
      'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines',
      'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114',
      'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910',
      'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362',
      'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768',
      'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000116',
      'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',
      'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness',
      'https://www.federalreserve.gov/feeds/press_all.xml',
      'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147',
    ];
    const urls = NEWS_FEEDS.map((feed) => feed.url);
    for (const expected of expectedUrls) {
      expect(urls).toContain(expected);
    }
  });

  it('includes Google News discovery and government regulatory feed URLs', () => {
    const expectedUrls = [
      'https://news.google.com/rss/search?q=business&hl=en-US&gl=US&ceid=US:en',
      'https://news.google.com/rss/search?q=%22new+company%22+OR+startup+OR+%22business+launch%22&hl=en-US&gl=US&ceid=US:en',
      'https://news.google.com/rss/search?q=startup+%22funding+round%22+when%3A7d&hl=en-US&gl=US&ceid=US:en',
      'https://news.google.com/rss/search?q=IPO+OR+%22filed+to+go+public%22+when%3A7d&hl=en-US&gl=US&ceid=US:en',
      'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en',
      'https://www.sec.gov/news/pressreleases.rss',
      'https://www.sec.gov/news/speeches-statements.rss',
      'https://www.sec.gov/enforcement-litigation/litigation-releases/rss',
      'https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss',
      'https://www.sec.gov/enforcement-litigation/trading-suspensions/rss',
      'https://www.sec.gov/Archives/edgar/usgaap.rss.xml',
      'https://www.sec.gov/Archives/edgar/xbrl-rr.rss.xml',
      'https://www.sec.gov/Archives/edgar/xbrl-inline.rss.xml',
      'https://www.sec.gov/Archives/edgar/xbrlrss.all.xml',
      'https://www.ftc.gov/feeds/press-release.xml',
      'https://www.justice.gov/feeds/justice-news.xml',
      'https://www.consumerfinance.gov/about-us/blog/feed/',
      'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml',
      'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&Category=549&max=20',
    ];
    const urls = NEWS_FEEDS.map((feed) => feed.url);
    for (const expected of expectedUrls) {
      expect(urls).toContain(expected);
    }
  });

  it('includes issuer-paid press release discovery feeds for company events', () => {
    const expectedUrls = [
      'https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies',
      'https://www.globenewswire.com/RssFeed/subjectcode/13-Earnings%20Releases%20And%20Operating%20Results/feedTitle/GlobeNewswire%20-%20Earnings%20Releases%20And%20Operating%20Results',
      'https://www.globenewswire.com/RssFeed/subjectcode/27-Mergers%20And%20Acquisitions/feedTitle/GlobeNewswire%20-%20Mergers%20And%20Acquisitions',
      'https://www.globenewswire.com/RssFeed/subjectcode/9-Company%20Announcement/feedTitle/GlobeNewswire%20-%20Company%20Announcement',
      'https://www.globenewswire.com/RssFeed/subjectcode/21-Initial%20Public%20Offerings/feedTitle/GlobeNewswire%20-%20Initial%20Public%20Offerings',
      'https://www.globenewswire.com/RssFeed/subjectcode/29-Partnerships/feedTitle/GlobeNewswire%20-%20Partnerships',
      'https://www.globenewswire.com/RssFeed/subjectcode/32-Product%202f%20Services%20Announcement/feedTitle/GlobeNewswire%20-%20Product%20%2C%20Services%20Announcement',
      'https://www.globenewswire.com/RssFeed/subjectcode/86-Management%20Changes/feedTitle/GlobeNewswire%20-%20Management%20Changes',
      'https://www.prnewswire.com/rss/news-releases-list.rss',
    ];
    const urls = NEWS_FEEDS.map((feed) => feed.url);
    for (const expected of expectedUrls) {
      expect(urls).toContain(expected);
    }
  });
});

describe('selectValuableArticles', () => {
  it('ranks articles mentioning theme terms and sentiment language above generic ones, and drops links without a URL', () => {
    const newsItems = [
      { title: 'NVIDIA AI chip demand surges on datacenter growth', description: 'Strong revenue beat expected.', link: 'https://example.com/nvda' },
      { title: 'Local weather forecast for the weekend', description: 'Sunny skies expected all day.', link: 'https://example.com/weather' },
      { title: 'Fed inflation warning as recession risk grows', description: 'Rates may rise further.', link: 'https://example.com/fed' },
      { title: 'No link article about oil and gas', description: 'Crude prices surge.', link: '' },
    ];

    const selected = selectValuableArticles(newsItems, { maxArticles: 6 });

    expect(selected.every((article) => Boolean(article.link))).toBe(true);
    expect(selected.some((article) => article.link === 'https://example.com/weather')).toBe(false);
    expect(selected[0].link).not.toBe('https://example.com/weather');
    expect(selected.map((article) => article.link)).toEqual(
      expect.arrayContaining(['https://example.com/nvda', 'https://example.com/fed'])
    );
  });

  it('caps results at maxArticles', () => {
    const newsItems = Array.from({ length: 10 }, (_, i) => ({
      title: `AI chip semiconductor datacenter surge story ${i}`,
      description: 'Strong growth beat record rally.',
      link: `https://example.com/${i}`,
    }));

    expect(selectValuableArticles(newsItems, { maxArticles: 3 })).toHaveLength(3);
  });

  it('returns an empty array when nothing scores above zero', () => {
    const newsItems = [{ title: 'Recipe for pasta', description: 'A tasty dinner idea.', link: 'https://example.com/pasta' }];

    expect(selectValuableArticles(newsItems)).toEqual([]);
  });
});

describe('watcher.research.reported feeding scoreCandidates', () => {
  function baseArgs(userId, candidates, quotes) {
    return {
      userId,
      candidates,
      quotes,
      news: { items: [] },
      macro: { riskBias: 'neutral' },
      consumer: { consumerBias: 'neutral' },
      learned: { observations: [] },
      companyIntel: { records: [] },
      jsonDatasets: [],
      onEvent: () => {},
    };
  }

  it('registers a watcher.research.reported handler on agent.research.top-level that buffers signals per user', () => {
    const userId = newUser();
    reportWatcherSignal(userId, 'NUDG', 'buy-candidate', 70);

    const signals = listRecentWatcherSignals(userId, 'NUDG');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ symbol: 'NUDG', predictedAction: 'buy-candidate' });
  });

  it('nudges localAiScore up when 2+ recent watcher reports were bullish on the same symbol', () => {
    const userId = newUser();
    reportWatcherSignal(userId, 'NUDG', 'buy-candidate', 70);
    reportWatcherSignal(userId, 'NUDG', 'buy-candidate', 72);

    const candidates = [{ symbol: 'NUDG', theme: 'watchlist', themeHits: 0 }];
    const quotes = [quote('NUDG', 50)];

    const [signal] = scoreCandidates(baseArgs(userId, candidates, quotes));
    expect(signal.localAiScore).toBeGreaterThan(signal.baseLocalAiScore);
  });

  it('nudges localAiScore down when 2+ recent watcher reports were bearish on the same symbol', () => {
    const userId = newUser();
    reportWatcherSignal(userId, 'NUDD', 'sell-or-avoid', 20);
    reportWatcherSignal(userId, 'NUDD', 'sell-or-avoid', 18);

    const candidates = [{ symbol: 'NUDD', theme: 'watchlist', themeHits: 0 }];
    const quotes = [quote('NUDD', 50)];

    const [signal] = scoreCandidates(baseArgs(userId, candidates, quotes));
    expect(signal.localAiScore).toBeLessThan(signal.baseLocalAiScore);
  });

  it('does not nudge the score with only a single matching watcher report', () => {
    const userId = newUser();
    reportWatcherSignal(userId, 'SOLO', 'buy-candidate', 70);

    const candidates = [{ symbol: 'SOLO', theme: 'watchlist', themeHits: 0 }];
    const quotes = [quote('SOLO', 50)];

    const [signal] = scoreCandidates(baseArgs(userId, candidates, quotes));
    expect(signal.localAiScore).toBe(signal.baseLocalAiScore);
  });

  it('keeps signals scoped per user and per symbol', () => {
    const userA = newUser();
    const userB = newUser();
    reportWatcherSignal(userA, 'SCOPE', 'buy-candidate', 70);
    reportWatcherSignal(userA, 'SCOPE', 'buy-candidate', 72);

    expect(listRecentWatcherSignals(userB, 'SCOPE')).toHaveLength(0);
    expect(listRecentWatcherSignals(userA, 'OTHER')).toHaveLength(0);
  });
});
