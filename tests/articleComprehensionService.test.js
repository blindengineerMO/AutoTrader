process.env.JWT_SECRET = 'test-secret';

const chatResearchService = require('../src/services/chatResearchService');
const { config } = require('../src/config');
const articleComprehensionService = require('../src/services/articleComprehensionService');

describe('articleComprehensionService.comprehendArticles', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    config.articleLlmComprehensionEnabled = true;
    config.articleLlmComprehensionMaxPerRun = 4;
  });

  it('calls the LLM only for articles matching an event category, and merges results', async () => {
    const spy = vi.spyOn(chatResearchService, 'runArticleComprehension').mockResolvedValue({
      provider: 'xai-grok',
      reasoning: 'War raises demand for military hardware.',
      inferredCompanies: [{ name: 'Lockheed Martin', symbol: 'LMT', reason: 'Defense contractor benefiting from conflict.' }],
      followUpQueries: ['"Lockheed Martin" defense contract award'],
    });

    const result = await articleComprehensionService.comprehendArticles({
      userId: 1,
      articles: [
        { title: 'War breaks out in the region', excerpt: 'A missile attack has escalated conflict tensions.', link: 'https://example.com/war' },
        { title: 'Local bakery wins award', excerpt: 'A small bakery celebrates its anniversary.', link: 'https://example.com/bakery' },
      ],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.inferredCompanies).toHaveLength(1);
    expect(result.inferredCompanies[0].symbol).toBe('LMT');
    expect(result.followUpQueries).toContain('"Lockheed Martin" defense contract award');
  });

  it('does not call the LLM when no article matches an event category', async () => {
    const spy = vi.spyOn(chatResearchService, 'runArticleComprehension').mockResolvedValue({
      provider: 'xai-grok',
      reasoning: '',
      inferredCompanies: [],
      followUpQueries: [],
    });

    const result = await articleComprehensionService.comprehendArticles({
      userId: 1,
      articles: [{ title: 'Local bakery wins award', excerpt: 'A small bakery celebrates its anniversary.', link: 'https://example.com/bakery' }],
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result).toEqual({ inferredCompanies: [], followUpQueries: [] });
  });

  it('caps the number of articles sent to the LLM at the configured per-run max', async () => {
    config.articleLlmComprehensionMaxPerRun = 1;
    const spy = vi.spyOn(chatResearchService, 'runArticleComprehension').mockResolvedValue({
      provider: 'xai-grok',
      reasoning: '',
      inferredCompanies: [],
      followUpQueries: [],
    });

    const warArticles = Array.from({ length: 3 }, (_, i) => ({
      title: `War escalates in region ${i}`,
      excerpt: 'A missile attack has escalated conflict tensions.',
      link: `https://example.com/war-${i}`,
    }));

    await articleComprehensionService.comprehendArticles({ userId: 1, articles: warArticles });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('short-circuits without calling the LLM when the feature flag is disabled', async () => {
    config.articleLlmComprehensionEnabled = false;
    const spy = vi.spyOn(chatResearchService, 'runArticleComprehension').mockResolvedValue({
      provider: 'xai-grok',
      reasoning: '',
      inferredCompanies: [],
      followUpQueries: [],
    });

    const result = await articleComprehensionService.comprehendArticles({
      userId: 1,
      articles: [{ title: 'War escalates', excerpt: 'A missile attack has escalated conflict tensions.', link: 'https://example.com/war' }],
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result).toEqual({ inferredCompanies: [], followUpQueries: [] });
  });

  it('dedupes inferred companies and follow-up queries returned across multiple matched articles', async () => {
    const spy = vi.spyOn(chatResearchService, 'runArticleComprehension').mockResolvedValue({
      provider: 'xai-grok',
      reasoning: 'War raises demand for military hardware.',
      inferredCompanies: [{ name: 'Lockheed Martin', symbol: 'LMT', reason: 'Defense contractor.' }],
      followUpQueries: ['"Lockheed Martin" defense contract award'],
    });

    const result = await articleComprehensionService.comprehendArticles({
      userId: 1,
      articles: [
        { title: 'War escalates in region A', excerpt: 'A missile attack has escalated conflict tensions.', link: 'https://example.com/war-a' },
        { title: 'War escalates in region B', excerpt: 'A missile attack has escalated conflict tensions.', link: 'https://example.com/war-b' },
      ],
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.inferredCompanies).toHaveLength(1);
    expect(result.followUpQueries).toHaveLength(1);
  });
});
