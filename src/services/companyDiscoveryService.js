const DIRECT_TICKER_TERMS = [
  'NASDAQ',
  'NYSE',
  'NYSEARCA',
  'AMEX',
];

const COMPANY_PROFILES = [
  { symbol: 'AAPL', companyName: 'Apple', aliases: ['apple', 'iphone', 'ipad', 'macbook', 'vision pro', 'app store'], tags: ['consumer-tech', 'hardware'] },
  { symbol: 'MSFT', companyName: 'Microsoft', aliases: ['microsoft', 'azure', 'copilot', 'windows', 'office', 'openai', 'chatgpt'], tags: ['cloud', 'ai', 'software'] },
  { symbol: 'GOOGL', companyName: 'Alphabet', aliases: ['alphabet', 'google', 'gemini', 'youtube', 'waymo', 'android'], tags: ['search', 'ads', 'ai'] },
  { symbol: 'AMZN', companyName: 'Amazon', aliases: ['amazon', 'aws', 'prime', 'whole foods', 'anthropic', 'claude'], tags: ['cloud', 'retail', 'logistics'] },
  { symbol: 'NVDA', companyName: 'NVIDIA', aliases: ['nvidia', 'blackwell', 'cuda', 'gpu', 'ai chip', 'data center chip'], tags: ['semiconductors', 'ai'] },
  { symbol: 'AMD', companyName: 'AMD', aliases: ['advanced micro devices', 'amd', 'ryzen', 'epyc', 'instinct gpu'], tags: ['semiconductors'] },
  { symbol: 'TSM', companyName: 'Taiwan Semiconductor', aliases: ['taiwan semiconductor', 'tsmc', 'chip foundry'], tags: ['semiconductors', 'manufacturing'] },
  { symbol: 'AVGO', companyName: 'Broadcom', aliases: ['broadcom', 'vmware', 'networking chip'], tags: ['semiconductors', 'infrastructure'] },
  { symbol: 'MU', companyName: 'Micron', aliases: ['micron', 'memory chip', 'dram', 'hbm'], tags: ['semiconductors', 'memory'] },
  { symbol: 'META', companyName: 'Meta', aliases: ['meta', 'facebook', 'instagram', 'threads', 'whatsapp', 'metaverse'], tags: ['social', 'ads', 'ai'] },
  { symbol: 'TSLA', companyName: 'Tesla', aliases: ['tesla', 'model y', 'model 3', 'cybertruck', 'robotaxi', 'spacex', 'starlink'], tags: ['ev', 'energy', 'ai'] },
  { symbol: 'NFLX', companyName: 'Netflix', aliases: ['netflix', 'streaming', 'subscriber growth'], tags: ['media'] },
  { symbol: 'DIS', companyName: 'Disney', aliases: ['disney', 'espn', 'hulu', 'parks', 'box office'], tags: ['media', 'travel'] },
  { symbol: 'SHOP', companyName: 'Shopify', aliases: ['shopify', 'commerce platform', 'merchant software'], tags: ['saas', 'commerce'] },
  { symbol: 'CRM', companyName: 'Salesforce', aliases: ['salesforce', 'crm', 'einstein ai'], tags: ['saas', 'enterprise'] },
  { symbol: 'NOW', companyName: 'ServiceNow', aliases: ['servicenow', 'workflow automation'], tags: ['saas', 'enterprise'] },
  { symbol: 'SNOW', companyName: 'Snowflake', aliases: ['snowflake', 'data cloud'], tags: ['saas', 'data'] },
  { symbol: 'PLTR', companyName: 'Palantir', aliases: ['palantir', 'aip platform', 'government analytics'], tags: ['ai', 'defense', 'data'] },
  { symbol: 'ORCL', companyName: 'Oracle', aliases: ['oracle', 'oci', 'database cloud'], tags: ['cloud', 'software'] },
  { symbol: 'HOOD', companyName: 'Robinhood', aliases: ['robinhood', 'retail brokerage'], tags: ['fintech'] },
  { symbol: 'COIN', companyName: 'Coinbase', aliases: ['coinbase', 'crypto exchange', 'bitcoin etf'], tags: ['crypto', 'fintech'] },
  { symbol: 'JPM', companyName: 'JPMorgan Chase', aliases: ['jpmorgan', 'jp morgan', 'chase bank'], tags: ['financials'] },
  { symbol: 'BAC', companyName: 'Bank of America', aliases: ['bank of america', 'bofa'], tags: ['financials'] },
  { symbol: 'GS', companyName: 'Goldman Sachs', aliases: ['goldman sachs'], tags: ['financials'] },
  { symbol: 'V', companyName: 'Visa', aliases: ['visa payments', 'visa'], tags: ['payments'] },
  { symbol: 'MA', companyName: 'Mastercard', aliases: ['mastercard'], tags: ['payments'] },
  { symbol: 'LLY', companyName: 'Eli Lilly', aliases: ['eli lilly', 'lilly', 'zepbound', 'mounjaro'], tags: ['healthcare', 'glp-1'] },
  { symbol: 'NVO', companyName: 'Novo Nordisk', aliases: ['novo nordisk', 'ozempic', 'wegovy'], tags: ['healthcare', 'glp-1'] },
  { symbol: 'PFE', companyName: 'Pfizer', aliases: ['pfizer'], tags: ['healthcare'] },
  { symbol: 'MRK', companyName: 'Merck', aliases: ['merck', 'keytruda'], tags: ['healthcare'] },
  { symbol: 'JNJ', companyName: 'Johnson & Johnson', aliases: ['johnson & johnson', 'j&j'], tags: ['healthcare'] },
  { symbol: 'XOM', companyName: 'Exxon Mobil', aliases: ['exxon', 'exxonmobil', 'oil major'], tags: ['energy', 'oil'] },
  { symbol: 'CVX', companyName: 'Chevron', aliases: ['chevron'], tags: ['energy', 'oil'] },
  { symbol: 'COP', companyName: 'ConocoPhillips', aliases: ['conocophillips'], tags: ['energy', 'oil'] },
  { symbol: 'SLB', companyName: 'SLB', aliases: ['slb', 'schlumberger', 'oilfield services'], tags: ['energy', 'oil-services'] },
  { symbol: 'LMT', companyName: 'Lockheed Martin', aliases: ['lockheed', 'lockheed martin', 'f-35', 'missile defense'], tags: ['defense'] },
  { symbol: 'RTX', companyName: 'RTX', aliases: ['rtx', 'raytheon', 'pratt & whitney', 'patriot missile'], tags: ['defense', 'aerospace'] },
  { symbol: 'NOC', companyName: 'Northrop Grumman', aliases: ['northrop', 'northrop grumman', 'b-21'], tags: ['defense'] },
  { symbol: 'GD', companyName: 'General Dynamics', aliases: ['general dynamics', 'gulfstream'], tags: ['defense'] },
  { symbol: 'BA', companyName: 'Boeing', aliases: ['boeing', '737 max', 'aerospace'], tags: ['aerospace', 'defense'] },
  { symbol: 'CAT', companyName: 'Caterpillar', aliases: ['caterpillar', 'heavy equipment', 'construction equipment'], tags: ['industrial'] },
  { symbol: 'DE', companyName: 'Deere', aliases: ['deere', 'john deere', 'farm equipment'], tags: ['industrial', 'agriculture'] },
  { symbol: 'WMT', companyName: 'Walmart', aliases: ['walmart'], tags: ['retail', 'consumer'] },
  { symbol: 'COST', companyName: 'Costco', aliases: ['costco'], tags: ['retail', 'consumer'] },
  { symbol: 'TGT', companyName: 'Target', aliases: ['target stores', 'target retail'], tags: ['retail', 'consumer'] },
  { symbol: 'HD', companyName: 'Home Depot', aliases: ['home depot'], tags: ['housing', 'retail'] },
  { symbol: 'LOW', companyName: 'Lowe\'s', aliases: ['lowe\'s', 'lowes'], tags: ['housing', 'retail'] },
  { symbol: 'UBER', companyName: 'Uber', aliases: ['uber', 'rideshare', 'ride-hailing'], tags: ['travel', 'logistics'] },
  { symbol: 'ABNB', companyName: 'Airbnb', aliases: ['airbnb', 'short-term rental'], tags: ['travel'] },
  { symbol: 'MCD', companyName: 'McDonald\'s', aliases: ['mcdonald\'s', 'mcdonalds'], tags: ['food', 'consumer'] },
  { symbol: 'SBUX', companyName: 'Starbucks', aliases: ['starbucks'], tags: ['food', 'consumer'] },
];

