const { resilientFetch } = require('../utils/resilientFetch');
const NIFC_FIRE_INFORMATION_URL = 'https://www.nifc.gov/fire-information';
const NIFC_OPEN_DATA_URL = 'https://data-nifc.opendata.arcgis.com/';
const NIFC_OPEN_DATA_DCAT_URL = 'https://data-nifc.opendata.arcgis.com/api/feed/dcat-us/1.1.json';
const NIFC_FIRE_HISTORY_SERVICES_URL = 'https://data-nifc.opendata.arcgis.com/pages/new_firehistory_services';
const NIFC_NATIONAL_INCIDENT_MAP_URL = 'https://www.nifc.gov/nicc/incident-information/national-incident-map';
const NIFC_INCIWEB_URL = 'https://inciweb.wildfire.gov/';
const NIFC_WFIGS_CURRENT_PERIMETERS_DATASET_URL = 'https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-interagency-fire-perimeters/about';
const NIFC_WFIGS_CURRENT_PERIMETERS_FEATURESERVER_URL = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer';
const NIFC_WFIGS_CURRENT_PERIMETERS_LAYER_URL = `${NIFC_WFIGS_CURRENT_PERIMETERS_FEATURESERVER_URL}/0`;
const NIFC_WFIGS_CURRENT_PERIMETERS_QUERY_URL = `${NIFC_WFIGS_CURRENT_PERIMETERS_LAYER_URL}/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson&orderByFields=poly_DateCurrent%20DESC&resultRecordCount=100`;

async function collectWildfireContext({
  timeoutMs = 8000,
  limit = 100,
  onEvent = () => {},
} = {}) {
  const failures = [];
  const queryUrl = buildCurrentPerimetersQueryUrl({ limit });
  let incidents = [];
  let discoveredDatasets = [];
  let preparednessLevel = null;

  try {
    const payload = await fetchJson(queryUrl, timeoutMs);
    incidents = normalizePerimeterFeatures(payload.features || []);
    emit(onEvent, 'nifc-wildfires', 43, 'debug', 'Fetched NIFC/WFIGS current wildfire perimeters.', {
      incidents: incidents.length,
      queryUrl,
    });
  } catch (error) {
    failures.push({ source: 'nifc-wfigs-current-perimeters', url: queryUrl, error: error.message });
    emit(onEvent, 'nifc-wildfires', 43, 'warn', 'NIFC/WFIGS current wildfire perimeters unavailable.', {
      queryUrl,
      error: error.message,
    });
  }

  try {
    const payload = await fetchJson(NIFC_OPEN_DATA_DCAT_URL, timeoutMs);
    discoveredDatasets = normalizeDcatDatasets(payload.dataset || []);
    emit(onEvent, 'nifc-wildfires', 44, 'debug', 'Discovered related NIFC ArcGIS open-data wildfire datasets.', {
      datasets: discoveredDatasets.length,
    });
  } catch (error) {
    failures.push({ source: 'nifc-open-data-dcat', url: NIFC_OPEN_DATA_DCAT_URL, error: error.message });
  }

  try {
    const text = await fetchText(NIFC_FIRE_INFORMATION_URL, timeoutMs);
    preparednessLevel = parsePreparednessLevel(text);
    emit(onEvent, 'nifc-wildfires', 45, 'debug', 'Parsed NIFC national preparedness-level context.', {
      preparednessLevel,
    });
  } catch (error) {
    failures.push({ source: 'nifc-fire-information', url: NIFC_FIRE_INFORMATION_URL, error: error.message });
  }

  return evaluateWildfireContext({
    incidents,
    discoveredDatasets,
    preparednessLevel,
    failures,
    queryUrl,
  });
}

function buildCurrentPerimetersQueryUrl({ limit = 100 } = {}) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    f: 'geojson',
    orderByFields: 'poly_DateCurrent DESC',
    resultRecordCount: String(Math.min(Math.max(Number(limit) || 100, 1), 1000)),
  });
  return `${NIFC_WFIGS_CURRENT_PERIMETERS_LAYER_URL}/query?${params.toString()}`;
}

