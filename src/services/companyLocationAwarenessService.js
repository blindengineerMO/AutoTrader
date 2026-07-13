const crawleeResearchCrawler = require('./crawleeResearchCrawlerService');
const semanticResearchMemory = require('./semanticResearchMemoryService');
const researchSourceRepo = require('../db/repositories/researchSourceRepo');
const companyLocationProfileRepo = require('../db/repositories/companyLocationProfileRepo');

const LOCATION_QUESTION_TEMPLATES = [
  'Where does {company} have corporate offices',
  'What retail locations does {company} have',
  'What area of the world has the most customers for {company}',
  'Where does {company} generate the most revenue by geography',
  'Where are {company} supply chain manufacturing distribution locations',
];

const LOCATION_TERMS = [
  'United States', 'North America', 'Europe', 'European Union', 'China', 'India', 'Japan', 'Taiwan',
  'South Korea', 'United Kingdom', 'Germany', 'France', 'Canada', 'Mexico', 'Brazil', 'Australia',
  'Middle East', 'Israel', 'Gaza', 'Ukraine', 'Russia', 'Red Sea', 'Persian Gulf',
  'California', 'Texas', 'Florida', 'New York', 'Washington', 'Oregon', 'Nevada', 'Arizona',
  'Georgia', 'Illinois', 'Ohio', 'Michigan', 'Pennsylvania', 'North Carolina', 'Virginia',
  'Seattle', 'Cupertino', 'Austin', 'Bentonville', 'Atlanta', 'Chicago', 'New York City',
  'Los Angeles', 'San Francisco', 'Bay Area', 'Dallas', 'Houston', 'Miami', 'Orlando',
  'Phoenix', 'Detroit', 'Pittsburgh', 'Raleigh', 'London', 'Paris', 'Berlin', 'Shanghai',
  'Beijing', 'Shenzhen', 'Taipei', 'Seoul', 'Tokyo', 'Bangalore', 'Mumbai',
];

const LOCATION_PARENTS = {
  seattle: ['washington', 'united states', 'north america'],
  cupertino: ['california', 'united states', 'north america'],
  austin: ['texas', 'united states', 'north america'],
  bentonville: ['united states', 'north america'],
  atlanta: ['georgia', 'united states', 'north america'],
  chicago: ['illinois', 'united states', 'north america'],
  'new york city': ['new york', 'united states', 'north america'],
  'los angeles': ['california', 'united states', 'north america'],
  'san francisco': ['california', 'bay area', 'united states', 'north america'],
  'bay area': ['california', 'united states', 'north america'],
  dallas: ['texas', 'united states', 'north america'],
  houston: ['texas', 'united states', 'north america'],
  miami: ['florida', 'united states', 'north america'],
  orlando: ['florida', 'united states', 'north america'],
  phoenix: ['arizona', 'united states', 'north america'],
  detroit: ['michigan', 'united states', 'north america'],
  pittsburgh: ['pennsylvania', 'united states', 'north america'],
  raleigh: ['north carolina', 'united states', 'north america'],
  london: ['united kingdom', 'europe'],
  paris: ['france', 'europe'],
  berlin: ['germany', 'europe'],
  shanghai: ['china'],
  beijing: ['china'],
  shenzhen: ['china'],
  taipei: ['taiwan'],
  seoul: ['south korea'],
  tokyo: ['japan'],
  bangalore: ['india'],
  mumbai: ['india'],
  california: ['united states', 'north america'],
  texas: ['united states', 'north america'],
  florida: ['united states', 'north america'],
  'new york': ['united states', 'north america'],
  washington: ['united states', 'north america'],
};

