const { resilientFetch } = require('../utils/resilientFetch');

const USASPENDING_BASE_URL = 'https://api.usaspending.gov';
const USASPENDING_AWARD_SEARCH_URL = `${USASPENDING_BASE_URL}/api/v2/search/spending_by_award/`;
const USASPENDING_AWARD_COUNT_URL = `${USASPENDING_BASE_URL}/api/v2/search/spending_by_award_count/`;
const CONTRACT_AWARD_TYPE_CODES = ['A', 'B', 'C', 'D'];

const DEFAULT_FIELDS = [
  'Award ID',
  'Recipient Name',
  'Award Amount',
  'Start Date',
  'End Date',
  'Awarding Agency',
  'Awarding Sub Agency',
  'Funding Agency',
  'Funding Sub Agency',
  'Award Type',
  'Contract Award Type',
  'Description',
  'Place of Performance Country Code',
  'Place of Performance State Code',
  'Place of Performance City',
  'PSC',
  'NAICS',
];

async function collectFederalAwardsContext({
  timeoutMs = 10000,
  limit = 25,
  page = 1,
  dateRange,
  recipientNames,
  awardingAgency,
  fundingAgency,
  awardType = 'contracts',
  placeOfPerformanceCountry,
  pscCodes,
  naicsCodes,
  keywords,
  includeCounts = true,
  onEvent = () => {},
} = {}) {
  const boundedLimit = clampInt(limit, 1, 100);
  const request = buildAwardSearchRequest({
    limit: boundedLimit,
    page,
    dateRange,
    recipientNames,
    awardingAgency,
    fundingAgency,
    awardType,
    placeOfPerformanceCountry,
    pscCodes,
    naicsCodes,
    keywords,
  });

  const failures = [];
  let awards = [];
  let total = null;
  try {
    const response = await postJson(USASPENDING_AWARD_SEARCH_URL, request, timeoutMs);
    awards = normalizeAwards(response.results || response.awards || []);
    total = Number.isFinite(Number(response.page_metadata?.total)) ? Number(response.page_metadata.total) : null;
    emit(onEvent, 'usaspending-awards', 43, 'debug', 'Fetched USAspending federal award rows.', {
      returned: awards.length,
      total,
      filters: summarizeRequestFilters(request.filters),
    });
  } catch (err) {
    failures.push({ source: 'usaspending-award-search', url: USASPENDING_AWARD_SEARCH_URL, error: err.message });
    emit(onEvent, 'usaspending-awards', 43, 'warn', 'USAspending award search unavailable; continuing with empty federal awards context.', {
      error: err.message,
    });
  }

  let awardTypeCounts = [];
  if (includeCounts) {
    try {
      const countRequest = { filters: request.filters };
      const countResponse = await postJson(USASPENDING_AWARD_COUNT_URL, countRequest, timeoutMs);
      awardTypeCounts = normalizeAwardCounts(countResponse.results || countResponse);
    } catch (err) {
      failures.push({ source: 'usaspending-award-count', url: USASPENDING_AWARD_COUNT_URL, error: err.message });
    }
  }

  return evaluateFederalAwardsContext({
    awards,
    total,
    failures,
    awardTypeCounts,
    request,
  });
}

