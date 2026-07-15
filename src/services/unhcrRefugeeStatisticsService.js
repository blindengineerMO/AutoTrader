const { resilientFetch } = require('../utils/resilientFetch');
const UNHCR_REFUGEE_DATA_FINDER_URL = 'https://www.unhcr.org/refugee-statistics/';
const UNHCR_GLOBAL_API_URL = 'https://api.unhcr.org/';
const UNHCR_REFUGEE_STATISTICS_DOCS_URL = 'https://api.unhcr.org/docs/refugee-statistics.html';
const UNHCR_API_BASE_URL = 'https://api.unhcr.org/population/v1';
const UNHCR_POPULATION_URL = `${UNHCR_API_BASE_URL}/population/`;
const UNHCR_COUNTRIES_URL = `${UNHCR_API_BASE_URL}/countries/`;
const UNHCR_YEARS_URL = `${UNHCR_API_BASE_URL}/years/`;
const UNHCR_ASYLUM_APPLICATIONS_URL = `${UNHCR_API_BASE_URL}/asylum-applications/`;
const UNHCR_ASYLUM_DECISIONS_URL = `${UNHCR_API_BASE_URL}/asylum-decisions/`;
const UNHCR_DEMOGRAPHICS_URL = `${UNHCR_API_BASE_URL}/demographics/`;
const UNHCR_SOLUTIONS_URL = `${UNHCR_API_BASE_URL}/solutions/`;
const UNHCR_IDMC_URL = `${UNHCR_API_BASE_URL}/idmc/`;
const UNHCR_UNRWA_URL = `${UNHCR_API_BASE_URL}/unrwa/`;

async function collectRefugeeStatisticsContext({
  timeoutMs = 8000,
  year,
  limit = 500,
  onEvent = () => {},
} = {}) {
  const failures = [];
  const boundedLimit = Math.max(25, Math.min(1000, Number(limit) || 500));
  let years = [];
  let selectedYear = Number(year) || null;
  let aggregate = null;
  let origins = [];
  let hosts = [];
  let countries = [];

  try {
    const payload = await fetchJson(buildUrl(UNHCR_YEARS_URL, { limit: 100, page: 1 }), timeoutMs);
    years = normalizeYears(payload.items || []);
    emit(onEvent, 'unhcr-refugees', 49, 'debug', 'Fetched UNHCR Refugee Statistics available years.', {
      latestAdvertisedYear: years[0] || null,
    });
  } catch (error) {
    failures.push({ source: 'unhcr-years', url: UNHCR_YEARS_URL, error: error.message });
  }

  const candidateYears = selectedYear
    ? [selectedYear]
    : (years.length ? years : recentYears()).slice(0, 8);

  for (const candidateYear of candidateYears) {
    try {
      const payload = await fetchJson(buildUrl(UNHCR_POPULATION_URL, { limit: 10, page: 1, year: candidateYear }), timeoutMs);
      const rows = normalizePopulationRows(payload.items || []);
      if (rows.length) {
        aggregate = rows[0];
        selectedYear = candidateYear;
        break;
      }
    } catch (error) {
      failures.push({ source: 'unhcr-population-aggregate', url: UNHCR_POPULATION_URL, year: candidateYear, error: error.message });
    }
  }

  if (!aggregate) {
    emit(onEvent, 'unhcr-refugees', 49, 'warn', 'UNHCR population aggregate unavailable.', {
      candidateYears,
    });
    return evaluateRefugeeStatisticsContext({ aggregate, origins, hosts, countries, years, failures, selectedYear });
  }

  try {
    const payload = await fetchJson(buildUrl(UNHCR_POPULATION_URL, {
      limit: boundedLimit,
      page: 1,
      year: selectedYear,
      coo_all: true,
    }), timeoutMs);
    origins = normalizePopulationRows(payload.items || [])
      .filter((row) => row.originCode && row.originCode !== '-')
      .sort((a, b) => b.originPressure - a.originPressure)
      .slice(0, 30);
    emit(onEvent, 'unhcr-refugees', 50, 'debug', 'Fetched UNHCR country-of-origin displacement rows.', {
      year: selectedYear,
      rows: origins.length,
    });
  } catch (error) {
    failures.push({ source: 'unhcr-origin-population', url: UNHCR_POPULATION_URL, year: selectedYear, error: error.message });
  }

  try {
    const payload = await fetchJson(buildUrl(UNHCR_POPULATION_URL, {
      limit: boundedLimit,
      page: 1,
      year: selectedYear,
      coa_all: true,
    }), timeoutMs);
    hosts = normalizePopulationRows(payload.items || [])
      .filter((row) => row.hostCode && row.hostCode !== '-')
      .sort((a, b) => b.hostPressure - a.hostPressure)
      .slice(0, 30);
    emit(onEvent, 'unhcr-refugees', 51, 'debug', 'Fetched UNHCR host-country displacement rows.', {
      year: selectedYear,
      rows: hosts.length,
    });
  } catch (error) {
    failures.push({ source: 'unhcr-host-population', url: UNHCR_POPULATION_URL, year: selectedYear, error: error.message });
  }

  try {
    const payload = await fetchJson(buildUrl(UNHCR_COUNTRIES_URL, { limit: 300, page: 1 }), timeoutMs);
    countries = normalizeCountries(payload.items || []);
  } catch (error) {
    failures.push({ source: 'unhcr-countries', url: UNHCR_COUNTRIES_URL, error: error.message });
  }

  return evaluateRefugeeStatisticsContext({ aggregate, origins, hosts, countries, years, failures, selectedYear });
}

