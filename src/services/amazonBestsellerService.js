const cheerio = require('cheerio');
const { resilientFetch } = require('../utils/resilientFetch');

const AMAZON_HOME_URL = 'https://www.amazon.com/';

const AMAZON_BESTSELLER_SOURCES = [
  {
    id: 'all-bestsellers',
    label: 'All Best Sellers',
    url: 'https://www.amazon.com/Best-Sellers/zgbs',
    category: 'all',
    sourceType: 'bestseller-rank',
    weight: 0.72,
  },
  {
    id: 'home-kitchen',
    label: 'Home and Kitchen Best Sellers',
    url: 'https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden',
    category: 'home-kitchen',
    sourceType: 'bestseller-rank',
    weight: 0.78,
  },
  {
    id: 'household-supplies',
    label: 'Household Supplies Best Sellers',
    url: 'https://www.amazon.com/Best-Sellers-Household-Supplies/zgbs/hpc/15342811',
    category: 'household-supplies',
    sourceType: 'bestseller-rank',
    weight: 0.8,
  },
  {
    id: 'kitchen-dining',
    label: 'Kitchen and Dining Best Sellers',
    url: 'https://www.amazon.com/Best-Sellers-Kitchen-Dining/zgbs/kitchen',
    category: 'kitchen-dining',
    sourceType: 'bestseller-rank',
    weight: 0.78,
  },
  {
    id: 'laundry-supplies',
    label: 'Laundry Supplies Best Sellers',
    url: 'https://www.amazon.com/Best-Sellers-Laundry-Supplies/zgbs/hpc/15356111',
    category: 'laundry-supplies',
    sourceType: 'bestseller-rank',
    weight: 0.82,
  },
  {
    id: 'cleaning-tools',
    label: 'Household Cleaning Tools Best Sellers',
    url: 'https://www.amazon.com/Best-Sellers-Household-Cleaning-Tools/zgbs/hpc/15342831',
    category: 'cleaning-tools',
    sourceType: 'bestseller-rank',
    weight: 0.8,
  },
  {
    id: 'all-purpose-cleaners',
    label: 'All-purpose Household Cleaners Best Sellers',
    url: 'https://www.amazon.com/Best-Sellers-All-Purpose-Household-Cleaners/zgbs/hpc/15356141',
    category: 'all-purpose-cleaners',
    sourceType: 'bestseller-rank',
    weight: 0.84,
  },
  {
    id: 'movers-shakers',
    label: 'Amazon Movers and Shakers',
    url: 'https://www.amazon.com/gp/movers-and-shakers',
    category: 'all',
    sourceType: 'sales-rank-acceleration',
    weight: 0.9,
  },
];