async function researchCompanyLocations({ userId, candidates = [], news = { items: [] }, learned = { observations: [] }, onEvent = () => {} } = {}) {
  const targets = candidates.slice(0, 10);
  if (!targets.length) return { profilesBySymbol: new Map(), crawl: null };
  const queries = targets.flatMap(buildLocationResearchQueries).slice(0, 40);
  const semanticSeeds = semanticResearchMemory.buildSeedSourcesFromMemory({ userId, queries, limit: 12 });

  emit(onEvent, 'location-intel', 58, 'debug', 'Researching company geographic footprint for local event relevance.', {
    candidates: targets.map((candidate) => candidate.symbol),
    querySamples: queries.slice(0, 8),
    semanticSeeds: semanticSeeds.length,
  });

  const crawl = await crawleeResearchCrawler.crawlAutonomousResearch({
    queries,
    seedSources: semanticSeeds,
    onEvent,
    maxFollowUps: 8,
    maxRequests: 64,
    minContinuationScore: 1.55,
    maxWaves: 4,
    maxSearchExpansions: 16,
    maxRuntimeMs: 3 * 60 * 1000,
  }).catch((error) => {
    emit(onEvent, 'location-intel', 59, 'warn', 'Company location crawl was unavailable; using current research text only.', {
      error: error.message,
    });
    return { pages: [], discovered: [], failures: [], entityLeads: [] };
  });

  persistLocationCrawl({ userId, crawl });
  const documents = buildDocuments({ news, learned, crawl });
  const profilesBySymbol = new Map();
  for (const candidate of targets) {
    const profile = extractLocationProfile({ candidate, documents });
    profile.localEventExposure = scoreLocalEventRelevance({ candidate, locationProfile: profile, documents });
    const saved = companyLocationProfileRepo.save({
      userId,
      symbol: candidate.symbol,
      companyName: candidate.companyName || candidate.symbol,
      profile,
    });
    profilesBySymbol.set(candidate.symbol, saved.profile);
  }
  return { profilesBySymbol, crawl };
}

function buildLocationResearchQueries(candidate) {
  const company = candidate.companyName || candidate.symbol;
  return LOCATION_QUESTION_TEMPLATES.map((template) => template.replace('{company}', company));
}