function buildAwardSearchRequest({
  limit = 25,
  page = 1,
  dateRange,
  recipientNames,
  awardingAgency,
  fundingAgency,
  awardType = 'contracts',
  placeOfPerformanceCountry,
  pscCodes,
  naicsCodes,
  keywords,
} = {}) {
  const filters = {};
  const range = normalizeDateRange(dateRange);
  if (range) filters.time_period = [range];
  const recipientSearch = normalizeStringArray(recipientNames);
  if (recipientSearch.length) filters.recipient_search_text = recipientSearch;
  if (cleanText(awardingAgency)) filters.agencies = [...(filters.agencies || []), agencyFilter('awarding', awardingAgency)];
  if (cleanText(fundingAgency)) filters.agencies = [...(filters.agencies || []), agencyFilter('funding', fundingAgency)];
  const typeCodes = awardTypeCodes(awardType);
  if (typeCodes.length) filters.award_type_codes = typeCodes;
  const country = normalizeCountry(placeOfPerformanceCountry);
  if (country) filters.place_of_performance_locations = [{ country }];
  const psc = normalizeStringArray(pscCodes).map((code) => code.toUpperCase());
  if (psc.length) filters.psc_codes = psc;
  const naics = normalizeStringArray(naicsCodes).map((code) => code.replace(/\D/g, '')).filter(Boolean);
  if (naics.length) filters.naics_codes = naics;
  const searchText = normalizeStringArray(keywords).join(' ').trim();
  if (searchText) filters.keywords = [searchText];

  return {
    filters,
    fields: DEFAULT_FIELDS,
    page: clampInt(page, 1, 10000),
    limit: clampInt(limit, 1, 100),
    sort: 'Award Amount',
    order: 'desc',
    subawards: false,
  };
}

function evaluateFederalAwardsContext({
  awards = [],
  total = null,
  failures = [],
  awardTypeCounts = [],
  request = {},
} = {}) {
  const normalized = dedupeAwards(awards);
  const totalObligated = normalized.reduce((sum, award) => sum + (award.amount || 0), 0);
  const defenseAwards = normalized.filter(isDefenseAward);
  const militaryAwards = normalized.filter(isMilitaryAward);
  const infrastructureAwards = normalized.filter(isInfrastructureAward);
  const inferredConflictAwards = normalized.map(inferConflictAssociation).filter((award) => award.conflictInference.inferred);
  const topRecipients = aggregateBy(normalized, (award) => award.recipientName || 'Unknown recipient', 'recipientName');
  const topCountries = aggregateBy(normalized, (award) => award.placeOfPerformanceCountry || 'Unknown country', 'country');
  const topAgencies = aggregateBy(normalized, (award) => award.awardingAgency || 'Unknown agency', 'agency');
  const governmentDemandScore = clampScore(42 + Math.log10(Math.max(totalObligated, 1)) * 4 + normalized.length * 0.8 + topRecipients.length * 0.8 - failures.length * 2);
  const defenseDemandScore = clampScore(38 + defenseAwards.length * 4 + militaryAwards.length * 3 + average(defenseAwards.map((award) => Math.log10(Math.max(award.amount || 1, 1)) * 4)));
  const infrastructureDemandScore = clampScore(38 + infrastructureAwards.length * 4 + average(infrastructureAwards.map((award) => Math.log10(Math.max(award.amount || 1, 1)) * 3)));
  const conflictExposureScore = clampScore(30 + inferredConflictAwards.length * 7);
  const opportunityScore = clampScore(governmentDemandScore * 0.38 + defenseDemandScore * 0.24 + infrastructureDemandScore * 0.2 + Math.min(100, Math.log10(Math.max(totalObligated, 1)) * 7) * 0.18);
  const riskScore = clampScore(conflictExposureScore * 0.42 + failures.length * 4 + (100 - governmentDemandScore) * 0.12);
  const momentum = defenseDemandScore >= 62 ? 'federal-defense-contract-demand'
    : infrastructureDemandScore >= 62 ? 'federal-infrastructure-contract-demand'
      : opportunityScore >= 60 ? 'federal-award-demand'
        : 'federal-award-mixed';

  return {
    available: normalized.length > 0,
    provider: 'usaspending',
    fetchedAt: new Date().toISOString(),
    endpoint: USASPENDING_AWARD_SEARCH_URL,
    sourceList: sourceList(),
    request: compactRequest(request),
    failures,
    returnedAwardCount: normalized.length,
    totalMatchingAwards: total,
    totalObligated,
    awardTypeCounts,
    defenseAwardCount: defenseAwards.length,
    militaryAwardCount: militaryAwards.length,
    infrastructureAwardCount: infrastructureAwards.length,
    inferredConflictAwardCount: inferredConflictAwards.length,
    governmentDemandScore,
    defenseDemandScore,
    infrastructureDemandScore,
    conflictExposureScore,
    opportunityScore,
    riskScore,
    momentum,
    topRecipients: topRecipients.slice(0, 10),
    topCountries: topCountries.slice(0, 10),
    topAgencies: topAgencies.slice(0, 10),
    awards: normalized,
    topAwards: normalized.slice(0, 20),
    inferredConflictAwards: inferredConflictAwards.slice(0, 12),
    caveat: 'USAspending federal awards are official public spending records. A contract is not automatically tied to one specific war; conflict/war associations must be labeled as inferred from place of performance, award description, contracting command, PSC/NAICS, appropriation context, task order, or budget documents.',
    narrative: normalized.length
      ? `USAspending ${momentum}: ${normalized.length} award rows, ${formatUsd(totalObligated)} total in returned obligations, ${defenseAwards.length} defense/military signals, ${inferredConflictAwards.length} inferred conflict-context awards.`
      : 'USAspending federal award context unavailable or empty for the selected filters.',
  };
}

