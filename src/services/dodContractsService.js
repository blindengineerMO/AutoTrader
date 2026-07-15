const cheerio = require('cheerio');
const { resilientFetch } = require('../utils/resilientFetch');

const DEFENSE_CONTRACTS_URL = 'https://www.defense.gov/News/Contracts/';
const WAR_CONTRACTS_URL = 'https://www.war.gov/News/Contracts/';
const DOD_CONTRACTS_RSS_URL = 'https://www.war.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=400&Site=945&max=10';
const ANNOUNCEMENT_THRESHOLD_USD = 7_500_000;

async function collectDodContractsContext({
  timeoutMs = 10000,
  limit = 20,
  searchTerms = [],
  includeDetails = true,
  onEvent = () => {},
} = {}) {
  const boundedLimit = clampInt(limit, 1, 80);
  const failures = [];
  const refs = [];

  try {
    const xml = await fetchText(DOD_CONTRACTS_RSS_URL, timeoutMs, 'application/rss+xml,text/xml,*/*');
    refs.push(...parseContractsRss(xml));
    emit(onEvent, 'dod-contracts', 44, 'debug', 'Fetched DoD daily contracts RSS feed.', {
      url: DOD_CONTRACTS_RSS_URL,
      items: refs.length,
    });
  } catch (err) {
    failures.push({ source: 'dod-contracts-rss', url: DOD_CONTRACTS_RSS_URL, error: err.message });
    emit(onEvent, 'dod-contracts', 44, 'warn', 'DoD contracts RSS feed unavailable; continuing with search pages if supplied.', {
      error: err.message,
    });
  }

  for (const term of normalizeStringArray(searchTerms).slice(0, 6)) {
    const url = buildSearchUrl(term);
    try {
      const html = await fetchText(url, timeoutMs);
      refs.push(...parseSearchPage(html, url, term));
      emit(onEvent, 'dod-contracts', 44, 'debug', 'Fetched DoD contracts search page.', { term, url });
    } catch (err) {
      failures.push({ source: 'dod-contracts-search', url, error: err.message });
    }
  }

  const uniqueRefs = dedupeRefs(refs).slice(0, Math.max(boundedLimit, 10));
  const announcements = [];
  if (includeDetails) {
    for (const ref of uniqueRefs.slice(0, Math.min(12, boundedLimit))) {
      try {
        const html = await fetchText(ref.url, timeoutMs);
        announcements.push(parseAnnouncementPage(html, ref));
      } catch (err) {
        failures.push({ source: 'dod-contract-announcement', url: ref.url, error: err.message });
      }
    }
  }
  if (!announcements.length) {
    announcements.push(...uniqueRefs.map((ref) => ({
      title: ref.title,
      url: ref.url,
      publishedAt: ref.publishedAt,
      summary: ref.summary,
      contracts: parseContractParagraphs(ref.summary || ref.title || '', ref),
    })));
  }

  return evaluateDodContractsContext({ announcements, failures, limit: boundedLimit });
}

function parseContractsRss(xml) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const refs = $('item').toArray().map((item) => {
    const node = $(item);
    return {
      title: cleanText(node.find('title').first().text()),
      url: cleanText(node.find('link').first().text() || node.find('guid').first().text()),
      summary: cleanText(node.find('description').first().text()),
      publishedAt: normalizeDate(node.find('pubDate').first().text()),
      sourceType: 'rss',
    };
  }).filter((ref) => ref.url);
  if (refs.length) return refs;

  return String(xml || '').split(/\s+(?=Contracts for\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4}\s+https?:\/\/)/)
    .map((chunk) => {
      const match = chunk.match(/(Contracts for\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s+(https?:\/\/\S+)/);
      return match ? {
        title: cleanText(match[1]),
        url: cleanText(match[2]),
        summary: cleanText(chunk),
        publishedAt: normalizeDate(chunk.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+\w+\s+\d{4}[^h]+GMT\b/)?.[0]),
        sourceType: 'rss-text',
      } : null;
    })
    .filter(Boolean);
}

