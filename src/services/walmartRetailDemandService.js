const cheerio = require('cheerio');
const { resilientFetch } = require('../utils/resilientFetch');

const WALMART_HOME_URL = 'https://www.walmart.com/';

const WALMART_RETAIL_SOURCES = [
  {
    id: 'household-supply-bestsellers',
    label: 'Walmart Household Supply Best Sellers',
    url: 'https://www.walmart.com/c/best-sellers/household-supplies',
    category: 'household-supplies',
    sourceType: 'bestseller-rank',
    weight: 0.82,
  },
  {
    id: 'home-bestsellers',
    label: 'Walmart Home Best Sellers',
    url: 'https://www.walmart.com/shop/best-sellers/home',
    category: 'home',
    sourceType: 'bestseller-rank',
    weight: 0.78,
  },
  {
    id: 'top-100-home-trending',
    label: 'Walmart Top 100 Trending Home Products',
    url: 'https://www.walmart.com/shop/top-100-home-trending',
    category: 'home',
    sourceType: 'trending-rank',
    weight: 0.86,
  },
  {
    id: 'cleaning-supplies',
    label: 'Walmart Cleaning Supplies',
    url: 'https://www.walmart.com/browse/household-essentials/cleaning-supplies/1115193_1071966',
    category: 'cleaning-supplies',
    sourceType: 'category-demand',
    weight: 0.74,
  },
  {
    id: 'cleaning-sponges-bestsellers',
    label: 'Walmart Cleaning Sponges Best Sellers',
    url: 'https://www.walmart.com/c/best-sellers/household-cleaning-sponges',
    category: 'cleaning-sponges',
    sourceType: 'bestseller-rank',
    weight: 0.82,
  },
];

async function collectWalmartRetailDemandContext({
  timeoutMs = 9000,
  limit = 24,
  sourceIds,
  includeTrending = true,
  onEvent = () => {},
} = {}) {
  const selectedIds = new Set((Array.isArray(sourceIds) ? sourceIds : []).filter(Boolean));
  const selectedSources = WALMART_RETAIL_SOURCES
    .filter((source) => includeTrending || source.sourceType !== 'trending-rank')
    .filter((source) => !selectedIds.size || selectedIds.has(source.id) || selectedIds.has(source.category));
  const sources = selectedSources.length ? selectedSources : WALMART_RETAIL_SOURCES;
  const boundedLimit = clampInt(limit, 1, 100);

  const settled = await Promise.allSettled(sources.map(async (source) => {
    const html = await fetchHtml(source.url, timeoutMs);
    const rows = parseProductRows(html, source).slice(0, boundedLimit);
    emit(onEvent, 'walmart-retail-demand', 36, 'debug', 'Fetched Walmart retail demand source page.', {
      source: source.id,
      rows: rows.length,
      url: source.url,
    });
    return { source, rows };
  }));

  const sourceResults = [];
  const failures = [];
  settled.forEach((result, index) => {
    const source = sources[index];
    if (result.status === 'fulfilled') {
      sourceResults.push(result.value);
    } else {
      failures.push({ source: source.id, url: source.url, error: result.reason.message });
      emit(onEvent, 'walmart-retail-demand', 36, 'warn', 'Walmart retail demand page unavailable; continuing with remaining sources.', {
        source: source.id,
        url: source.url,
        error: result.reason.message,
      });
    }
  });

  return evaluateWalmartRetailDemandContext({ sourceResults, failures });
}