function scoreCandidate({ candidate, awardsContext }) {
  if (!awardsContext?.available) {
    return {
      normalized: 0.5,
      compositeScore: 50,
      exposure: 0,
      signals: [],
      explanation: 'USAspending federal awards context unavailable.',
    };
  }
  const symbol = cleanSymbol(candidate?.symbol);
  const companyName = cleanText(candidate?.companyName || candidate?.name);
  const haystack = [symbol, companyName, candidate?.theme, candidate?.sector, ...(candidate?.discovery?.tags || [])].join(' ').toLowerCase();
  const signals = (awardsContext.awards || []).filter((award) => matchesCandidateAward(award, { companyName, haystack }));
  const directAmount = signals.reduce((sum, award) => sum + (award.amount || 0), 0);
  const sectorExposure = candidateGovernmentExposure(candidate);
  const directBoost = Math.min(0.36, Math.log10(Math.max(directAmount, 1)) / 40 + signals.length * 0.035);
  const contextBoost = ((awardsContext.opportunityScore || 50) - 50) / 180 * sectorExposure;
  const conflictPenalty = ((awardsContext.conflictExposureScore || 30) - 50) / 240 * sectorExposure;
  const normalized = clamp01(0.5 + directBoost + contextBoost - Math.max(0, conflictPenalty));
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(Math.max(sectorExposure, signals.length ? 0.65 : 0.1) * 100),
    signals: signals.slice(0, 8).map(compactAward),
    contextOpportunityScore: awardsContext.opportunityScore,
    directAwardAmount: directAmount,
    explanation: signals.length
      ? `USAspending found ${signals.length} federal award row(s) for ${companyName || symbol || 'candidate'} totaling ${formatUsd(directAmount)} in the returned sample. Treat this as government-demand evidence; verify parent-company mapping, contract scope, and revenue materiality before trading.`
      : `${companyName || symbol || 'Candidate'} had no direct USAspending recipient hit in the returned sample; applying sector government-demand context score ${awardsContext.opportunityScore}.`,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'usaspending',
    fetchedAt: context.fetchedAt,
    momentum: context.momentum,
    opportunityScore: context.opportunityScore,
    riskScore: context.riskScore,
    governmentDemandScore: context.governmentDemandScore,
    defenseDemandScore: context.defenseDemandScore,
    infrastructureDemandScore: context.infrastructureDemandScore,
    conflictExposureScore: context.conflictExposureScore,
    returnedAwardCount: context.returnedAwardCount || 0,
    totalMatchingAwards: context.totalMatchingAwards,
    totalObligated: context.totalObligated || 0,
    defenseAwardCount: context.defenseAwardCount || 0,
    inferredConflictAwardCount: context.inferredConflictAwardCount || 0,
    topRecipients: (context.topRecipients || []).slice(0, 8),
    topCountries: (context.topCountries || []).slice(0, 8),
    topAgencies: (context.topAgencies || []).slice(0, 8),
    topAwards: (context.topAwards || []).slice(0, 8).map(compactAward),
    inferredConflictAwards: (context.inferredConflictAwards || []).slice(0, 6).map(compactAward),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.caveat,
    bmclUse: 'Use as official USAspending federal award and contract evidence for government-demand, defense, infrastructure, agency-budget, contractor, place-of-performance, PSC/NAICS, and recipient revenue-catalyst debate. Clearly label war/conflict relationships as inferred unless independently verified by contract documents, place of performance, contracting command, appropriation, task order, or budget records.',
  };
}