function buildUrl(baseUrl, params = {}) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function normalizePopulationRows(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const refugees = number(item.refugees);
    const asylumSeekers = number(item.asylum_seekers);
    const returnedRefugees = number(item.returned_refugees);
    const idps = number(item.idps);
    const returnedIdps = number(item.returned_idps);
    const stateless = number(item.stateless);
    const othersOfConcern = number(item.ooc);
    const otherInternationalProtection = number(item.oip);
    const hostCommunity = number(item.hst);
    const originPressure = refugees + asylumSeekers + idps + othersOfConcern + otherInternationalProtection + hostCommunity;
    const hostPressure = refugees + asylumSeekers + idps + stateless + othersOfConcern + otherInternationalProtection + hostCommunity;
    return {
      year: number(item.year),
      originId: cleanText(item.coo_id),
      originName: cleanText(item.coo_name),
      originCode: cleanText(item.coo),
      originIso: cleanText(item.coo_iso),
      hostId: cleanText(item.coa_id),
      hostName: cleanText(item.coa_name),
      hostCode: cleanText(item.coa),
      hostIso: cleanText(item.coa_iso),
      refugees,
      asylumSeekers,
      returnedRefugees,
      idps,
      returnedIdps,
      stateless,
      othersOfConcern,
      otherInternationalProtection,
      hostCommunity,
      originPressure,
      hostPressure,
      totalPeopleOfConcern: originPressure + stateless,
    };
  }).filter((row) => row.year || row.originName || row.hostName || row.totalPeopleOfConcern > 0);
}

function normalizeCountries(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: cleanText(item.id),
    code: cleanText(item.code),
    iso: cleanText(item.iso),
    iso2: cleanText(item.iso2),
    name: cleanText(item.name || item.nameShort || item.nameLong),
    majorArea: cleanText(item.majorArea),
    region: cleanText(item.region),
  })).filter((item) => item.code || item.iso || item.name);
}

function normalizeYears(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => number(item.year))
    .filter((value) => value > 1900)
    .sort((a, b) => b - a);
}