async function collectAmazonBestsellerContext({
  timeoutMs = 9000,
  limit = 20,
  sourceIds,
  includeMovers = true,
  onEvent = () => {},
} = {}) {
  const selectedIds = new Set((Array.isArray(sourceIds) ? sourceIds : []).filter(Boolean));
  const selectedSources = AMAZON_BESTSELLER_SOURCES
    .filter((source) => includeMovers || source.id !== 'movers-shakers')
    .filter((source) => !selectedIds.size || selectedIds.has(source.id) || selectedIds.has(source.category));
  const sources = selectedSources.length ? selectedSources : AMAZON_BESTSELLER_SOURCES;
  const boundedLimit = clampInt(limit, 1, 100);

  const settled = await Promise.allSettled(sources.map(async (source) => {
    const html = await fetchHtml(source.url, timeoutMs);
    const rows = parseBestsellerRows(html, source).slice(0, boundedLimit);
    emit(onEvent, 'amazon-bestsellers', 36, 'debug', 'Fetched Amazon bestseller source page.', {
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
      emit(onEvent, 'amazon-bestsellers', 36, 'warn', 'Amazon bestseller page unavailable; continuing with remaining sources.', {
        source: source.id,
        url: source.url,
        error: result.reason.message,
      });
    }
  });

  return evaluateAmazonBestsellerContext({ sourceResults, failures });
}

function parseBestsellerRows(html, source = {}) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();
  const candidates = $('[data-asin], #gridItemRoot, .zg-grid-general-faceout, .p13n-gridRow, li').toArray();

  for (const node of candidates) {
    const $node = $(node);
    const text = cleanText($node.text());
    if (!text || !/(#\s*\d+|Best Sellers Rank|sales rank|stars|\$)/i.test(text)) continue;
    const link = findProductLink($, $node);
    const asin = cleanAsin($node.attr('data-asin') || extractAsin(link.href));
    const rank = extractRank(text) || rows.length + 1;
    const title = extractTitle($, $node, link.text);
    if (!title || seen.has(`${source.id}:${asin || title.toLowerCase()}`)) continue;

    const rankGainPct = extractRankGainPct(text);
    const record = {
      rank,
      asin: asin || null,
      title,
      brandHint: inferBrandHint(title),
      category: source.category,
      sourceId: source.id,
      sourceLabel: source.label,
      sourceType: source.sourceType,
      price: extractPrice(text),
      rating: extractRating(text),
      reviewCount: extractReviewCount(text),
      rankGainPct,
      productUrl: link.href ? absolutize(link.href) : null,
      sourceUrl: source.url,
      signalScore: scoreRecord({ rank, rankGainPct, source }),
      rowText: text.slice(0, 700),
      caveat: 'Amazon bestseller pages are scraped storefront rank signals, not sales-volume, revenue, UPC-level, or independent market-share data.',
    };
    rows.push(record);
    seen.add(`${source.id}:${asin || title.toLowerCase()}`);
  }

  return rows
    .filter((row) => row.rank >= 1 && row.rank <= 150)
    .sort((a, b) => a.rank - b.rank || b.signalScore - a.signalScore);
}

function evaluateAmazonBestsellerContext({ sourceResults = [], failures = [] } = {}) {
  const records = sourceResults.flatMap((result) => result.rows || []);
  const movers = records.filter((record) => record.sourceType === 'sales-rank-acceleration');
  const stableRanked = records.filter((record) => record.sourceType === 'bestseller-rank');
  const categories = [...new Set(records.map((record) => record.category).filter(Boolean))];
  const productMomentumScore = clampScore(average(records.map((record) => record.signalScore)));
  const accelerationScore = clampScore(average(movers.map((record) => record.signalScore)));
  const stableDemandScore = clampScore(average(stableRanked.map((record) => record.signalScore)));
  const demandBias = accelerationScore >= 68 || productMomentumScore >= 66 ? 'accelerating'
    : records.length ? 'visible-demand' : 'unavailable';

  return {
    available: records.length > 0,
    fetchedAt: new Date().toISOString(),
    provider: 'amazon-bestsellers',
    sourceList: sourceList(),
    failures,
    sourceCount: sourceResults.length,
    signalCount: records.length,
    categoryCount: categories.length,
    categories,
    productMomentumScore,
    accelerationScore,
    stableDemandScore,
    demandBias,
    records,
    topProducts: stableRanked.sort((a, b) => b.signalScore - a.signalScore || a.rank - b.rank).slice(0, 20),
    fastestMovers: movers.sort((a, b) => b.signalScore - a.signalScore || a.rank - b.rank).slice(0, 20),
    categorySummaries: summarizeCategories(records),
    caveat: 'Amazon bestseller and Movers & Shakers pages are scraped consumer-storefront rank signals. They show relative product rank or rank acceleration, not absolute sales volume, revenue, market share, UPC-level scanner data, or company-specific financial performance.',
    narrative: records.length
      ? `Amazon bestseller context ${demandBias}: ${records.length} product-rank signals across ${categories.length} categories. Stable demand ${stableDemandScore}, acceleration ${accelerationScore}.`
      : 'Amazon bestseller context unavailable; pages may be blocked, throttled, region-specific, or changed.',
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'amazon-bestsellers',
    fetchedAt: context.fetchedAt,
    demandBias: context.demandBias,
    productMomentumScore: context.productMomentumScore,
    accelerationScore: context.accelerationScore,
    stableDemandScore: context.stableDemandScore,
    signalCount: context.signalCount || 0,
    categoryCount: context.categoryCount || 0,
    categories: context.categories || [],
    categorySummaries: context.categorySummaries || [],
    topProducts: (context.topProducts || []).slice(0, 10).map(compactRecord),
    fastestMovers: (context.fastestMovers || []).slice(0, 10).map(compactRecord),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.caveat,
    bmclUse: 'Share as scraped Amazon product-rank and 24-hour rank-acceleration discovery evidence. Use compact product/category/rank snippets to spot consumer-demand themes, brands, CPG, household, kitchen, cleaning, ecommerce, logistics, and retail opportunities, then corroborate with Census retail, USDA/BLS data, company filings, independent news, broker/Finnhub data, and official sources before scoring or trading.',
  };
}

async function fetchHtml(url, timeoutMs = 9000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 AutoTrader Amazon bestseller research bot; contact=local',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers, redirect: 'follow' }, { bucket: 'amazon-bestsellers', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return AMAZON_BESTSELLER_SOURCES.map((source) => ({
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
      topTitles: [],
    };
    current.signals += 1;
    current.averageRank += record.rank;
    current.averageScore += record.signalScore;
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
    asin: record.asin,
    title: record.title,
    brandHint: record.brandHint,
    category: record.category,
    sourceLabel: record.sourceLabel,
    sourceType: record.sourceType,
    price: record.price,
    rating: record.rating,
    reviewCount: record.reviewCount,
    rankGainPct: record.rankGainPct,
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
  return anchors.find((anchor) => /\/(?:dp|gp\/product)\//i.test(anchor.href))
    || anchors.find((anchor) => /\/product-reviews\//i.test(anchor.href))
    || anchors.find((anchor) => anchor.text.length > 8)
    || { href: '', text: '' };
}

function extractTitle($, $node, linkText = '') {
  const selectors = [
    '._cDEzb_p13n-sc-css-line-clamp-3_g3dy1',
    '._cDEzb_p13n-sc-css-line-clamp-2_EWgCb',
    '.p13n-sc-truncate',
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

function extractAsin(href = '') {
  const match = String(href || '').match(/\/(?:dp|gp\/product|product-reviews)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return match?.[1] || '';
}

function cleanAsin(value) {
  const asin = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : '';
}

function extractPrice(text) {
  const match = String(text || '').match(/\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function extractRating(text) {
  const match = String(text || '').match(/(\d(?:\.\d)?)\s+out of\s+5\s+stars/i);
  return match ? Number(match[1]) : null;
}

function extractReviewCount(text) {
  const match = String(text || '').match(/(?:stars\s+)?([\d,]{2,})\s+(?:ratings?|reviews?)/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function extractRankGainPct(text) {
  const match = String(text || '').match(/([\d,.]+)%\s*(?:increase|gain|up|in sales rank|sales rank)/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function scoreRecord({ rank, rankGainPct, source }) {
  const base = source.sourceType === 'sales-rank-acceleration' ? 62 : 58;
  const rankBoost = Math.max(0, 40 - Math.min(rank || 100, 100) * 0.32);
  const gainBoost = Number.isFinite(rankGainPct) ? Math.min(22, rankGainPct / 12) : 0;
  return clampScore(base + rankBoost + gainBoost + ((source.weight || 0.7) - 0.7) * 18);
}

function inferBrandHint(title) {
  const words = cleanText(title).split(/\s+/).filter(Boolean);
  const stop = new Set(['the', 'a', 'an', 'new', 'with', 'for', 'and']);
  return words.find((word) => word.length > 2 && !stop.has(word.toLowerCase())) || '';
}

function absolutize(href) {
  try {
    return new URL(href, AMAZON_HOME_URL).toString();
  } catch {
    return null;
  }
}

function cleanProductTitle(value) {
  const cleaned = cleanText(value)
    .replace(/^#\s*\d+\s*/i, '')
    .replace(/\s+\$\s*\d.*$/, '')
    .replace(/\s+\d(?:\.\d)?\s+out of\s+5\s+stars.*$/i, '')
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
  AMAZON_HOME_URL,
  AMAZON_BESTSELLER_SOURCES,
  collectAmazonBestsellerContext,
  parseBestsellerRows,
  evaluateAmazonBestsellerContext,
  compactForBmcl,
  sourceList,
};