function normalizeAwards(rows = []) {
  return rows.map((row) => {
    const get = (...keys) => firstDefined(...keys.map((key) => row[key]));
    const amount = parseMoney(get('Award Amount', 'award_amount', 'generated_unique_award_id', 'total_obligation'));
    const raw = {
      id: cleanText(get('Award ID', 'award_id', 'generated_unique_award_id')),
      recipientName: cleanText(get('Recipient Name', 'recipient_name')),
      amount,
      startDate: normalizeDate(get('Start Date', 'start_date', 'period_of_performance_start_date')),
      endDate: normalizeDate(get('End Date', 'end_date', 'period_of_performance_current_end_date')),
      awardingAgency: cleanText(get('Awarding Agency', 'awarding_agency')),
      awardingSubAgency: cleanText(get('Awarding Sub Agency', 'awarding_subagency')),
      fundingAgency: cleanText(get('Funding Agency', 'funding_agency')),
      fundingSubAgency: cleanText(get('Funding Sub Agency', 'funding_subagency')),
      awardType: cleanText(get('Award Type', 'award_type')),
      contractAwardType: cleanText(get('Contract Award Type', 'contract_award_type')),
      description: cleanText(get('Description', 'description')),
      placeOfPerformanceCountry: cleanText(get('Place of Performance Country Code', 'place_of_performance_country_code', 'place_of_performance_country')),
      placeOfPerformanceState: cleanText(get('Place of Performance State Code', 'place_of_performance_state_code')),
      placeOfPerformanceCity: cleanText(get('Place of Performance City', 'place_of_performance_city_name')),
      psc: cleanText(get('PSC', 'product_or_service_code')),
      naics: cleanText(get('NAICS', 'naics_code')),
    };
    const inferred = inferConflictAssociation(raw);
    return {
      ...raw,
      sourceUrl: raw.id ? `https://www.usaspending.gov/award/${encodeURIComponent(raw.id)}` : 'https://www.usaspending.gov/search',
      demandType: demandType(raw),
      conflictInference: inferred.conflictInference,
    };
  }).filter((award) => award.id || award.recipientName || award.amount || award.description);
}

function inferConflictAssociation(award = {}) {
  const text = [
    award.description,
    award.awardingAgency,
    award.awardingSubAgency,
    award.fundingAgency,
    award.fundingSubAgency,
    award.placeOfPerformanceCountry,
    award.psc,
  ].join(' ').toLowerCase();
  const reasons = [];
  if (/\b(afghanistan|iraq|ukraine|syria|yemen|israel|gaza|iran|somalia|sudan|red sea)\b/i.test(text)) reasons.push('place/description references active or recent conflict geography');
  if (/\b(contingency|operation|combat|munition|missile|weapon|ammunition|defense|military|army|navy|air force|space force|marine corps)\b/i.test(text)) reasons.push('description/agency/PSC indicates military or defense context');
  if (/\bDepartment of Defense|defense logistics|army|navy|air force|marine corps|space force\b/i.test([award.awardingAgency, award.awardingSubAgency, award.fundingAgency, award.fundingSubAgency].join(' '))) reasons.push('awarding or funding organization is defense/military');
  return {
    ...award,
    conflictInference: {
      inferred: reasons.length > 0,
      confidence: reasons.length >= 2 ? 'medium' : reasons.length ? 'low' : 'none',
      reasons,
      caveat: reasons.length
        ? 'Association is inferred from USAspending metadata and must be verified before attributing the award to a specific war.'
        : '',
    },
  };
}