function evaluateRefugeeStatisticsContext({
  aggregate = null,
  origins = [],
  hosts = [],
  countries = [],
  years = [],
  failures = [],
  selectedYear = null,
} = {}) {
  const totalForcedDisplacement = aggregate
    ? aggregate.refugees + aggregate.asylumSeekers + aggregate.idps + aggregate.othersOfConcern + aggregate.otherInternationalProtection + aggregate.hostCommunity
    : 0;
  const totalPeopleOfConcern = aggregate?.totalPeopleOfConcern || totalForcedDisplacement + (aggregate?.stateless || 0);
  const refugeesAndAsylum = (aggregate?.refugees || 0) + (aggregate?.asylumSeekers || 0);
  const topOriginPressure = origins[0]?.originPressure || 0;
  const topHostPressure = hosts[0]?.hostPressure || 0;
  const originConcentrationPct = totalForcedDisplacement ? Number(((origins.slice(0, 5).reduce((sum, row) => sum + row.originPressure, 0) / totalForcedDisplacement) * 100).toFixed(1)) : null;
  const hostConcentrationPct = totalForcedDisplacement ? Number(((hosts.slice(0, 5).reduce((sum, row) => sum + row.hostPressure, 0) / totalForcedDisplacement) * 100).toFixed(1)) : null;
  const displacementPressureScore = clampScore(20 + Math.log10(Math.max(1, totalForcedDisplacement)) * 7);
  const refugeeAsylumPressureScore = clampScore(22 + Math.log10(Math.max(1, refugeesAndAsylum)) * 7);
  const idpPressureScore = clampScore(20 + Math.log10(Math.max(1, aggregate?.idps || 0)) * 7);
  const statelessnessRiskScore = clampScore(18 + Math.log10(Math.max(1, aggregate?.stateless || 0)) * 7);
  const originConcentrationRiskScore = clampScore(35 + (originConcentrationPct || 0) * 0.7 + Math.log10(Math.max(1, topOriginPressure)) * 2);
  const hostCountryPressureScore = clampScore(35 + (hostConcentrationPct || 0) * 0.7 + Math.log10(Math.max(1, topHostPressure)) * 2);
  const aidDemandScore = clampScore(34 + displacementPressureScore * 0.45 + refugeeAsylumPressureScore * 0.18);
  const shelterInfrastructureDemandScore = clampScore(32 + hostCountryPressureScore * 0.38 + idpPressureScore * 0.22);
  const healthcareDemandScore = clampScore(30 + displacementPressureScore * 0.32 + ((aggregate?.hostCommunity || 0) > 0 ? 8 : 0));
  const logisticsAccessRiskScore = clampScore(30 + hostCountryPressureScore * 0.34 + originConcentrationRiskScore * 0.18);
  const borderPolicyRiskScore = clampScore(28 + refugeeAsylumPressureScore * 0.38 + hostCountryPressureScore * 0.2);
  const momentum = displacementPressureScore >= 78 || hostCountryPressureScore >= 75
    ? 'forced-displacement-risk-elevated'
    : displacementPressureScore >= 55
      ? 'forced-displacement-risk-watch'
      : 'forced-displacement-risk-quiet';

  return {
    available: Boolean(aggregate),
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(),
    failures,
    latestYear: selectedYear || aggregate?.year || years[0] || null,
    years,
    aggregate,
    origins,
    hosts,
    countries,
    countryCount: countries.length,
    topOriginCountries: origins.slice(0, 10),
    topHostCountries: hosts.slice(0, 10),
    totalForcedDisplacement,
    totalPeopleOfConcern,
    refugeesAndAsylum,
    originConcentrationPct,
    hostConcentrationPct,
    displacementPressureScore,
    refugeeAsylumPressureScore,
    idpPressureScore,
    statelessnessRiskScore,
    originConcentrationRiskScore,
    hostCountryPressureScore,
    aidDemandScore,
    shelterInfrastructureDemandScore,
    healthcareDemandScore,
    logisticsAccessRiskScore,
    borderPolicyRiskScore,
    riskScore: displacementPressureScore,
    opportunityScore: Math.max(aidDemandScore, shelterInfrastructureDemandScore),
    momentum,
    narrative: aggregate
      ? `UNHCR ${momentum}: ${formatNumber(totalForcedDisplacement)} forcibly displaced/persons of concern pressure in ${selectedYear || aggregate.year}; refugees/asylum ${formatNumber(refugeesAndAsylum)}, IDPs ${formatNumber(aggregate.idps)}, stateless ${formatNumber(aggregate.stateless)}.`
      : 'UNHCR Refugee Statistics context unavailable or no non-empty population year was returned.',
  };
}

