const { resilientFetch } = require('../utils/resilientFetch');
const EMDAT_HOME_URL = 'https://www.emdat.be/';
const EMDAT_PUBLIC_PORTAL_URL = 'https://public.emdat.be/';
const EMDAT_DOCS_URL = 'https://doc.emdat.be/';
const EMDAT_HDX_ORG_URL = 'https://data.humdata.org/organization/cred';
const EMDAT_HDX_PACKAGE_SEARCH_URL = 'https://data.humdata.org/api/3/action/package_search?fq=organization:cred&q=EM-DAT&rows=25';
const EMDAT_HDX_ORG_API_URL = 'https://data.humdata.org/api/3/action/organization_show?id=cred&include_datasets=true';

async function collectHistoricalDisasterContext({ timeoutMs = 8000, limit = 25, onEvent = () => {} } = {}) {
  const failures = [];
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  let datasets = [];
  let organization = null;

  try {
    const data = await fetchJson(packageSearchUrl(boundedLimit), timeoutMs);
    datasets = normalizeHdxPackages(data?.result?.results || []);
    emit(onEvent, 'emdat-historical-disasters', 39, 'debug', 'Fetched EM-DAT/CRED dataset inventory from HDX.', {
      datasets: datasets.length,
    });
  } catch (error) {
    failures.push({ source: 'emdat-hdx-package-search', url: packageSearchUrl(boundedLimit), error: error.message });
    emit(onEvent, 'emdat-historical-disasters', 39, 'warn', 'EM-DAT/CRED HDX package search unavailable.', {
      error: error.message,
    });
  }

  try {
    const data = await fetchJson(EMDAT_HDX_ORG_API_URL, timeoutMs);
    organization = normalizeOrganization(data?.result);
    emit(onEvent, 'emdat-historical-disasters', 39, 'debug', 'Fetched CRED organization metadata from HDX.', {
      name: organization?.name,
      datasetCount: organization?.packageCount,
    });
  } catch (error) {
    failures.push({ source: 'emdat-hdx-organization', url: EMDAT_HDX_ORG_API_URL, error: error.message });
    emit(onEvent, 'emdat-historical-disasters', 39, 'warn', 'CRED HDX organization metadata unavailable.', {
      error: error.message,
    });
  }

  return evaluateHistoricalDisasterContext({ datasets, organization, failures });
}

function normalizeHdxPackages(packages = []) {
  return packages.map((item) => ({
    id: cleanText(item.id),
    name: cleanText(item.name),
    title: cleanText(item.title || item.name),
    notes: cleanText(item.notes).slice(0, 1200),
    url: cleanText(item.url || `${EMDAT_HDX_ORG_URL}/dataset/${item.name || item.id}`),
    datasetDate: normalizeDatasetDate(item.dataset_date),
    lastModified: cleanText(item.metadata_modified || item.last_modified || item.revision_timestamp),
    updateFrequency: cleanText(item.data_update_frequency),
    datasetSource: cleanText(item.dataset_source),
    licenseId: cleanText(item.license_id),
    licenseTitle: cleanText(item.license_title),
    licenseOther: cleanText(item.license_other).slice(0, 700),
    isOpen: Boolean(item.isopen),
    resources: (item.resources || []).slice(0, 8).map((resource) => ({
      id: cleanText(resource.id),
      name: cleanText(resource.name),
      format: cleanText(resource.format),
      url: cleanText(resource.url),
      mimetype: cleanText(resource.mimetype || resource.mimetype_inner),
      size: Number(resource.size) || null,
      lastModified: cleanText(resource.last_modified || resource.revision_timestamp),
    })).filter((resource) => resource.name || resource.url),
  })).filter((item) => item.id || item.name || item.title);
}

function normalizeOrganization(value = {}) {
  if (!value) return null;
  return {
    id: cleanText(value.id),
    name: cleanText(value.name),
    title: cleanText(value.title || value.display_name),
    description: cleanText(value.description).slice(0, 800),
    url: cleanText(value.url || EMDAT_HDX_ORG_URL),
    packageCount: Number(value.package_count || value.packages?.length || 0),
  };
}