function parseSearchPage(html, sourceUrl = WAR_CONTRACTS_URL, term = '') {
  const $ = cheerio.load(String(html || ''));
  return $('a[href]').toArray()
    .map((anchor) => ({
      title: cleanText($(anchor).text()),
      url: absolutize($(anchor).attr('href'), sourceUrl),
      summary: `DoD contracts search result for ${term}`,
      sourceType: 'search',
      searchTerm: term,
    }))
    .filter((ref) => /\/News\/Contracts\/Contract\/Article\//i.test(ref.url) && ref.title)
    .slice(0, 20);
}

function parseAnnouncementPage(html, ref = {}) {
  const $ = cheerio.load(String(html || ''));
  $('script, style, noscript, svg').remove();
  const title = cleanText($('h1').first().text() || ref.title);
  const publishedAt = normalizeDate($('time').first().attr('datetime') || $('time').first().text() || ref.publishedAt);
  const paragraphNodes = $('.body p, article p, .news-detail p, #dnn_ctr p, main p').toArray();
  const paragraphs = paragraphNodes.map((p) => cleanText($(p).text())).filter(Boolean);
  const bodyText = paragraphs.length ? paragraphs.join('\n') : cleanText($('main').text() || $('body').text());
  return {
    title,
    url: ref.url,
    publishedAt,
    summary: cleanText(paragraphs.slice(0, 2).join(' ')).slice(0, 600),
    contracts: parseContractParagraphs(bodyText, { ...ref, title, publishedAt }),
  };
}

function parseContractParagraphs(text, source = {}) {
  const normalized = String(text || '').replace(/\r/g, '\n');
  const chunks = normalized.split(/\n+|(?<=\.)\s+(?=[A-Z][A-Za-z0-9&.,'() -]{3,140},\s+[A-Z][A-Za-z .'-]+,\s+(?:is|was|has been)\s+(?:awarded|being awarded))/i)
    .map(cleanText)
    .filter((chunk) => chunk.length > 80 && /\$[\d,.]+|million|billion/i.test(chunk) && /contract|award|modification|agreement|order/i.test(chunk));
  return chunks.map((paragraph) => normalizeContractParagraph(paragraph, source)).filter((item) => item.contractorName || item.awardValue);
}

function normalizeContractParagraph(paragraph, source = {}) {
  const awardValue = parseAwardValue(paragraph);
  const contractorName = extractContractor(paragraph);
  const location = extractContractorLocation(paragraph, contractorName);
  const placeOfPerformance = extractSentenceValue(paragraph, [
    /Work will be performed (?:in|at)\s+(.+?)(?:,\s+and is expected|\s+and is expected)/i,
    /Performance will be (?:in|at)\s+(.+?)(?:,\s+and is expected|\s+and is expected)/i,
    /Work will be performed (?:in|at)\s+([^.]+)\./i,
    /Performance will be (?:in|at)\s+([^.]+)\./i,
  ]);
  const completionDate = extractSentenceValue(paragraph, [
    /(?:expected|estimated) completion date is\s+([^.]+)\./i,
    /is expected to be completed by\s+([^.]+)\./i,
    /work is expected to be completed by\s+([^.]+)\./i,
  ]);
  const fundingSource = extractSentenceContaining(paragraph, /funds|obligated|fiscal \d{4}/i);
  const contractingActivity = cleanText(paragraph.match(/([^.]+?),\s+is the contracting activity\./i)?.[1]);
  const branch = inferBranch([contractingActivity, paragraph].join(' '));
  const contractType = cleanText(paragraph.match(/\b(firm-fixed-price|cost-plus-[a-z-]+|cost-reimbursement|indefinite-delivery\/indefinite-quantity|time-and-materials|multiple-award|fixed-price-incentive)\b/i)?.[1]);
  const productOrService = summarizeProduct(paragraph, awardValue);
  const conflictInference = inferConflictAssociation({ paragraph, placeOfPerformance, contractingActivity });
  return {
    contractorName,
    contractorLocation: location,
    awardValue,
    awardValueText: cleanText(paragraph.match(/\$[\d,.]+\s*(?:million|billion|thousand)?/i)?.[0]),
    contractType,
    productOrService,
    placeOfPerformance,
    completionDate,
    fundingSource,
    contractingActivity,
    branch,
    description: paragraph.slice(0, 900),
    sourceTitle: source.title,
    sourceUrl: source.url,
    publishedAt: source.publishedAt,
    demandType: demandType({ paragraph, branch }),
    conflictInference,
  };
}

function evaluateDodContractsContext({ announcements = [], failures = [], limit = 20 } = {}) {
  const contracts = dedupeContracts(announcements.flatMap((item) => item.contracts || []))
    .sort((a, b) => (b.awardValue || 0) - (a.awardValue || 0))
    .slice(0, clampInt(limit, 1, 80));
  const totalAnnouncedValue = contracts.reduce((sum, contract) => sum + (contract.awardValue || 0), 0);
  const foreignContracts = contracts.filter((contract) => /foreign|outside|ukraine|israel|gaza|iraq|afghanistan|syria|taiwan|poland|germany|japan|korea/i.test([contract.placeOfPerformance, contract.description].join(' ')));
  const innovationContracts = contracts.filter((contract) => /software|cloud|ai|artificial intelligence|drone|unmanned|space|cyber|missile|satellite|semiconductor|critical mineral/i.test(contract.description));
  const topContractors = aggregateBy(contracts, (contract) => contract.contractorName || 'Unknown contractor', 'contractorName');
  const topBranches = aggregateBy(contracts, (contract) => contract.branch || 'Unknown branch', 'branch');
  const topLocations = aggregateBy(contracts, (contract) => contract.placeOfPerformance || contract.contractorLocation || 'Unknown location', 'location');
  const defenseDemandScore = clampScore(42 + Math.log10(Math.max(totalAnnouncedValue, 1)) * 4 + contracts.length * 1.1 - failures.length * 2);
  const foreignExposureScore = clampScore(30 + foreignContracts.length * 7 + average(foreignContracts.map((contract) => Math.log10(Math.max(contract.awardValue || 1, 1)) * 3)));
  const innovationDemandScore = clampScore(38 + innovationContracts.length * 6 + average(innovationContracts.map((contract) => Math.log10(Math.max(contract.awardValue || 1, 1)) * 3)));
  const opportunityScore = clampScore(defenseDemandScore * 0.48 + innovationDemandScore * 0.28 + Math.min(100, Math.log10(Math.max(totalAnnouncedValue, 1)) * 7) * 0.24);
  const riskScore = clampScore(foreignExposureScore * 0.36 + failures.length * 3 + (100 - defenseDemandScore) * 0.14);
  const momentum = innovationDemandScore >= 64 ? 'dod-innovation-contract-demand'
    : defenseDemandScore >= 62 ? 'dod-daily-contract-demand'
      : 'dod-contracts-mixed';

  return {
    available: contracts.length > 0,
    provider: 'dod-daily-contracts',
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(),
    failures,
    announcementCount: announcements.length,
    contractCount: contracts.length,
    totalAnnouncedValue,
    foreignContractCount: foreignContracts.length,
    innovationContractCount: innovationContracts.length,
    defenseDemandScore,
    foreignExposureScore,
    innovationDemandScore,
    opportunityScore,
    riskScore,
    momentum,
    topContractors: topContractors.slice(0, 10),
    topBranches: topBranches.slice(0, 8),
    topLocations: topLocations.slice(0, 8),
    contracts,
    topContracts: contracts.slice(0, 16),
    caveat: `Daily DoD/War.gov contract announcements list contracts valued at or above ${formatUsd(ANNOUNCEMENT_THRESHOLD_USD)} and omit smaller awards. Use USAspending for broader coverage and verify parent-company/ticker mapping plus revenue materiality before trading.`,
    narrative: contracts.length
      ? `DoD daily contracts ${momentum}: ${contracts.length} parsed contract rows across ${announcements.length} announcements, ${formatUsd(totalAnnouncedValue)} in returned announced value, ${innovationContracts.length} innovation/strategic technology signals.`
      : 'DoD daily contract announcements unavailable or no parseable contract rows were found.',
  };
}

function scoreCandidate({ candidate, dodContractsContext }) {
  if (!dodContractsContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, signals: [], explanation: 'DoD daily contracts context unavailable.' };
  }
  const companyName = cleanText(candidate?.companyName || candidate?.name);
  const haystack = [candidate?.symbol, companyName, candidate?.theme, candidate?.sector, ...(candidate?.discovery?.tags || [])].join(' ').toLowerCase();
  const signals = (dodContractsContext.contracts || []).filter((contract) => matchesCandidateContract(contract, { companyName, haystack }));
  const directAmount = signals.reduce((sum, contract) => sum + (contract.awardValue || 0), 0);
  const sectorExposure = candidateDefenseExposure(candidate);
  const directBoost = Math.min(0.34, Math.log10(Math.max(directAmount, 1)) / 42 + signals.length * 0.035);
  const contextBoost = ((dodContractsContext.opportunityScore || 50) - 50) / 175 * sectorExposure;
  const foreignPenalty = ((dodContractsContext.foreignExposureScore || 30) - 50) / 260 * sectorExposure;
  const normalized = clamp01(0.5 + directBoost + contextBoost - Math.max(0, foreignPenalty));
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(Math.max(sectorExposure, signals.length ? 0.68 : 0.1) * 100),
    signals: signals.slice(0, 8).map(compactContract),
    contextOpportunityScore: dodContractsContext.opportunityScore,
    directContractAmount: directAmount,
    explanation: signals.length
      ? `DoD daily contracts found ${signals.length} announcement row(s) for ${companyName || 'candidate'} totaling ${formatUsd(directAmount)} in the returned sample. Use as near-term defense revenue catalyst evidence and verify ticker/parent mapping plus revenue materiality.`
      : `${companyName || 'Candidate'} had no direct DoD daily-contract row in the returned sample; applying sector defense-demand context score ${dodContractsContext.opportunityScore}.`,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'dod-daily-contracts',
    fetchedAt: context.fetchedAt,
    momentum: context.momentum,
    opportunityScore: context.opportunityScore,
    riskScore: context.riskScore,
    defenseDemandScore: context.defenseDemandScore,
    innovationDemandScore: context.innovationDemandScore,
    foreignExposureScore: context.foreignExposureScore,
    announcementCount: context.announcementCount || 0,
    contractCount: context.contractCount || 0,
    totalAnnouncedValue: context.totalAnnouncedValue || 0,
    foreignContractCount: context.foreignContractCount || 0,
    innovationContractCount: context.innovationContractCount || 0,
    topContractors: (context.topContractors || []).slice(0, 8),
    topBranches: (context.topBranches || []).slice(0, 8),
    topLocations: (context.topLocations || []).slice(0, 8),
    topContracts: (context.topContracts || []).slice(0, 8).map(compactContract),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.caveat,
    bmclUse: 'Use as official daily DoD/War.gov major contract-announcement evidence for near-term defense revenue catalysts, contracting activity, product/service demand, place-of-performance, funding-source, completion-date, and strategic technology debate. Announcements are threshold-limited; use USAspending for broader award coverage and verify parent-company/ticker mapping before scoring live trades.',
  };
}