function compactAward(award = {}) {
  return {
    id: award.id,
    recipientName: award.recipientName,
    amount: award.amount,
    startDate: award.startDate,
    endDate: award.endDate,
    awardingAgency: award.awardingAgency,
    fundingAgency: award.fundingAgency,
    placeOfPerformanceCountry: award.placeOfPerformanceCountry,
    placeOfPerformanceState: award.placeOfPerformanceState,
    psc: award.psc,
    naics: award.naics,
    demandType: award.demandType,
    description: cleanText(award.description).slice(0, 220),
    sourceUrl: award.sourceUrl,
    conflictInference: award.conflictInference,
  };
}

async function postJson(url, body, timeoutMs) {
  const res = await resilientFetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'AutoTrader USAspending research bot; contact=local',
    },
    body: JSON.stringify(body),
  }, {
    bucket: 'usaspending',
    perMinute: 45,
    timeoutMs,
    maxRetries: 1,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${url} failed with ${res.status}${text ? `: ${text.slice(0, 240)}` : ''}`);
  }
  return res.json();
}

function normalizeAwardCounts(value) {
  const rows = Array.isArray(value) ? value : Object.entries(value || {}).map(([key, count]) => ({ awardType: key, count }));
  return rows.map((row) => ({
    awardType: cleanText(row.awardType || row.award_type || row.type || row.label || row.name),
    count: Number(row.count || row.value || row.total) || 0,
  })).filter((row) => row.awardType || row.count);
}

function aggregateBy(items, keyFn, keyName) {
  const map = new Map();
  for (const item of items) {
    const key = cleanText(keyFn(item)) || 'Unknown';
    const existing = map.get(key) || { [keyName]: key, awardCount: 0, amount: 0 };
    existing.awardCount += 1;
    existing.amount += item.amount || 0;
    map.set(key, existing);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount || b.awardCount - a.awardCount);
}

function matchesCandidateAward(award, { companyName, haystack }) {
  const recipient = cleanText(award.recipientName).toLowerCase();
  const text = [recipient, award.description, award.awardingAgency, award.fundingAgency].join(' ').toLowerCase();
  if (companyName && recipient.includes(companyName.toLowerCase())) return true;
  const tokens = cleanText(companyName).toLowerCase().split(/\s+/).filter((part) => part.length >= 4 && !/inc|corp|corporation|company|holdings|group|llc|ltd|plc|the/.test(part));
  if (tokens.length && tokens.some((token) => recipient.includes(token))) return true;
  if (/(defense|aerospace|infrastructure|construction|shipbuilder|cybersecurity|government|federal|contractor|munition|missile|logistics)/i.test(haystack)
    && /(defense|aerospace|infrastructure|construction|cyber|logistics|munition|missile|ship|weapon)/i.test(text)) return true;
  return false;
}

function candidateGovernmentExposure(candidate = {}) {
  const text = [candidate.symbol, candidate.companyName, candidate.theme, candidate.sector, candidate.industry, ...(candidate.discovery?.tags || [])].join(' ').toLowerCase();
  const terms = ['defense', 'aerospace', 'military', 'government', 'federal', 'contractor', 'infrastructure', 'construction', 'cybersecurity', 'shipbuilder', 'logistics', 'healthcare', 'energy', 'telecom', 'cloud'];
  const hits = terms.filter((term) => text.includes(term)).length;
  return clamp01(0.12 + hits * 0.09);
}

function sourceList() {
  return [
    { name: 'USAspending.gov', type: 'federal-awards-search', url: 'https://www.usaspending.gov/' },
    { name: 'USAspending Advanced Award Search', type: 'advanced-award-search', url: 'https://www.usaspending.gov/search' },
    { name: 'USAspending API endpoint documentation', type: 'api-docs', url: 'https://api.usaspending.gov/docs/endpoints' },
    { name: 'USAspending award search API', type: 'api', url: USASPENDING_AWARD_SEARCH_URL },
  ];
}

function compactRequest(request = {}) {
  return {
    filters: summarizeRequestFilters(request.filters || {}),
    limit: request.limit,
    page: request.page,
    sort: request.sort,
    order: request.order,
  };
}

function summarizeRequestFilters(filters = {}) {
  return {
    timePeriod: filters.time_period,
    recipientSearchText: filters.recipient_search_text,
    agencies: filters.agencies,
    awardTypeCodes: filters.award_type_codes,
    placeOfPerformanceLocations: filters.place_of_performance_locations,
    pscCodes: filters.psc_codes,
    naicsCodes: filters.naics_codes,
    keywords: filters.keywords,
  };
}

function agencyFilter(type, name) {
  return {
    type,
    tier: 'toptier',
    name: cleanText(name),
  };
}

function awardTypeCodes(awardType) {
  const normalized = cleanText(awardType).toLowerCase();
  if (!normalized || normalized === 'contracts' || normalized === 'contract') return CONTRACT_AWARD_TYPE_CODES;
  if (normalized === 'all') return [];
  if (Array.isArray(awardType)) return awardType.map((code) => cleanText(code).toUpperCase()).filter(Boolean);
  return normalizeStringArray(awardType).map((code) => code.toUpperCase());
}

function demandType(award = {}) {
  if (isDefenseAward(award) || isMilitaryAward(award)) return 'defense-government-demand';
  if (isInfrastructureAward(award)) return 'infrastructure-government-demand';
  return 'federal-government-demand';
}

function isDefenseAward(award = {}) {
  return /defense|army|navy|air force|marine corps|space force|dod|military/i.test([award.awardingAgency, award.awardingSubAgency, award.fundingAgency, award.fundingSubAgency, award.description, award.psc].join(' '));
}

function isMilitaryAward(award = {}) {
  return /munition|weapon|missile|aircraft|ship|combat|logistics|base|tactical|radar|aerospace|defense/i.test([award.description, award.psc, award.naics].join(' '));
}

function isInfrastructureAward(award = {}) {
  return /construction|highway|bridge|infrastructure|engineering|facility|building|transportation|utility|water|energy grid/i.test([award.description, award.psc, award.naics].join(' '));
}

function dedupeAwards(awards) {
  const seen = new Set();
  return awards.filter((award) => {
    const key = [award.id, award.recipientName, award.amount, award.startDate].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeDateRange(dateRange) {
  if (!dateRange) return null;
  const start = normalizeDate(dateRange.start || dateRange.startDate || dateRange.from);
  const end = normalizeDate(dateRange.end || dateRange.endDate || dateRange.to);
  if (!start || !end) return null;
  return { start_date: start, end_date: end };
}

function normalizeDate(value) {
  const text = cleanText(value);
  if (!text) return '';
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toISOString().slice(0, 10);
}

function normalizeCountry(value) {
  const text = cleanText(value).toUpperCase();
  if (!text) return '';
  if (text === 'UNITED STATES') return 'USA';
  if (text === 'AFGHANISTAN') return 'AFG';
  return text.length === 2 || text.length === 3 ? text : text.slice(0, 3);
}

function parseMoney(value) {
  if (Number.isFinite(value)) return Number(value);
  const text = String(value || '').replace(/[$,]/g, '').trim();
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
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

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : [value]).flatMap((item) => String(item || '').split('|')).map(cleanText).filter(Boolean);
}

function cleanSymbol(value) {
  const symbol = cleanText(value).toUpperCase().replace(/[^A-Z0-9.-]/g, '');
  return /^[A-Z][A-Z0-9.-]{0,7}$/.test(symbol) ? symbol : '';
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
  USASPENDING_BASE_URL,
  USASPENDING_AWARD_SEARCH_URL,
  USASPENDING_AWARD_COUNT_URL,
  CONTRACT_AWARD_TYPE_CODES,
  DEFAULT_FIELDS,
  collectFederalAwardsContext,
  buildAwardSearchRequest,
  normalizeAwards,
  inferConflictAssociation,
  evaluateFederalAwardsContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