function normalizePerimeterFeatures(features = []) {
  return (Array.isArray(features) ? features : []).map((feature) => {
    const props = feature?.properties || {};
    const geometrySummary = summarizeGeometry(feature?.geometry);
    const acres = number(firstDefined(props, ['attr_IncidentSize', 'attr_CalculatedAcres', 'attr_FinalAcres', 'poly_GISAcres', 'poly_Acres_AutoCalc']));
    const percentContained = number(firstDefined(props, ['attr_PercentContained', 'percentContained', 'containment']));
    const updated = millisOrTextToIso(firstDefined(props, ['poly_DateCurrent', 'attr_ModifiedOnDateTime_dt', 'attr_ICS209ReportDateTime', 'updated']));
    const discoveryDate = millisOrTextToIso(firstDefined(props, ['attr_FireDiscoveryDateTime', 'discoveryDate']));
    return {
      id: cleanText(firstDefined(props, ['poly_IRWINID', 'attr_IrwinID', 'attr_UniqueFireIdentifier', 'GlobalID', 'OBJECTID', 'id'])),
      source: 'nifc-wfigs-current-perimeters',
      name: cleanText(firstDefined(props, ['poly_IncidentName', 'attr_IncidentName', 'name'])),
      fireCode: cleanText(firstDefined(props, ['attr_FireCode', 'fireCode'])),
      irwinId: cleanText(firstDefined(props, ['poly_IRWINID', 'attr_IrwinID', 'irwinId'])),
      incidentType: cleanText(firstDefined(props, ['attr_IncidentTypeCategory', 'attr_IncidentTypeKind', 'poly_FeatureCategory', 'incidentType'])),
      incidentStatus: cleanText(firstDefined(props, ['poly_FeatureStatus', 'attr_ICS209ReportStatus', 'incidentStatus', 'status'])),
      state: cleanText(firstDefined(props, ['attr_POOState', 'state'])),
      county: cleanText(firstDefined(props, ['attr_POOCounty', 'county'])),
      city: cleanText(firstDefined(props, ['attr_POOCity', 'city'])),
      gacc: cleanText(firstDefined(props, ['attr_GACC', 'gacc'])),
      acres,
      gisAcres: number(firstDefined(props, ['poly_GISAcres', 'gisAcres'])),
      autoCalcAcres: number(firstDefined(props, ['poly_Acres_AutoCalc', 'autoCalcAcres'])),
      percentContained,
      personnel: number(firstDefined(props, ['attr_TotalIncidentPersonnel', 'personnel'])),
      estimatedCostToDate: number(firstDefined(props, ['attr_EstimatedCostToDate', 'attr_EstimatedFinalCost', 'estimatedCostToDate'])),
      fireCause: cleanText(firstDefined(props, ['attr_FireCause', 'attr_FireCauseGeneral', 'fireCause'])),
      fireBehavior: cleanText(firstDefined(props, ['attr_FireBehaviorGeneral', 'attr_FireBehaviorGeneral1', 'fireBehavior'])),
      predominantFuel: cleanText(firstDefined(props, ['attr_PredominantFuelGroup', 'attr_PredominantFuelModel', 'predominantFuel'])),
      managementOrg: cleanText(firstDefined(props, ['attr_IncidentManagementOrg', 'managementOrg'])),
      containmentDate: millisOrTextToIso(firstDefined(props, ['attr_ContainmentDateTime', 'containmentDate'])),
      controlDate: millisOrTextToIso(firstDefined(props, ['attr_ControlDateTime', 'controlDate'])),
      discoveryDate,
      updated,
      created: millisOrTextToIso(firstDefined(props, ['poly_CreateDate', 'attr_CreatedOnDateTime_dt', 'created'])),
      sourceUrl: cleanText(firstDefined(props, ['url', 'sourceUrl'])) || NIFC_WFIGS_CURRENT_PERIMETERS_DATASET_URL,
      geometryType: cleanText(feature?.geometry?.type),
      bbox: geometrySummary.bbox,
      centroid: geometrySummary.centroid,
      impactScore: wildfireIncidentImpactScore({ acres, percentContained, personnel: number(props.attr_TotalIncidentPersonnel), updated }),
    };
  }).filter((incident) => incident.id || incident.name || Number.isFinite(incident.acres));
}