async function fetchText(url, timeoutMs, accept = 'text/html,application/xhtml+xml,*/*') {
  const res = await resilientFetch(url, {
    headers: {
      Accept: accept,
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 AutoTrader DoD contracts research bot; contact=local',
    },
    redirect: 'follow',
  }, {
    bucket: 'dod-contracts',
    perMinute: 35,
    timeoutMs,
    maxRetries: 1,
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

function buildSearchUrl(term) {
  return `${DEFENSE_CONTRACTS_URL}Search/${encodeURIComponent(cleanText(term).toLowerCase())}/`;
}

function parseAwardValue(text) {
  const match = String(text || '').match(/\$([\d,.]+)\s*(billion|million|thousand)?/i);
  if (!match) return 0;
  const base = Number(match[1].replace(/,/g, ''));
  const mult = /billion/i.test(match[2] || '') ? 1e9 : /million/i.test(match[2] || '') ? 1e6 : /thousand/i.test(match[2] || '') ? 1e3 : 1;
  return Number.isFinite(base) ? Math.round(base * mult) : 0;
}

function extractContractor(paragraph) {
  const first = cleanText(paragraph.split(',')[0]);
  if (/^The |^This |^Fiscal |^Work |^Contract |^Award/i.test(first)) return '';
  return first.slice(0, 140);
}

function extractContractorLocation(paragraph, contractorName) {
  if (!contractorName) return '';
  const rest = paragraph.slice(paragraph.indexOf(contractorName) + contractorName.length + 1);
  const match = rest.match(/^\s*([^,.]+,\s+[A-Z][A-Za-z .'-]+)(?:,|\s+is|\s+was|\s+has)/);
  return cleanText(match?.[1]);
}

function extractSentenceValue(paragraph, patterns) {
  for (const pattern of patterns) {
    const value = cleanText(paragraph.match(pattern)?.[1]);
    if (value) return value;
  }
  return '';
}

function extractSentenceContaining(paragraph, pattern) {
  return cleanText(String(paragraph || '').split(/(?<=\.)\s+/).find((sentence) => pattern.test(sentence)));
}

function summarizeProduct(paragraph, awardValue) {
  const afterAmount = String(paragraph || '').split(/\$[\d,.]+\s*(?:billion|million|thousand)?/i)[1] || paragraph;
  return cleanText(afterAmount.replace(/^(?:firm-fixed-price|cost-plus-[a-z-]+|cost-reimbursement|indefinite-delivery\/indefinite-quantity|time-and-materials|multiple-award|fixed-price-incentive)\s+/i, '')).slice(0, 260);
}

function inferBranch(text) {
  if (/navy|naval|marine corps|marines/i.test(text)) return /marine corps|marines/i.test(text) ? 'Marine Corps' : 'Navy';
  if (/air force|space force|space systems|air systems/i.test(text)) return /space force|space systems/i.test(text) ? 'Space Force' : 'Air Force';
  if (/army/i.test(text)) return 'Army';
  if (/defense logistics agency|DLA/i.test(text)) return 'Defense Logistics Agency';
  if (/missile defense agency/i.test(text)) return 'Missile Defense Agency';
  return '';
}

function demandType({ paragraph, branch }) {
  if (/software|cloud|ai|artificial intelligence|cyber|drone|unmanned|space|satellite/i.test(paragraph)) return 'defense-technology-contract-demand';
  if (/missile|munition|weapon|aircraft|ship|combat|radar/i.test(paragraph)) return 'defense-platform-contract-demand';
  if (branch) return 'defense-service-contract-demand';
  return 'defense-contract-demand';
}

function inferConflictAssociation({ paragraph, placeOfPerformance, contractingActivity }) {
  const text = [paragraph, placeOfPerformance, contractingActivity].join(' ').toLowerCase();
  const reasons = [];
  if (/\b(ukraine|israel|gaza|iraq|afghanistan|syria|yemen|iran|taiwan|red sea|somalia|sudan)\b/i.test(text)) reasons.push('announcement references active or recent conflict geography');
  if (/\b(foreign military sales|security assistance|coalition|combat|contingency|munition|missile|weapon)\b/i.test(text)) reasons.push('announcement language indicates foreign military/security or combat-adjacent context');
  return {
    inferred: reasons.length > 0,
    confidence: reasons.length >= 2 ? 'medium' : reasons.length ? 'low' : 'none',
    reasons,
    caveat: reasons.length ? 'Association is inferred from daily contract text and must be verified before attributing the award to a specific war.' : '',
  };
}

function matchesCandidateContract(contract, { companyName, haystack }) {
  const contractor = cleanText(contract.contractorName).toLowerCase();
  const text = [contractor, contract.description, contract.productOrService].join(' ').toLowerCase();
  if (companyName && contractor.includes(companyName.toLowerCase())) return true;
  const tokens = cleanText(companyName).toLowerCase().split(/\s+/).filter((part) => part.length >= 4 && !/inc|corp|corporation|company|systems|technologies|group|llc|ltd|plc|the/.test(part));
  if (tokens.length && tokens.some((token) => contractor.includes(token))) return true;
  if (/(defense|aerospace|military|contractor|shipbuilder|cybersecurity|munition|missile|space|drone|logistics)/i.test(haystack)
    && /(defense|aerospace|military|missile|munition|ship|aircraft|cyber|space|drone|logistics)/i.test(text)) return true;
  return false;
}

function candidateDefenseExposure(candidate = {}) {
  const text = [candidate.symbol, candidate.companyName, candidate.theme, candidate.sector, candidate.industry, ...(candidate.discovery?.tags || [])].join(' ').toLowerCase();
  const terms = ['defense', 'aerospace', 'military', 'contractor', 'shipbuilder', 'cybersecurity', 'munition', 'missile', 'space', 'drone', 'satellite', 'logistics', 'cloud'];
  const hits = terms.filter((term) => text.includes(term)).length;
  return clamp01(0.1 + hits * 0.09);
}

function compactContract(contract = {}) {
  return {
    contractorName: contract.contractorName,
    contractorLocation: contract.contractorLocation,
    awardValue: contract.awardValue,
    contractType: contract.contractType,
    productOrService: contract.productOrService,
    placeOfPerformance: contract.placeOfPerformance,
    completionDate: contract.completionDate,
    fundingSource: contract.fundingSource,
    contractingActivity: contract.contractingActivity,
    branch: contract.branch,
    demandType: contract.demandType,
    sourceTitle: contract.sourceTitle,
    sourceUrl: contract.sourceUrl,
    publishedAt: contract.publishedAt,
    conflictInference: contract.conflictInference,
  };
}

function sourceList() {
  return [
    { name: 'DoD daily contract announcements', type: 'daily-contract-announcements', url: DEFENSE_CONTRACTS_URL },
    { name: 'War.gov current contracts page', type: 'daily-contract-announcements-current', url: WAR_CONTRACTS_URL },
    { name: 'Contract Announcements RSS', type: 'rss', url: DOD_CONTRACTS_RSS_URL },
    { name: 'DoD contract search pattern', type: 'search-pattern', url: `${DEFENSE_CONTRACTS_URL}Search/{keyword}/` },
  ];
}

function dedupeRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = ref.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeContracts(contracts) {
  const seen = new Set();
  return contracts.filter((contract) => {
    const key = [contract.contractorName, contract.awardValue, contract.sourceUrl, contract.productOrService].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function aggregateBy(items, keyFn, keyName) {
  const map = new Map();
  for (const item of items) {
    const key = cleanText(keyFn(item)) || 'Unknown';
    const existing = map.get(key) || { [keyName]: key, contractCount: 0, amount: 0 };
    existing.contractCount += 1;
    existing.amount += item.awardValue || 0;
    map.set(key, existing);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount || b.contractCount - a.contractCount);
}

function absolutize(href, baseUrl = WAR_CONTRACTS_URL) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function normalizeDate(value) {
  const text = cleanText(value);
  if (!text) return '';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : [value]).flatMap((item) => String(item || '').split('|')).map(cleanText).filter(Boolean);
}

function formatUsd(value) {
  const number = Number(value) || 0;
  if (number >= 1e9) return `$${(number / 1e9).toFixed(2)}B`;
  if (number >= 1e6) return `$${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e3) return `$${(number / 1e3).toFixed(1)}K`;
  return `$${number.toFixed(0)}`;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clamp01(value) {
  return clamp(value, 0, 1);
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
  DEFENSE_CONTRACTS_URL,
  WAR_CONTRACTS_URL,
  DOD_CONTRACTS_RSS_URL,
  ANNOUNCEMENT_THRESHOLD_USD,
  collectDodContractsContext,
  parseContractsRss,
  parseSearchPage,
  parseAnnouncementPage,
  parseContractParagraphs,
  normalizeContractParagraph,
  evaluateDodContractsContext,
  scoreCandidate,
  compactForBmcl,
  buildSearchUrl,
  sourceList,
};