function evaluateHistoricalDisasterContext({ datasets = [], organization = null, failures = [] } = {}) {
  const text = datasets.map((dataset) => `${dataset.title} ${dataset.notes} ${dataset.licenseOther} ${dataset.resources.map((resource) => resource.name).join(' ')}`).join(' ').toLowerCase();
  const disasterTypeSignals = {
    flood: keywordScore(text, ['flood']),
    storm: keywordScore(text, ['storm', 'cyclone', 'hurricane', 'typhoon']),
    earthquake: keywordScore(text, ['earthquake', 'seismic']),
    drought: keywordScore(text, ['drought']),
    wildfire: keywordScore(text, ['wildfire', 'wild fire']),
    extremeTemperature: keywordScore(text, ['extreme temperature', 'heat wave', 'cold wave']),
    landslide: keywordScore(text, ['landslide']),
    volcanic: keywordScore(text, ['volcano', 'volcanic']),
    technological: keywordScore(text, ['technological', 'industrial accident', 'transport accident']),
    disease: keywordScore(text, ['epidemic', 'disease', 'pandemic']),
  };
  const impactSignal = keywordScore(text, ['death', 'fatalit', 'injur', 'affected', 'displaced', 'homeless', 'damage', 'economic loss', 'losses']);
  const economicLossSignal = keywordScore(text, ['economic damage', 'economic loss', 'damage', 'losses', 'insured']);
  const humanImpactSignal = keywordScore(text, ['death', 'fatalit', 'injur', 'affected', 'displaced', 'homeless']);
  const assistanceSignal = keywordScore(text, ['international assistance', 'assistance', 'appeal']);
  const registeredAccessRequired = datasets.some((dataset) => !dataset.isOpen || /register|registration|login|terms|non-commercial|usage terms/i.test(dataset.licenseOther));
  const latestModified = datasets.map((dataset) => dataset.lastModified).filter(Boolean).sort().pop() || null;
  const latestPeriod = datasets.map((dataset) => dataset.datasetDate.end || dataset.datasetDate.start).filter(Boolean).sort().pop() || latestModified;
  const historicalImpactModelingScore = clampScore(34 + datasets.length * 3 + impactSignal * 5);
  const economicLossModelingScore = clampScore(35 + economicLossSignal * 8 + datasets.length * 2);
  const humanImpactModelingScore = clampScore(35 + humanImpactSignal * 7 + assistanceSignal * 2);
  const climateRiskBacktestScore = clampScore(34 + disasterTypeSignals.flood * 5 + disasterTypeSignals.storm * 5 + disasterTypeSignals.drought * 4 + disasterTypeSignals.wildfire * 4);
  const dataAccessFrictionScore = clampScore(registeredAccessRequired ? 62 : 28);
  const momentum = historicalImpactModelingScore >= 70 ? 'historical-disaster-impact-modeling-strong'
    : historicalImpactModelingScore >= 45 ? 'historical-disaster-impact-modeling-available'
      : 'historical-disaster-impact-modeling-limited';

  return {
    available: datasets.length > 0,
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(),
    failures,
    organization,
    datasets,
    datasetCount: datasets.length,
    latestModified,
    latestPeriod,
    registeredAccessRequired,
    disasterTypeSignals,
    historicalImpactModelingScore,
    economicLossModelingScore,
    humanImpactModelingScore,
    climateRiskBacktestScore,
    dataAccessFrictionScore,
    riskScore: Math.round((historicalImpactModelingScore + economicLossModelingScore + humanImpactModelingScore) / 3),
    opportunityScore: clampScore(42 + datasets.length * 2 + climateRiskBacktestScore * 0.28),
    momentum,
    narrative: datasets.length
      ? `EM-DAT/CRED ${momentum}: ${datasets.length} public HDX dataset records for historical disaster impact modeling; economic-loss score ${economicLossModelingScore}, human-impact score ${humanImpactModelingScore}, access-friction score ${dataAccessFrictionScore}.`
      : 'EM-DAT/CRED historical disaster context unavailable from public HDX discovery.',
  };
}