function extractLocationProfile({ candidate = {}, documents = [] } = {}) {
  const companyTerms = [candidate.symbol, candidate.companyName].filter(Boolean).map((item) => String(item).toLowerCase());
  const exposures = new Map();
  for (const document of documents) {
    for (const sentence of splitSentences(`${document.title || ''}. ${document.text || document.excerpt || ''}`)) {
      const lowered = sentence.toLowerCase();
      if (companyTerms.length && !companyTerms.some((term) => lowered.includes(term))) continue;
      const locations = extractLocations(sentence);
      if (!locations.length) continue;
      const type = classifyCompanyLocationType(sentence);
      for (const location of locations) {
        const key = `${type}:${canonicalLocation(location)}`;
        const existing = exposures.get(key) || {
          type,
          location,
          canonical: canonicalLocation(location),
          score: 0,
          evidence: [],
        };
        existing.score += locationTypeWeight(type);
        existing.evidence.push({ title: document.title, url: document.url, text: sentence.slice(0, 280) });
        existing.evidence = existing.evidence.slice(0, 4);
        exposures.set(key, existing);
      }
    }
  }
  const ranked = [...exposures.values()]
    .map((item) => ({ ...item, score: round(Math.min(1, item.score)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);
  return {
    symbol: candidate.symbol,
    companyName: candidate.companyName || candidate.symbol,
    researchedAt: new Date().toISOString(),
    queryTemplates: buildLocationResearchQueries(candidate),
    exposures: ranked,
    primaryLocations: ranked.slice(0, 6).map((item) => item.location),
    confidence: ranked.length ? round(Math.min(1, ranked.reduce((sum, item) => sum + item.score, 0) / 4)) : 0,
  };
}

function scoreLocalEventRelevance({ candidate = {}, locationProfile = {}, documents = [] } = {}) {
  const profileLocations = new Set((locationProfile.exposures || []).flatMap((item) => expandedLocationKeys(item.canonical)));
  const impacts = [];
  for (const document of documents) {
    for (const sentence of splitSentences(`${document.title || ''}. ${document.text || document.excerpt || ''}`)) {
      const eventType = classifyLocalEventType(sentence);
      if (!eventType) continue;
      const eventLocations = extractLocations(sentence);
      const locationRelevance = scoreLocationOverlap(profileLocations, eventLocations);
      const severity = eventSeverity(eventType, sentence);
      const impactScore = round(severity * locationRelevance);
      impacts.push({
        eventType,
        eventLocations,
        locationRelevance,
        impactScore,
        title: document.title,
        url: document.url,
        evidence: sentence.slice(0, 300),
      });
    }
  }
  const materialImpacts = impacts
    .filter((impact) => impact.locationRelevance >= 0.12)
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, 12);
  const totalRisk = materialImpacts.reduce((sum, impact) => sum + impact.impactScore, 0);
  const score = clamp(50 - totalRisk * 18, 0, 100);
  return {
    symbol: candidate.symbol,
    score: round(score),
    normalized: round(score / 100),
    explanation: materialImpacts.length
      ? 'Local events were weighted by overlap with known offices, retail footprint, customer regions, and supply-chain locations.'
      : 'No material local event overlap was found for the known company footprint.',
    impacts: materialImpacts,
  };
}

function buildDocuments({ news, learned, crawl }) {
  return [
    ...(news.items || []).map((item) => ({ title: item.title, text: item.description, url: item.link || item.url })),
    ...(learned.observations || []).map((item) => ({ title: item.title, text: item.excerpt, url: item.url })),
    ...(crawl?.pages || []).map((page) => ({ title: page.title, text: page.fullText || page.excerpt, url: page.url })),
  ];
}

function persistLocationCrawl({ userId, crawl }) {
  for (const page of crawl?.pages || []) {
    const source = researchSourceRepo.upsert({
      userId,
      url: page.url,
      title: page.title,
      sourceType: 'learned',
      discoveryMethod: page.userData?.type || 'company-location-crawl',
      discoveredFromUrl: page.userData?.discoveredFromUrl,
      tags: ['location-intel', ...page.score.tags].slice(0, 10),
      relevanceScore: Math.min(92, 48 + page.score.relevance * 6),
      credibilityScore: page.userData?.source?.credibility_score || 50,
    });
    researchSourceRepo.recordObservation({
      userId,
      sourceId: source?.id,
      researchRunId: null,
      url: page.url,
      title: page.title,
      excerpt: page.excerpt,
      links: page.links,
      score: {
        relevance: page.score.relevance,
        credibility: source?.credibility_score || 50,
        tags: ['location-intel', ...page.score.tags].slice(0, 10),
        weightedFinancialEvents: page.score.weightedFinancialEvents,
        crawler: 'crawlee-cheerio',
      },
    });
  }
}

function classifyCompanyLocationType(sentence) {
  const lower = sentence.toLowerCase();
  if (/headquarter|based in|corporate office/.test(lower)) return 'headquarters';
  if (/retail|store|location|branch/.test(lower)) return 'retail';
  if (/customer|revenue|sales|market|subscriber|user/.test(lower)) return 'customer_market';
  if (/manufactur|supplier|factory|distribution|warehouse|supply chain/.test(lower)) return 'supply_chain';
  if (/office|campus|facility/.test(lower)) return 'office';
  return 'mentioned';
}

function classifyLocalEventType(sentence) {
  const lower = sentence.toLowerCase();
  if (/\b(war|conflict|invasion|missile|attack|sanction|geopolitical|red sea)\b/.test(lower)) return 'war_geopolitical';
  if (/\b(weather|hurricane|storm|flood|wildfire|earthquake|drought|tornado)\b/.test(lower)) return 'weather_disaster';
  if (/\b(crime|theft|robbery|violence|shoplifting|organized retail crime)\b/.test(lower)) return 'crime';
  if (/\b(housing|mortgage|rent|home sales|building permits|real estate)\b/.test(lower)) return 'housing_rates';
  if (/\b(local news|regional|city|state|province)\b/.test(lower)) return 'regional_news';
  return null;
}

function eventSeverity(eventType, sentence) {
  const lower = sentence.toLowerCase();
  const base = {
    war_geopolitical: 1,
    weather_disaster: 0.85,
    crime: 0.55,
    housing_rates: 0.5,
    regional_news: 0.35,
  }[eventType] || 0.3;
  const multiplier = /\b(severe|major|record|deadly|widespread|surge|crisis|emergency)\b/.test(lower) ? 1.35 : 1;
  return Math.min(1.5, base * multiplier);
}

function extractLocations(value) {
  const text = String(value || '');
  return LOCATION_TERMS.filter((location) => new RegExp(`\\b${escapeRegex(location)}\\b`, 'i').test(text));
}

function scoreLocationOverlap(profileLocations, eventLocations) {
  if (!eventLocations.length) return profileLocations.size ? 0.25 : 0.35;
  if (!profileLocations.size) return 0.35;
  for (const eventLocation of eventLocations) {
    const keys = expandedLocationKeys(canonicalLocation(eventLocation));
    if (keys.some((key) => profileLocations.has(key))) return 1;
  }
  return 0.06;
}

function expandedLocationKeys(location) {
  const canonical = canonicalLocation(location);
  return [canonical, ...(LOCATION_PARENTS[canonical] || [])];
}

function locationTypeWeight(type) {
  return {
    headquarters: 0.95,
    customer_market: 0.9,
    retail: 0.82,
    supply_chain: 0.74,
    office: 0.62,
    mentioned: 0.35,
  }[type] || 0.3;
}

function splitSentences(value) {
  return String(value || '').split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter((item) => item.length >= 18);
}

function canonicalLocation(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function round(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  LOCATION_QUESTION_TEMPLATES,
  buildLocationResearchQueries,
  researchCompanyLocations,
  extractLocationProfile,
  scoreLocalEventRelevance,
  extractLocations,
};