function normalizeDcatDatasets(datasets = []) {
  const terms = /(wfigs|wildfire|wildland|fire|perimeter|incident|imsr|preparedness)/i;
  return (Array.isArray(datasets) ? datasets : [])
    .filter((item) => terms.test([
      item.title,
      item.description,
      ...(item.keyword || []),
    ].join(' ')))
    .map((item) => ({
      id: cleanText(item.identifier || item['@id'] || item.title),
      title: cleanText(item.title).slice(0, 180),
      description: stripHtml(item.description).slice(0, 260),
      landingPage: cleanText(item.landingPage),
      modified: cleanText(item.modified),
      keywords: normalizeStringArray(item.keyword).slice(0, 10),
      distributions: normalizeDistributions(item.distribution).slice(0, 5),
    }))
    .filter((item) => item.title || item.landingPage)
    .slice(0, 20);
}

function normalizeDistributions(distributions = []) {
  return (Array.isArray(distributions) ? distributions : [])
    .map((item) => ({
      title: cleanText(item.title).slice(0, 120),
      format: cleanText(item.format),
      url: cleanText(item.accessURL || item.downloadURL),
    }))
    .filter((item) => item.url);
}

function evaluateWildfireContext({
  incidents = [],
  discoveredDatasets = [],
  preparednessLevel = null,
  failures = [],
  queryUrl = NIFC_WFIGS_CURRENT_PERIMETERS_QUERY_URL,
} = {}) {
  const scoredIncidents = incidents
    .map((incident) => ({ ...incident, impactScore: incident.impactScore || wildfireIncidentImpactScore(incident) }))
    .sort((a, b) => b.impactScore - a.impactScore || (b.acres || 0) - (a.acres || 0));
  const activeIncidents = scoredIncidents.filter((incident) => isActiveIncident(incident));
  const largeFireCount = scoredIncidents.filter((incident) => Number(incident.acres || 0) >= 10000).length;
  const uncontainedCount = scoredIncidents.filter((incident) => Number(incident.percentContained ?? 100) < 50).length;
  const totalAcres = Math.round(scoredIncidents.reduce((sum, incident) => sum + Number(incident.acres || 0), 0));
  const averageContainmentPct = withFiniteAverage(scoredIncidents.map((incident) => Number(incident.percentContained)));
  const maxImpactScore = scoredIncidents[0]?.impactScore || 0;
  const preparednessBoost = Number(preparednessLevel || 0) * 7;
  const wildfireRiskScore = clampScore(Math.max(
    maxImpactScore,
    34 + activeIncidents.length * 2 + largeFireCount * 5 + uncontainedCount * 3 + Math.log10(Math.max(1, totalAcres)) * 8 + preparednessBoost
  ));
  const activeIncidentRiskScore = clampScore(wildfireRiskScore + activeIncidents.length * 2 + uncontainedCount * 2);
  const perimeterRiskScore = clampScore(32 + scoredIncidents.length * 2 + largeFireCount * 6 + Math.log10(Math.max(1, totalAcres)) * 7);
  const smokeAirQualityRiskScore = clampScore(35 + largeFireCount * 5 + activeIncidents.length * 2 + Math.log10(Math.max(1, totalAcres)) * 6);
  const utilityRiskScore = clampScore(wildfireRiskScore + largeFireCount * 3 + uncontainedCount * 3);
  const insuranceRiskScore = clampScore(wildfireRiskScore + largeFireCount * 4 + activeIncidents.length * 2);
  const timberAgricultureRiskScore = clampScore(38 + largeFireCount * 6 + uncontainedCount * 4 + Math.log10(Math.max(1, totalAcres)) * 6);
  const logisticsRiskScore = clampScore(35 + activeIncidents.length * 3 + largeFireCount * 4 + smokeAirQualityRiskScore * 0.2);
  const recoveryOpportunityScore = clampScore(40 + largeFireCount * 6 + activeIncidents.length * 3 + uncontainedCount * 2 + preparednessBoost * 0.5);
  const momentum = wildfireRiskScore >= 72 ? 'wildfire-risk-elevated'
    : wildfireRiskScore >= 50 ? 'wildfire-risk-watch'
      : 'wildfire-risk-quiet';

  return {
    available: scoredIncidents.length > 0 || discoveredDatasets.length > 0 || Number.isFinite(Number(preparednessLevel)),
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(queryUrl),
    failures,
    queryUrl,
    incidents: scoredIncidents,
    discoveredDatasets,
    incidentCount: scoredIncidents.length,
    activeIncidentCount: activeIncidents.length,
    largeFireCount,
    uncontainedCount,
    totalAcres,
    averageContainmentPct,
    preparednessLevel: Number.isFinite(Number(preparednessLevel)) ? Number(preparednessLevel) : null,
    stateCounts: countBy(scoredIncidents, 'state'),
    incidentStatusCounts: countBy(scoredIncidents, 'incidentStatus'),
    incidentTypeCounts: countBy(scoredIncidents, 'incidentType'),
    maxImpactScore,
    wildfireRiskScore,
    activeIncidentRiskScore,
    perimeterRiskScore,
    smokeAirQualityRiskScore,
    utilityRiskScore,
    insuranceRiskScore,
    timberAgricultureRiskScore,
    logisticsRiskScore,
    recoveryOpportunityScore,
    riskScore: wildfireRiskScore,
    opportunityScore: recoveryOpportunityScore,
    momentum,
    latestPeriod: scoredIncidents[0]?.updated || scoredIncidents[0]?.discoveryDate || null,
    narrative: scoredIncidents.length
      ? `NIFC ${momentum}: ${scoredIncidents.length} WFIGS perimeter incidents, ${largeFireCount} large fires, ${uncontainedCount} under 50% contained, ${totalAcres.toLocaleString()} acres tracked${preparednessLevel ? `, preparedness level ${preparednessLevel}` : ''}.`
      : 'NIFC wildfire context unavailable or no WFIGS current perimeter incidents were returned.',
  };
}