const ETF_PROXIES = [
  { symbol: 'SOXX', companyName: 'iShares Semiconductor ETF', terms: ['chip shortage', 'semiconductor cycle', 'ai chip demand', 'gpu demand'], tags: ['sector-proxy', 'semiconductors'] },
  { symbol: 'XLE', companyName: 'Energy Select Sector SPDR', terms: ['oil price', 'crude oil', 'gasoline prices', 'opec'], tags: ['sector-proxy', 'energy'] },
  { symbol: 'XLI', companyName: 'Industrial Select Sector SPDR', terms: ['infrastructure spending', 'manufacturing boom', 'industrial production'], tags: ['sector-proxy', 'industrial'] },
  { symbol: 'XLF', companyName: 'Financial Select Sector SPDR', terms: ['bank stocks', 'yield curve', 'credit spreads'], tags: ['sector-proxy', 'financials'] },
  { symbol: 'XLY', companyName: 'Consumer Discretionary Select Sector SPDR', terms: ['consumer spending', 'retail sales', 'holiday shopping'], tags: ['sector-proxy', 'consumer'] },
  { symbol: 'ITA', companyName: 'iShares US Aerospace & Defense ETF', terms: ['war', 'missile defense', 'military spending', 'defense contract'], tags: ['sector-proxy', 'defense'] },
];