function scoreCandidate({ candidate, refugeeContext }) {
  if (!refugeeContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'UNHCR refugee statistics context unavailable.' };
  }
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const shelterInfra = new Set(['CAT', 'DE', 'URI', 'VMC', 'MLM', 'HD', 'LOW', 'PWR', 'EME', 'XLI']);
  const defenseSecurity = new Set(['LMT', 'RTX', 'NOC', 'GD', 'HII', 'ITA']);
  const healthcare = new Set(['JNJ', 'PFE', 'MRK', 'ABT', 'BAX', 'BDX', 'XLV']);
  const foodStaples = new Set(['ADM', 'BG', 'GIS', 'KHC', 'KR', 'WMT', 'COST', 'SYY']);
  const logisticsTravel = new Set(['FDX', 'UPS', 'DHL', 'UNP', 'CSX', 'NSC', 'DAL', 'UAL', 'AAL', 'JETS']);
  const insurersBanks = new Set(['ALL', 'TRV', 'PGR', 'AIG', 'JPM', 'BAC', 'C', 'XLF']);
  let exposure = 0.26;
  let direction = -0.05;
  let label = 'limited direct forced-displacement exposure';

  if (shelterInfra.has(symbol) || /shelter|construction|infrastructure|temporary housing|materials|rebuild/.test(theme)) {
    exposure = 0.78;
    direction = 0.7;
    label = 'can benefit from shelter, infrastructure, sanitation, and emergency settlement demand';
  } else if (defenseSecurity.has(symbol) || /defense|security|border|aerospace|military/.test(theme)) {
    exposure = 0.74;
    direction = 0.46;
    label = 'can see security, border, and geopolitical risk demand when displacement pressure is elevated';
  } else if (healthcare.has(symbol) || /health|medical|pharma|medicine|sanitation/.test(theme)) {
    exposure = 0.66;
    direction = 0.38;
    label = 'can see health, medicine, sanitation, and public-health demand tied to displaced populations';
  } else if (foodStaples.has(symbol) || /food|grocery|staples|agriculture|meal|nutrition/.test(theme)) {
    exposure = 0.62;
    direction = refugeeContext.aidDemandScore >= 65 ? 0.24 : -0.08;
    label = 'has mixed aid-procurement, food-demand, affordability, and regional supply exposure';
  } else if (logisticsTravel.has(symbol) || /logistics|shipping|airline|travel|rail|freight/.test(theme)) {
    exposure = 0.7;
    direction = -0.46;
    label = 'faces border, access, route, port, travel-demand, and safety disruption risk';
  } else if (insurersBanks.has(symbol) || /insurance|bank|credit|lending|reinsurance/.test(theme)) {
    exposure = 0.58;
    direction = -0.3;
    label = 'faces regional credit, claims, sovereign, and instability exposure where host/origin markets overlap';
  }

  const riskDelta = (refugeeContext.riskScore - 50) / 55;
  const opportunityDelta = (refugeeContext.opportunityScore - 50) / 50;
  const raw = 0.5 + (direction >= 0 ? opportunityDelta * direction : riskDelta * direction) * exposure;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `UNHCR ${refugeeContext.momentum}; ${symbol || 'candidate'} ${label}. Displacement pressure ${refugeeContext.displacementPressureScore}, host-country pressure ${refugeeContext.hostCountryPressureScore}, aid demand ${refugeeContext.aidDemandScore}, shelter/infrastructure demand ${refugeeContext.shelterInfrastructureDemandScore}, logistics/access risk ${refugeeContext.logisticsAccessRiskScore}, border-policy risk ${refugeeContext.borderPolicyRiskScore}.`,
    topOriginCountries: refugeeContext.topOriginCountries?.slice(0, 5) || [],
    topHostCountries: refugeeContext.topHostCountries?.slice(0, 5) || [],
  };
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    fetchedAt: context?.fetchedAt,
    momentum: context?.momentum || 'unavailable',
    latestYear: context?.latestYear || null,
    totals: context?.aggregate ? {
      forcedDisplacement: context.totalForcedDisplacement,
      peopleOfConcern: context.totalPeopleOfConcern,
      refugees: context.aggregate.refugees,
      asylumSeekers: context.aggregate.asylumSeekers,
      idps: context.aggregate.idps,
      stateless: context.aggregate.stateless,
      returnedRefugees: context.aggregate.returnedRefugees,
      returnedIdps: context.aggregate.returnedIdps,
      othersOfConcern: context.aggregate.othersOfConcern,
      otherInternationalProtection: context.aggregate.otherInternationalProtection,
      hostCommunity: context.aggregate.hostCommunity,
    } : null,
    concentration: {
      originTop5Pct: context?.originConcentrationPct ?? null,
      hostTop5Pct: context?.hostConcentrationPct ?? null,
    },
    scores: {
      risk: context?.riskScore || 50,
      displacementPressure: context?.displacementPressureScore || 50,
      refugeeAsylumPressure: context?.refugeeAsylumPressureScore || 50,
      idpPressure: context?.idpPressureScore || 50,
      statelessnessRisk: context?.statelessnessRiskScore || 50,
      originConcentrationRisk: context?.originConcentrationRiskScore || 50,
      hostCountryPressure: context?.hostCountryPressureScore || 50,
      aidDemand: context?.aidDemandScore || 50,
      shelterInfrastructureDemand: context?.shelterInfrastructureDemandScore || 50,
      healthcareDemand: context?.healthcareDemandScore || 50,
      logisticsAccessRisk: context?.logisticsAccessRiskScore || 50,
      borderPolicyRisk: context?.borderPolicyRiskScore || 50,
    },
    topOriginCountries: (context?.topOriginCountries || []).slice(0, 8),
    topHostCountries: (context?.topHostCountries || []).slice(0, 8),
    sources: (context?.sourceList || []).slice(0, 12),
    failures: (context?.failures || []).slice(0, 5),
    narrative: context?.narrative || '',
    bmclUse: 'Use as official UNHCR Refugee Statistics evidence for forced displacement, refugees, asylum seekers, IDPs, stateless populations, origin/host country pressure, aid demand, shelter/infrastructure, healthcare, logistics, and border-policy analysis. Localize against company country exposure before scoring.',
  };
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'application/json',
    'User-Agent': 'AutoTrader UNHCR refugee statistics research bot',
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${url} failed with ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers }, { bucket: 'unhcr', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return [
    { name: 'UNHCR Refugee Data Finder', type: 'unhcr-refugee-data-finder', url: UNHCR_REFUGEE_DATA_FINDER_URL },
    { name: 'UNHCR Global Public API', type: 'unhcr-global-api', url: UNHCR_GLOBAL_API_URL },
    { name: 'UNHCR Refugee Statistics API documentation', type: 'unhcr-refugee-statistics-docs', url: UNHCR_REFUGEE_STATISTICS_DOCS_URL },
    { name: 'UNHCR population endpoint', type: 'unhcr-population-api', url: UNHCR_POPULATION_URL },
    { name: 'UNHCR countries endpoint', type: 'unhcr-countries-api', url: UNHCR_COUNTRIES_URL },
    { name: 'UNHCR years endpoint', type: 'unhcr-years-api', url: UNHCR_YEARS_URL },
    { name: 'UNHCR asylum applications endpoint', type: 'unhcr-asylum-applications-api', url: UNHCR_ASYLUM_APPLICATIONS_URL },
    { name: 'UNHCR asylum decisions endpoint', type: 'unhcr-asylum-decisions-api', url: UNHCR_ASYLUM_DECISIONS_URL },
    { name: 'UNHCR demographics endpoint', type: 'unhcr-demographics-api', url: UNHCR_DEMOGRAPHICS_URL },
    { name: 'UNHCR solutions endpoint', type: 'unhcr-solutions-api', url: UNHCR_SOLUTIONS_URL },
    { name: 'UNHCR IDMC endpoint', type: 'unhcr-idmc-api', url: UNHCR_IDMC_URL },
    { name: 'UNHCR UNRWA endpoint', type: 'unhcr-unrwa-api', url: UNHCR_UNRWA_URL },
  ];
}

function recentYears() {
  const year = new Date().getFullYear();
  return Array.from({ length: 8 }, (_, index) => year - index);
}

function number(value) {
  if (value === '-' || value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampScore(value) {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function emit(onEvent, phase, progress, level, message, data) {
  try {
    onEvent({ phase, progress, level, message, data });
  } catch (_) {
    // status callbacks are best-effort only
  }
}

module.exports = {
  UNHCR_REFUGEE_DATA_FINDER_URL,
  UNHCR_GLOBAL_API_URL,
  UNHCR_REFUGEE_STATISTICS_DOCS_URL,
  UNHCR_API_BASE_URL,
  UNHCR_POPULATION_URL,
  UNHCR_COUNTRIES_URL,
  UNHCR_YEARS_URL,
  UNHCR_ASYLUM_APPLICATIONS_URL,
  UNHCR_ASYLUM_DECISIONS_URL,
  UNHCR_DEMOGRAPHICS_URL,
  UNHCR_SOLUTIONS_URL,
  UNHCR_IDMC_URL,
  UNHCR_UNRWA_URL,
  collectRefugeeStatisticsContext,
  buildUrl,
  normalizePopulationRows,
  normalizeCountries,
  normalizeYears,
  evaluateRefugeeStatisticsContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