function wildfireIncidentImpactScore(incident = {}) {
  const acres = Number(incident.acres || incident.gisAcres || 0);
  const percentContained = Number(incident.percentContained);
  const personnel = Number(incident.personnel || 0);
  const acreageScore = Math.min(40, Math.log10(Math.max(1, acres)) * 8);
  const containmentBoost = Number.isFinite(percentContained) ? Math.max(0, (100 - percentContained) / 4) : 8;
  const personnelBoost = Math.min(12, Math.log10(Math.max(1, personnel)) * 4);
  const activeBoost = isActiveIncident(incident) ? 12 : 2;
  return clampScore(18 + acreageScore + containmentBoost + personnelBoost + activeBoost);
}

function scoreCandidate({ candidate, wildfireContext }) {
  if (!wildfireContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'NIFC wildfire context unavailable.' };
  }
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const recoveryBeneficiaries = new Set(['CAT', 'DE', 'URI', 'HD', 'LOW', 'PWR', 'EME', 'VMC', 'MLM', 'XLI']);
  const utilities = new Set(['PCG', 'EIX', 'SRE', 'NEE', 'DUK', 'SO', 'AEP', 'XLU']);
  const insurers = new Set(['ALL', 'PGR', 'TRV', 'CB', 'AIG', 'RE', 'KNSL']);
  const timberAgriculture = new Set(['WY', 'PCH', 'CTVA', 'MOS', 'ADM', 'DE', 'BG']);
  const logisticsTravel = new Set(['FDX', 'UPS', 'DAL', 'UAL', 'AAL', 'LUV', 'JETS', 'CCL', 'RCL']);
  const homeRetail = new Set(['HD', 'LOW', 'WMT', 'TGT', 'COST']);
  let exposure = 0.3;
  let direction = -0.08;
  let label = 'limited direct U.S. wildfire perimeter exposure';

  if (recoveryBeneficiaries.has(symbol) || /construction|infrastructure|equipment|rental|home improvement|repair|rebuild|materials/.test(theme)) {
    exposure = 0.82;
    direction = 0.82;
    label = 'can benefit from firefighting, rebuilding, equipment rental, utility hardening, and recovery materials demand';
  } else if (utilities.has(symbol) || /utility|electricity|power|grid|transmission/.test(theme)) {
    exposure = 0.86;
    direction = -0.72;
    label = 'faces wildfire liability, shutoff, vegetation management, grid repair, and restoration cost risk';
  } else if (insurers.has(symbol) || /insurance|reinsurance/.test(theme)) {
    exposure = 0.84;
    direction = -0.8;
    label = 'faces wildfire catastrophe, property, business-interruption, and reinsurance claim risk';
  } else if (timberAgriculture.has(symbol) || /timber|lumber|agriculture|crop|farm|forestry|fertilizer/.test(theme)) {
    exposure = 0.72;
    direction = -0.5;
    label = 'can be exposed to timber, crop, livestock, soil, water, and rural logistics disruption';
  } else if (logisticsTravel.has(symbol) || /logistics|shipping|airline|travel|cruise|delivery|rail/.test(theme)) {
    exposure = 0.68;
    direction = -0.54;
    label = 'faces road, rail, air-quality, route, and destination disruption risk';
  } else if (homeRetail.has(symbol) || /retail|consumer|home|hardware/.test(theme)) {
    exposure = 0.62;
    direction = wildfireContext.recoveryOpportunityScore >= 62 ? 0.22 : -0.2;
    label = 'has mixed emergency-supply, store-closure, evacuation, rebuilding, and consumer-demand exposure';
  }

  const riskDelta = (wildfireContext.riskScore - 50) / 55;
  const opportunityDelta = (wildfireContext.recoveryOpportunityScore - 50) / 50;
  const raw = 0.5
    + (direction >= 0 ? opportunityDelta * direction : riskDelta * direction) * exposure
    - Math.max(0, riskDelta) * exposure * (direction >= 0 ? 0.08 : 0);
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `NIFC ${wildfireContext.momentum}; ${symbol || 'candidate'} ${label}. Wildfire risk ${wildfireContext.riskScore}, active incident risk ${wildfireContext.activeIncidentRiskScore}, perimeter risk ${wildfireContext.perimeterRiskScore}, utility risk ${wildfireContext.utilityRiskScore}, insurance risk ${wildfireContext.insuranceRiskScore}, recovery opportunity ${wildfireContext.recoveryOpportunityScore}.`,
    topIncidents: wildfireContext.incidents?.slice(0, 5) || [],
  };
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    fetchedAt: context?.fetchedAt,
    momentum: context?.momentum || 'unavailable',
    latestPeriod: context?.latestPeriod || null,
    incidentCount: context?.incidentCount || 0,
    activeIncidentCount: context?.activeIncidentCount || 0,
    largeFireCount: context?.largeFireCount || 0,
    uncontainedCount: context?.uncontainedCount || 0,
    totalAcres: context?.totalAcres || 0,
    averageContainmentPct: context?.averageContainmentPct,
    preparednessLevel: context?.preparednessLevel || null,
    stateCounts: context?.stateCounts || {},
    incidentStatusCounts: context?.incidentStatusCounts || {},
    incidentTypeCounts: context?.incidentTypeCounts || {},
    scores: {
      risk: context?.riskScore || 50,
      wildfireRisk: context?.wildfireRiskScore || 50,
      activeIncidentRisk: context?.activeIncidentRiskScore || 50,
      perimeterRisk: context?.perimeterRiskScore || 50,
      smokeAirQualityRisk: context?.smokeAirQualityRiskScore || 50,
      utilityRisk: context?.utilityRiskScore || 50,
      insuranceRisk: context?.insuranceRiskScore || 50,
      timberAgricultureRisk: context?.timberAgricultureRiskScore || 50,
      logisticsRisk: context?.logisticsRiskScore || 50,
      recoveryOpportunity: context?.recoveryOpportunityScore || 50,
    },
    topIncidents: (context?.incidents || []).slice(0, 8),
    discoveredDatasets: (context?.discoveredDatasets || []).slice(0, 8),
    sources: (context?.sourceList || []).slice(0, 12),
    failures: (context?.failures || []).slice(0, 5),
    narrative: context?.narrative || '',
    bmclUse: 'Use as official NIFC/WFIGS U.S. wildfire incident, perimeter, acres-burned, containment, and preparedness-level evidence. Share compact incident geometry/status/source URLs; localize against company facilities, customers, utilities, insurers, timber/agriculture, logistics, and recovery demand before scoring.',
  };
}