function scoreCandidate({ candidate, historicalDisasterContext }) {
  if (!historicalDisasterContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'EM-DAT historical disaster context unavailable.' };
  }
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const recoveryBeneficiaries = new Set(['CAT', 'DE', 'URI', 'VMC', 'MLM', 'HD', 'LOW', 'PWR', 'EME', 'XLI']);
  const insurers = new Set(['ALL', 'PGR', 'TRV', 'CB', 'AIG', 'RE', 'KIE']);
  const logisticsTravel = new Set(['FDX', 'UPS', 'DAL', 'UAL', 'AAL', 'LUV', 'JETS', 'CCL', 'RCL']);
  const agricultureFood = new Set(['ADM', 'BG', 'DE', 'KR', 'GIS', 'KHC', 'WMT', 'COST']);
  const utilitiesEnergy = new Set(['XLU', 'NEE', 'DUK', 'SO', 'AEP', 'XLE', 'XOM', 'CVX']);
  const healthcare = new Set(['JNJ', 'PFE', 'MRK', 'ABT', 'BAX', 'XLV']);
  let exposure = 0.3;
  let direction = -0.08;
  let label = 'limited direct long-run historical disaster exposure';

  if (recoveryBeneficiaries.has(symbol) || /construction|infrastructure|materials|equipment|home improvement|rebuild/.test(theme)) {
    exposure = 0.76;
    direction = 0.64;
    label = 'can benefit from long-run rebuilding, infrastructure hardening, and recovery-spend patterns after major disasters';
  } else if (insurers.has(symbol) || /insurance|reinsurance/.test(theme)) {
    exposure = 0.84;
    direction = -0.76;
    label = 'faces catastrophe-loss and insured-asset risk when historical disaster losses trend higher';
  } else if (logisticsTravel.has(symbol) || /logistics|shipping|airline|travel|cruise/.test(theme)) {
    exposure = 0.74;
    direction = -0.58;
    label = 'faces disruption risk in regions with high historical disaster impacts';
  } else if (agricultureFood.has(symbol) || /agriculture|food|grocery|staples/.test(theme)) {
    exposure = 0.62;
    direction = historicalDisasterContext.disasterTypeSignals.drought > 0 || historicalDisasterContext.disasterTypeSignals.flood > 0 ? -0.38 : -0.12;
    label = 'has crop, sourcing, grocery demand, and regional food-system exposure to historical drought/flood/storm patterns';
  } else if (utilitiesEnergy.has(symbol) || /utility|power|electricity|energy|oil|gas/.test(theme)) {
    exposure = 0.68;
    direction = -0.32;
    label = 'faces asset-hardening, outage, repair-cost, and local infrastructure exposure from historical disasters';
  } else if (healthcare.has(symbol) || /health|medical|pharma|medicine/.test(theme)) {
    exposure = 0.52;
    direction = historicalDisasterContext.disasterTypeSignals.disease > 0 ? 0.28 : 0.08;
    label = 'can see medical-response demand, while operational exposure depends on local facilities and distribution lanes';
  }

  const riskDelta = (historicalDisasterContext.riskScore - 50) / 55;
  const opportunityDelta = (historicalDisasterContext.opportunityScore - 50) / 50;
  const raw = 0.5 + (direction >= 0 ? opportunityDelta : riskDelta * direction) * exposure - Math.max(0, riskDelta) * exposure * (direction >= 0 ? 0.06 : 0);
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `EM-DAT ${historicalDisasterContext.momentum}; ${symbol || 'candidate'} ${label}. Historical impact ${historicalDisasterContext.historicalImpactModelingScore}, economic-loss modeling ${historicalDisasterContext.economicLossModelingScore}, human-impact modeling ${historicalDisasterContext.humanImpactModelingScore}, access friction ${historicalDisasterContext.dataAccessFrictionScore}.`,
    topDatasets: historicalDisasterContext.datasets?.slice(0, 5) || [],
  };
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    fetchedAt: context?.fetchedAt,
    momentum: context?.momentum || 'unavailable',
    latestPeriod: context?.latestPeriod || null,
    latestModified: context?.latestModified || null,
    datasetCount: context?.datasetCount || 0,
    registeredAccessRequired: Boolean(context?.registeredAccessRequired),
    organization: context?.organization || null,
    disasterTypeSignals: context?.disasterTypeSignals || {},
    scores: {
      risk: context?.riskScore || 50,
      opportunity: context?.opportunityScore || 50,
      historicalImpactModeling: context?.historicalImpactModelingScore || 50,
      economicLossModeling: context?.economicLossModelingScore || 50,
      humanImpactModeling: context?.humanImpactModelingScore || 50,
      climateRiskBacktest: context?.climateRiskBacktestScore || 50,
      dataAccessFriction: context?.dataAccessFrictionScore || 50,
    },
    topDatasets: (context?.datasets || []).slice(0, 8),
    sources: (context?.sourceList || []).slice(0, 10),
    failures: (context?.failures || []).slice(0, 5),
    narrative: context?.narrative || '',
    bmclUse: 'Use as EM-DAT/CRED historical disaster-impact and economic-loss modeling evidence. It is best for backtesting location/company exposure, not immediate alerts. Respect EM-DAT registration, non-commercial, and usage-term constraints for detailed downloads.',
  };
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'application/json',
    'User-Agent': 'AutoTrader EM-DAT historical disaster research bot',
  });
  const body = await res.text();
  if (!res.ok) {
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed.error?.message || parsed.message || body;
    } catch (_) {
      // Keep raw body.
    }
    throw new Error(`${url} failed with ${res.status}: ${detail}`);
  }
  const parsed = JSON.parse(body);
  if (parsed.success === false) throw new Error(parsed.error?.message || 'HDX API returned success=false');
  return parsed;
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers }, { bucket: 'emdat', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function packageSearchUrl(limit) {
  const url = new URL(EMDAT_HDX_PACKAGE_SEARCH_URL);
  url.searchParams.set('rows', String(limit));
  return url.toString();
}

function sourceList() {
  return [
    { name: 'EM-DAT International Disaster Database', type: 'emdat-main', url: EMDAT_HOME_URL },
    { name: 'EM-DAT public data portal', type: 'emdat-public-portal', url: EMDAT_PUBLIC_PORTAL_URL },
    { name: 'EM-DAT documentation', type: 'emdat-docs', url: EMDAT_DOCS_URL },
    { name: 'CRED organization on HDX', type: 'emdat-hdx-organization', url: EMDAT_HDX_ORG_URL },
    { name: 'HDX CRED EM-DAT package search API', type: 'emdat-hdx-package-search', url: EMDAT_HDX_PACKAGE_SEARCH_URL },
    { name: 'HDX CRED organization API', type: 'emdat-hdx-organization-api', url: EMDAT_HDX_ORG_API_URL },
  ];
}

function normalizeDatasetDate(value) {
  if (!value) return { start: null, end: null, raw: '' };
  const raw = cleanText(value);
  const parts = raw.split('/').map((part) => part.trim()).filter(Boolean);
  return {
    start: parts[0] || raw || null,
    end: parts[1] || parts[0] || raw || null,
    raw,
  };
}

function keywordScore(text, terms) {
  return terms.reduce((sum, term) => sum + (text.match(new RegExp(escapeRegex(term), 'g')) || []).length, 0);
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  collectHistoricalDisasterContext,
  normalizeHdxPackages,
  normalizeOrganization,
  evaluateHistoricalDisasterContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
  EMDAT_HOME_URL,
  EMDAT_PUBLIC_PORTAL_URL,
  EMDAT_DOCS_URL,
  EMDAT_HDX_PACKAGE_SEARCH_URL,
  EMDAT_HDX_ORG_API_URL,
};