function parseProductRows(html, source = {}) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();
  const candidates = $('[data-item-id], [data-us-item-id], [data-testid*="item"], [data-testid*="product"], article, li, .mb0, .sans-serif').toArray();

  for (const node of candidates) {
    const $node = $(node);
    const text = cleanText($node.text());
    if (!text || !/(#\s*\d+|\$\s*\d|stars?|reviews?|ratings?|bought since yesterday|best\s*seller|trending|low stock|out of stock)/i.test(text)) continue;
    const link = findProductLink($, $node);
    const productId = cleanProductId(
      $node.attr('data-item-id')
      || $node.attr('data-us-item-id')
      || extractProductId(link.href)
    );
    const rank = extractRank(text) || rows.length + 1;
    const title = extractTitle($, $node, link.text);
    if (!title) continue;
    const key = `${source.id}:${productId || title.toLowerCase()}`;
    if (seen.has(key)) continue;

    const boughtSinceYesterday = extractBoughtSinceYesterday(text);
    const availability = extractAvailability(text);
    const lowStock = /low stock|only\s+\d+\s+left/i.test(text);
    const bestsellerLabel = /best\s*seller|bestseller/i.test(text);
    const trendingLabel = /trending|popular|top\s*100/i.test(text);
    const record = {
      rank,
      productId: productId || null,
      title,
      brandHint: inferBrandHint(title),
      category: source.category,
      sourceId: source.id,
      sourceLabel: source.label,
      sourceType: source.sourceType,
      price: extractPrice(text),
      unitPrice: extractUnitPrice(text),
      rating: extractRating(text),
      reviewCount: extractReviewCount(text),
      boughtSinceYesterday,
      availability,
      lowStock,
      bestsellerLabel,
      trendingLabel,
      productUrl: link.href ? absolutize(link.href) : null,
      sourceUrl: source.url,
      signalScore: scoreRecord({ rank, boughtSinceYesterday, lowStock, bestsellerLabel, trendingLabel, source }),
      rowText: text.slice(0, 700),
      caveat: 'Walmart storefront pages are scraped demand and availability proxies, not audited sales-volume, revenue, UPC scanner, or company financial data.',
    };
    rows.push(record);
    seen.add(key);
  }

  return rows
    .filter((row) => row.rank >= 1 && row.rank <= 200)
    .sort((a, b) => a.rank - b.rank || b.signalScore - a.signalScore);
}

function evaluateWalmartRetailDemandContext({ sourceResults = [], failures = [] } = {}) {
  const records = sourceResults.flatMap((result) => result.rows || []);
  const trending = records.filter((record) => record.sourceType === 'trending-rank' || record.trendingLabel || record.boughtSinceYesterday);
  const bestsellers = records.filter((record) => record.sourceType === 'bestseller-rank' || record.bestsellerLabel);
  const availabilitySignals = records.filter((record) => record.availability || record.lowStock);
  const lowStockSignals = records.filter((record) => record.lowStock);
  const categories = [...new Set(records.map((record) => record.category).filter(Boolean))];
  const productDemandScore = clampScore(average(records.map((record) => record.signalScore)));
  const trendAccelerationScore = clampScore(average(trending.map((record) => record.signalScore)));
  const availabilityPressureScore = clampScore(average(availabilitySignals.map((record) => record.lowStock ? record.signalScore + 4 : record.signalScore)));
  const demandBias = trendAccelerationScore >= 68 || productDemandScore >= 66 ? 'accelerating'
    : records.length ? 'visible-demand' : 'unavailable';

  return {
    available: records.length > 0,
    fetchedAt: new Date().toISOString(),
    provider: 'walmart-retail-demand',
    sourceList: sourceList(),
    failures,
    sourceCount: sourceResults.length,
    signalCount: records.length,
    categoryCount: categories.length,
    categories,
    productDemandScore,
    trendAccelerationScore,
    availabilityPressureScore,
    demandBias,
    records,
    topProducts: bestsellers.sort((a, b) => b.signalScore - a.signalScore || a.rank - b.rank).slice(0, 20),
    trendingProducts: trending.sort((a, b) => b.signalScore - a.signalScore || a.rank - b.rank).slice(0, 20),
    lowStockProducts: lowStockSignals.sort((a, b) => b.signalScore - a.signalScore || a.rank - b.rank).slice(0, 20),
    categorySummaries: summarizeCategories(records),
    caveat: 'Walmart bestseller, trending, and category pages are scraped consumer-storefront demand and availability proxies. They can expose relative product rank, visible price, ratings, review counts, “bought since yesterday” labels, availability, and low-stock pressure, but they are not audited sales figures, revenue, market share, UPC scanner data, or company-specific financial performance.',
    narrative: records.length
      ? `Walmart retail demand context ${demandBias}: ${records.length} product-demand signals across ${categories.length} categories. Product demand ${productDemandScore}, trend acceleration ${trendAccelerationScore}, availability pressure ${availabilityPressureScore}.`
      : 'Walmart retail demand context unavailable; pages may be blocked, throttled, region-specific, or changed.',
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'walmart-retail-demand',
    fetchedAt: context.fetchedAt,
    demandBias: context.demandBias,
    productDemandScore: context.productDemandScore,
    trendAccelerationScore: context.trendAccelerationScore,
    availabilityPressureScore: context.availabilityPressureScore,
    signalCount: context.signalCount || 0,
    categoryCount: context.categoryCount || 0,
    categories: context.categories || [],
    categorySummaries: context.categorySummaries || [],
    topProducts: (context.topProducts || []).slice(0, 10).map(compactRecord),
    trendingProducts: (context.trendingProducts || []).slice(0, 10).map(compactRecord),
    lowStockProducts: (context.lowStockProducts || []).slice(0, 10).map(compactRecord),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.caveat,
    bmclUse: 'Share as scraped Walmart bestseller, trending, category, price, rating/review, bought-since-yesterday, availability, and low-stock proxy evidence. Use compact product/category/rank snippets to spot consumer-demand themes, retail velocity hints, household/home/cleaning demand, ecommerce behavior, possible brand leads, and availability pressure, then corroborate with Census retail, scanner summaries, BLS/USDA data, company filings, independent news, broker/Finnhub data, and verified brand-to-company mappings before scoring or trading.',
  };
}

async function fetchHtml(url, timeoutMs = 9000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 AutoTrader Walmart retail demand research bot; contact=local',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers, redirect: 'follow' }, { bucket: 'walmart-retail-demand', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return WALMART_RETAIL_SOURCES.map((source) => ({
    name: source.label,
    type: source.sourceType,
    category: source.category,
    url: source.url,
  }));
}