function parsePreparednessLevel(text) {
  const clean = stripHtml(text);
  const patterns = [
    /Current\s+Preparedness\s+Level[^0-9]{0,80}([1-5])/i,
    /Preparedness\s+Level[^0-9]{0,80}([1-5])/i,
    /\bPL\s*([1-5])\b/i,
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'application/geo+json,application/json,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader NIFC wildfire research bot',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.json();
}

async function fetchText(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/html,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader NIFC wildfire research bot',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers }, { bucket: 'nifc', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList(queryUrl = NIFC_WFIGS_CURRENT_PERIMETERS_QUERY_URL) {
  return [
    { name: 'NIFC fire information', type: 'nifc-fire-information', url: NIFC_FIRE_INFORMATION_URL },
    { name: 'NIFC ArcGIS open data', type: 'nifc-open-data', url: NIFC_OPEN_DATA_URL },
    { name: 'NIFC ArcGIS open data DCAT feed', type: 'nifc-open-data-dcat', url: NIFC_OPEN_DATA_DCAT_URL },
    { name: 'NIFC WFIGS current interagency fire perimeters dataset', type: 'nifc-wfigs-current-perimeters-dataset', url: NIFC_WFIGS_CURRENT_PERIMETERS_DATASET_URL },
    { name: 'NIFC WFIGS current interagency fire perimeters FeatureServer', type: 'nifc-wfigs-current-perimeters-featureserver', url: NIFC_WFIGS_CURRENT_PERIMETERS_FEATURESERVER_URL },
    { name: 'NIFC WFIGS executable current perimeter query used this run', type: 'nifc-wfigs-current-perimeters-query', url: queryUrl },
    { name: 'NIFC fire history services', type: 'nifc-fire-history-services', url: NIFC_FIRE_HISTORY_SERVICES_URL },
    { name: 'NIFC national incident map', type: 'nifc-national-incident-map', url: NIFC_NATIONAL_INCIDENT_MAP_URL },
    { name: 'InciWeb incident-specific wildfire information', type: 'nifc-inciweb', url: NIFC_INCIWEB_URL },
  ];
}

function summarizeGeometry(geometry) {
  const points = flattenCoordinates(geometry?.coordinates);
  if (!points.length) return { bbox: null, centroid: null };
  const lons = points.map((point) => point[0]).filter(Number.isFinite);
  const lats = points.map((point) => point[1]).filter(Number.isFinite);
  if (!lons.length || !lats.length) return { bbox: null, centroid: null };
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  const centroid = {
    longitude: Number((lons.reduce((sum, lon) => sum + lon, 0) / lons.length).toFixed(4)),
    latitude: Number((lats.reduce((sum, lat) => sum + lat, 0) / lats.length).toFixed(4)),
  };
  return { bbox, centroid };
}

function flattenCoordinates(value) {
  if (!Array.isArray(value)) return [];
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    return [[Number(value[0]), Number(value[1])]];
  }
  return value.flatMap(flattenCoordinates);
}