const SYMBOL_WHITELIST = new Set([
  ...COMPANY_PROFILES.map((profile) => profile.symbol),
  ...ETF_PROXIES.map((proxy) => proxy.symbol),
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
]);

function discoverCompanies({ news = { items: [] }, learned = { observations: [] }, maxCandidates = 18 } = {}) {
  const documents = buildDocuments(news, learned);
  const candidateMap = new Map();

  for (const document of documents) {
    scanKnownCompanies(document, candidateMap);
    scanEtfProxies(document, candidateMap);
    scanTickerMentions(document, candidateMap);
  }

  return [...candidateMap.values()]
    .map((candidate) => ({
      ...candidate,
      themeHits: Number(candidate.themeHits.toFixed(2)),
      evidence: candidate.evidence.slice(0, 5),
    }))
    .filter((candidate) => candidate.themeHits >= 2)
    .sort((a, b) => b.themeHits - a.themeHits || a.symbol.localeCompare(b.symbol))
    .slice(0, maxCandidates);
}

function buildDocuments(news, learned) {
  const newsDocs = (news.items || []).map((item) => ({
    title: item.title || item.source || 'News item',
    url: item.link || item.url || '',
    text: `${item.title || ''} ${item.description || ''}`,
    weight: 1.15,
    sourceType: 'news',
  }));
  const learnedDocs = (learned.observations || []).map((item) => ({
    title: item.title || item.url || 'Learned source',
    url: item.url || '',
    text: `${item.title || ''} ${item.excerpt || ''} ${(item.links || []).map((link) => `${link.text || ''} ${link.url || ''}`).join(' ')}`,
    weight: 1,
    sourceType: 'crawled-source',
  }));
  return [...newsDocs, ...learnedDocs].filter((document) => document.text.trim());
}

