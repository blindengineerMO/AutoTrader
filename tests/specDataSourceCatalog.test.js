const {
  SPEC_DATA_SOURCE_CATALOG,
  SPEC_IMPLEMENTATION_NOTE,
  toResearchSeedSources,
} = require('../src/services/spec/specDataSourceCatalog');
const sourceLearning = require('../src/services/researchSourceLearningService');

describe('specDataSourceCatalog', () => {
  it('defines official SPEC source classes for PIT filings, macro, benchmarks, universe, and text research', () => {
    const ids = SPEC_DATA_SOURCE_CATALOG.map((source) => source.id);
    expect(ids).toEqual(expect.arrayContaining([
      'sec-edgar-submissions',
      'sec-data-api',
      'nasdaq-symbol-directory',
      'bls-api',
      'bea-api',
      'fred-alfred-api',
      'treasury-fiscaldata-api',
      'census-economic-indicators',
      'census-business-formation-statistics',
      'census-business-dynamics-statistics',
      'eia-open-data',
      'fama-french-data-library',
      'gdelt-global-news-events',
      'gdelt-doc-api',
      'google-news-rss-discovery',
      'sec-rss-directory',
      'sec-structured-disclosure-rss-feeds',
      'ftc-press-release-feed',
      'doj-justice-news-feed',
      'federal-reserve-press-feed',
      'cfpb-newsroom-feed',
      'fda-press-announcements',
      'defense-contracts-daily',
      'noaa-nws-api',
      'openfema-api',
      'usaspending-api',
      'clinicaltrials-api-v2',
      'openfda-api',
      'reliefweb-api',
      'nhtsa-recalls-api',
      'openalex-api',
    ]));
    expect(new Set(SPEC_DATA_SOURCE_CATALOG.map((source) => source.url)).size).toBe(SPEC_DATA_SOURCE_CATALOG.length);
    expect(SPEC_IMPLEMENTATION_NOTE).toMatch(/Do not invent APIs/);
  });

  it('converts SPEC sources into research seeds with required-field notes', () => {
    const seeds = toResearchSeedSources();
    const secSeed = seeds.find((seed) => seed.url.includes('sec.gov'));
    expect(secSeed.tags).toContain('spec');
    expect(secSeed.notes).toMatch(/Required SPEC fields/);
    expect(sourceLearning.SEED_SOURCES.some((source) => source.url === secSeed.url)).toBe(true);
    expect(sourceLearning.SEED_SOURCES.map((source) => source.url)).toEqual(expect.arrayContaining([
      'https://www.bloomberg.com/',
      'https://www.wsj.com/',
      'https://www.reuters.com/business/finance/',
      'https://finance.yahoo.com/',
      'https://www.cnbc.com/',
      'https://www.marketwatch.com/',
      'https://www.kiplinger.com/',
      'https://www.investopedia.com/',
      'https://www.economist.com/',
      'https://www.forbes.com/',
      'https://news.google.com/rss/search?q=business&hl=en-US&gl=US&ceid=US:en',
      'https://www.sec.gov/about/rss-feeds',
      'https://www.sec.gov/data-research/structured-data/structured-disclosure-rss-feeds',
      'https://www.ftc.gov/feeds/press-release.xml',
      'https://www.justice.gov/feeds/justice-news.xml',
      'https://www.federalreserve.gov/feeds/press_all.xml',
      'https://www.consumerfinance.gov/about-us/blog/feed/',
      'https://www.fda.gov/news-events/fda-newsroom/press-announcements',
      'https://www.defense.gov/News/Contracts/',
    ]));
    expect(sourceLearning.scoreText('SEC EDGAR XBRL filing acceptance timestamp companyfacts benchmark')).toBeGreaterThan(3);
    expect(sourceLearning.scoreText('GDELT weather disaster clinical trial openFDA federal contract recall local risk')).toBeGreaterThan(6);
    expect(sourceLearning.scoreText('SEC RSS trading suspension FTC DOJ antitrust FDA approval defense contract catalyst')).toBeGreaterThan(6);
  });
});