function isActiveIncident(incident) {
  const text = `${incident?.incidentStatus || ''} ${incident?.incidentType || ''}`.toLowerCase();
  if (/inactive|contained|out|final|closed/.test(text)) return false;
  return /active|wildfire|wf|incident|inprogress|in progress|mapped/.test(text)
    || Number(incident?.percentContained ?? 0) < 100;
}

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null && object?.[key] !== '') return object[key];
  }
  return null;
}

function millisOrTextToIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(millis).toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? cleanText(value) : date.toISOString();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function withFiniteAverage(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  return Number((finite.reduce((sum, value) => sum + value, 0) / finite.length).toFixed(1));
}

function normalizeStringArray(value) {
  const list = Array.isArray(value) ? value : [value].filter(Boolean);
  return list.map(cleanText).filter(Boolean);
}

function stripHtml(value) {
  return cleanText(String(value || '').replace(/<[^>]+>/g, ' '));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function clampScore(value) {
  if (!Number.isFinite(value)) return 50;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function emit(onEvent, step, progress, level, message, data) {
  try {
    onEvent({ step, progress, level, message, data });
  } catch (_) {
    // status callbacks are best-effort only
  }
}

module.exports = {
  NIFC_FIRE_INFORMATION_URL,
  NIFC_OPEN_DATA_URL,
  NIFC_OPEN_DATA_DCAT_URL,
  NIFC_FIRE_HISTORY_SERVICES_URL,
  NIFC_NATIONAL_INCIDENT_MAP_URL,
  NIFC_INCIWEB_URL,
  NIFC_WFIGS_CURRENT_PERIMETERS_DATASET_URL,
  NIFC_WFIGS_CURRENT_PERIMETERS_FEATURESERVER_URL,
  NIFC_WFIGS_CURRENT_PERIMETERS_LAYER_URL,
  NIFC_WFIGS_CURRENT_PERIMETERS_QUERY_URL,
  collectWildfireContext,
  buildCurrentPerimetersQueryUrl,
  normalizePerimeterFeatures,
  normalizeDcatDatasets,
  evaluateWildfireContext,
  parsePreparednessLevel,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