function scanKnownCompanies(document, candidateMap) {
  const text = normalize(document.text);
  for (const profile of COMPANY_PROFILES) {
    const hits = profile.aliases.reduce((sum, alias) => sum + occurrenceCount(text, alias), 0);
    if (!hits) continue;
    addCandidate(candidateMap, {
      symbol: profile.symbol,
      companyName: profile.companyName,
      score: hits * document.weight * 2,
      tags: profile.tags,
      reason: `Crawled ${document.sourceType} mentioned ${profile.companyName} or product aliases ${hits} time(s).`,
      url: document.url,
      title: document.title,
    });
  }
}

function scanEtfProxies(document, candidateMap) {
  const text = normalize(document.text);
  for (const proxy of ETF_PROXIES) {
    const hits = proxy.terms.reduce((sum, term) => sum + occurrenceCount(text, term), 0);
    if (!hits) continue;
    addCandidate(candidateMap, {
      symbol: proxy.symbol,
      companyName: proxy.companyName,
      score: hits * document.weight * 1.6,
      tags: proxy.tags,
      reason: `New event/product theme maps to public market proxy ${proxy.symbol}.`,
      url: document.url,
      title: document.title,
    });
  }
}

function scanTickerMentions(document, candidateMap) {
  const tickerBlacklist = new Set(['CEO', 'CFO', 'COO', 'SEC', 'IPO', 'ETF', 'USA', 'USD', 'AI', 'EV', 'GDP', 'CPI', 'FED']);
  const patterns = [
    /\$([A-Z]{1,5})\b/g,
    /\(([A-Z]{1,5})\)/g,
    new RegExp(`\\b(?:${DIRECT_TICKER_TERMS.join('|')})[:\\s]+([A-Z]{1,5})\\b`, 'g'),
  ];
  for (const pattern of patterns) {
    for (const match of document.text.matchAll(pattern)) {
      const symbol = match[1];
      if (tickerBlacklist.has(symbol)) continue;
      const profile = COMPANY_PROFILES.find((item) => item.symbol === symbol) || ETF_PROXIES.find((item) => item.symbol === symbol);
      addCandidate(candidateMap, {
        symbol,
        companyName: profile?.companyName || symbol,
        score: document.weight * (SYMBOL_WHITELIST.has(symbol) ? 2.5 : 2.2),
        tags: profile?.tags || ['direct-ticker'],
        reason: `Crawled ${document.sourceType} included ${SYMBOL_WHITELIST.has(symbol) ? 'known' : 'new'} direct ticker mention ${symbol}.`,
        url: document.url,
        title: document.title,
      });
    }
  }
}

function addCandidate(candidateMap, item) {
  const existing = candidateMap.get(item.symbol) || {
    symbol: item.symbol,
    companyName: item.companyName,
    theme: 'crawled-discovery',
    themeHits: 0,
    discovery: {
      method: 'crawled-company-product-detection',
      tags: [],
      evidence: [],
    },
    evidence: [],
  };
  existing.themeHits += item.score;
  existing.discovery.tags = [...new Set([...(existing.discovery.tags || []), ...(item.tags || [])])].slice(0, 8);
  existing.discovery.evidence.push({
    title: item.title,
    url: item.url,
    reason: item.reason,
  });
  existing.evidence.push(item.reason);
  candidateMap.set(item.symbol, existing);
}

function occurrenceCount(text, needle) {
  const normalizedNeedle = normalize(needle);
  if (!text || !normalizedNeedle) return 0;
  const escaped = normalizedNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = text.match(new RegExp(`\\b${escaped}\\b`, 'g'));
  return matches?.length || 0;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = {
  COMPANY_PROFILES,
  ETF_PROXIES,
  discoverCompanies,
};
