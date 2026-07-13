const { config } = require('../config');
const chatResearchService = require('./chatResearchService');
const researchQueryCatalogService = require('./researchQueryCatalogService');
const { classifyArticleEventCategories } = require('./crawleeResearchCrawlerService');

const CATEGORY_DIMENSION_KEYWORDS = {
  'war or geopolitical conflict': ['industry', 'macro', 'government_contracts', 'competitive'],
  'sanctions or trade policy': ['macro', 'industry', 'government_contracts'],
  'regulatory or legal action': ['legal', 'regulatory', 'accounting'],
  'supply chain or labor disruption': ['customer_and_supplier', 'supply_chain'],
  'mergers and acquisitions': ['acquisitions', 'merger'],
  'macro or rate policy shift': ['macroeconomic', 'macro'],
  'weather or natural disaster': ['weather', 'commodity'],
  'housing or real estate shift': ['housing'],
  'crime or retail theft': ['customer_and_supplier'],
};

function selectQueryTemplatesForCategories(categories) {
  const dimensions = new Set();
  for (const category of categories) {
    for (const keyword of CATEGORY_DIMENSION_KEYWORDS[category] || []) {
      for (const dimension of researchQueryCatalogService.findDimensionsByKeyword(keyword)) {
        dimensions.add(dimension);
      }
    }
  }
  const templates = [];
  for (const dimension of dimensions) {
    templates.push(...researchQueryCatalogService.getQueryTemplatesForDimension(dimension));
    if (templates.length >= 12) break;
  }
  return templates.slice(0, 12);
}

function articleText(article) {
  return `${article?.title || ''} ${article?.excerpt || article?.text || ''}`;
}

async function comprehendArticles({ userId, articles = [], onEvent = () => {} } = {}) {
  if (!config.articleLlmComprehensionEnabled) {
    return { inferredCompanies: [], followUpQueries: [] };
  }

  const maxPerRun = config.articleLlmComprehensionMaxPerRun;
  const matched = [];
  for (const article of articles) {
    const eventCategories = classifyArticleEventCategories(articleText(article));
    if (eventCategories.length === 0) continue;
    matched.push({ article, eventCategories });
    if (matched.length >= maxPerRun) break;
  }

  if (matched.length === 0) {
    return { inferredCompanies: [], followUpQueries: [] };
  }

  const settled = await Promise.allSettled(
    matched.map(({ article, eventCategories }) =>
      chatResearchService.runArticleComprehension({
        userId,
        article,
        eventCategories,
        queryTemplates: selectQueryTemplatesForCategories(eventCategories),
        onEvent,
      })
    )
  );

  const inferredCompanies = [];
  const followUpQueries = [];
  const seenCompanyKeys = new Set();
  const seenQueries = new Set();

  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue;
    for (const company of outcome.value.inferredCompanies) {
      const key = (company.symbol || company.name).toLowerCase();
      if (seenCompanyKeys.has(key)) continue;
      seenCompanyKeys.add(key);
      inferredCompanies.push(company);
    }
    for (const query of outcome.value.followUpQueries) {
      const key = query.toLowerCase();
      if (seenQueries.has(key)) continue;
      seenQueries.add(key);
      followUpQueries.push(query);
    }
  }

  return { inferredCompanies, followUpQueries };
}

module.exports = {
  comprehendArticles,
  selectQueryTemplatesForCategories,
};