function summarizeCategories(records) {
  const byCategory = new Map();
  for (const record of records) {
    const current = byCategory.get(record.category) || {
      category: record.category,
      signals: 0,
      averageRank: 0,
      averageScore: 0,
      boughtSinceYesterday: 0,
      lowStockSignals: 0,
      topTitles: [],
    };
    current.signals += 1;
    current.averageRank += record.rank;
    current.averageScore += record.signalScore;
    current.boughtSinceYesterday += record.boughtSinceYesterday || 0;
    current.lowStockSignals += record.lowStock ? 1 : 0;
    current.topTitles.push(record.title);
    byCategory.set(record.category, current);
  }
  return [...byCategory.values()].map((item) => ({
    ...item,
    averageRank: Number((item.averageRank / item.signals).toFixed(1)),
    averageScore: clampScore(item.averageScore / item.signals),
    topTitles: item.topTitles.slice(0, 5),
  })).sort((a, b) => b.averageScore - a.averageScore);
}

function compactRecord(record) {
  return {
    rank: record.rank,
    productId: record.productId,
    title: record.title,
    brandHint: record.brandHint,
    category: record.category,
    sourceLabel: record.sourceLabel,
    sourceType: record.sourceType,
    price: record.price,
    unitPrice: record.unitPrice,
    rating: record.rating,
    reviewCount: record.reviewCount,
    boughtSinceYesterday: record.boughtSinceYesterday,
    availability: record.availability,
    lowStock: record.lowStock,
    bestsellerLabel: record.bestsellerLabel,
    trendingLabel: record.trendingLabel,
    signalScore: record.signalScore,
    productUrl: record.productUrl,
    sourceUrl: record.sourceUrl,
  };
}

function findProductLink($, $node) {
  const anchors = $node.find('a[href]').toArray().map((anchor) => ({
    href: $(anchor).attr('href') || '',
    text: cleanText($(anchor).text()),
  }));
  return anchors.find((anchor) => /\/ip\//i.test(anchor.href))
    || anchors.find((anchor) => /\/(?:shop|browse)\//i.test(anchor.href) && anchor.text.length > 8)
    || anchors.find((anchor) => anchor.text.length > 8)
    || { href: '', text: '' };
}

function extractTitle($, $node, linkText = '') {
  const selectors = [
    '[data-automation-id="product-title"]',
    '[data-testid="product-title"]',
    '[data-testid*="product-title"]',
    'span[data-automation-id*="product"]',
    'a[href*="/ip/"]',
    'img[alt]',
  ];
  for (const selector of selectors) {
    const value = selector === 'img[alt]' ? $node.find(selector).first().attr('alt') : $node.find(selector).first().text();
    const cleaned = cleanProductTitle(value);
    if (cleaned) return cleaned;
  }
  return cleanProductTitle(linkText);
}

function extractRank(text) {
  const match = String(text || '').match(/#\s*(\d{1,3})\b/);
  return match ? Number(match[1]) : null;
}

function extractProductId(href = '') {
  const match = String(href || '').match(/\/ip\/[^/?#]*\/(\d{4,})(?:[/?#]|$)/i)
    || String(href || '').match(/[?&](?:itemId|selectedSellerId|variantFieldId)=(\d{4,})/i);
  return match?.[1] || '';
}

function cleanProductId(value) {
  const id = String(value || '').trim();
  return /^\d{4,}$/.test(id) ? id : '';
}

function extractPrice(text) {
  const match = String(text || '').match(/\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function extractUnitPrice(text) {
  const match = String(text || '').match(/\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)\s*\/\s*([A-Za-z0-9.-]{1,18})/);
  if (!match) return null;
  return `$${match[1]}/${cleanText(match[2]).toLowerCase()}`;
}

function extractRating(text) {
  const match = String(text || '').match(/(\d(?:\.\d)?)\s+out of\s+5\s+stars/i);
  return match ? Number(match[1]) : null;
}

function extractReviewCount(text) {
  const match = String(text || '').match(/([\d,]{1,})\s+(?:reviews?|ratings?)/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function extractBoughtSinceYesterday(text) {
  const match = String(text || '').match(/([\d,.]+)\s*([KMB])?\+?\s+bought since yesterday/i);
  if (!match) return null;
  return parseAbbreviatedNumber(match[1], match[2]);
}

function extractAvailability(text) {
  const normalized = String(text || '').toLowerCase();
  if (/out of stock/.test(normalized)) return 'out-of-stock';
  if (/low stock/.test(normalized)) return 'low-stock';
  if (/in stock/.test(normalized)) return 'in-stock';
  if (/pickup/.test(normalized) && /delivery/.test(normalized)) return 'pickup-delivery';
  if (/shipping/.test(normalized)) return 'shipping';
  if (/delivery/.test(normalized)) return 'delivery';
  if (/pickup/.test(normalized)) return 'pickup';
  return null;
}

function parseAbbreviatedNumber(value, suffix = '') {
  const numeric = Number(String(value || '').replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return null;
  const multiplier = suffix.toUpperCase() === 'B' ? 1000000000
    : suffix.toUpperCase() === 'M' ? 1000000
      : suffix.toUpperCase() === 'K' ? 1000
        : 1;
  return Math.round(numeric * multiplier);
}

function scoreRecord({ rank, boughtSinceYesterday, lowStock, bestsellerLabel, trendingLabel, source }) {
  const base = source.sourceType === 'trending-rank' ? 62
    : source.sourceType === 'bestseller-rank' ? 59
      : 55;
  const rankBoost = Math.max(0, 38 - Math.min(rank || 120, 120) * 0.26);
  const boughtBoost = Number.isFinite(boughtSinceYesterday) ? Math.min(16, Math.log10(Math.max(10, boughtSinceYesterday)) * 4) : 0;
  const labelBoost = (bestsellerLabel ? 4 : 0) + (trendingLabel ? 5 : 0);
  const scarcityBoost = lowStock ? 3 : 0;
  return clampScore(base + rankBoost + boughtBoost + labelBoost + scarcityBoost + ((source.weight || 0.75) - 0.7) * 18);
}

function inferBrandHint(title) {
  const words = cleanText(title).split(/\s+/).filter(Boolean);
  const stop = new Set(['the', 'a', 'an', 'new', 'with', 'for', 'and', 'walmart']);
  return words.find((word) => word.length > 2 && !stop.has(word.toLowerCase())) || '';
}

function absolutize(href) {
  try {
    return new URL(href, WALMART_HOME_URL).toString();
  } catch {
    return null;
  }
}

function cleanProductTitle(value) {
  const cleaned = cleanText(value)
    .replace(/^#\s*\d+\s*/i, '')
    .replace(/\s+\$\s*\d.*$/, '')
    .replace(/\s+\d(?:\.\d)?\s+out of\s+5\s+stars.*$/i, '')
    .replace(/\s+best\s*seller.*$/i, '')
    .trim();
  return cleaned.length >= 4 ? cleaned.slice(0, 220) : '';
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return 50;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clampScore(value) {
  return Math.round(clamp(value, 0, 100));
}

function clampInt(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  WALMART_HOME_URL,
  WALMART_RETAIL_SOURCES,
  collectWalmartRetailDemandContext,
  parseProductRows,
  evaluateWalmartRetailDemandContext,
  compactForBmcl,
  sourceList,
};
