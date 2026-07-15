const { resilientFetch } = require('../utils/resilientFetch');
const US_DROUGHT_MONITOR_URL = 'https://droughtmonitor.unl.edu/';
const USDM_DATA_DOWNLOAD_URL = 'https://droughtmonitor.unl.edu/DmData/DataDownload.aspx';
const USDM_GIS_DATA_URL = 'https://droughtmonitor.unl.edu/DmData/GISData.aspx';
const USDM_WEB_SERVICE_INFO_URL = 'https://droughtmonitor.unl.edu/DmData/DataDownload/WebServiceInfo.aspx';
const USDM_REST_BASE_URL = 'https://usdmdataservices.unl.edu/api';
const DEFAULT_AREA = 'USStatistics';
const DEFAULT_AOI = 'us';

async function collectDroughtContext({
  timeoutMs = 8000,
  area = DEFAULT_AREA,
  aoi = DEFAULT_AOI,
  startDate,
  endDate,
  statisticsType = 1,
  onEvent = () => {},
} = {}) {
  const failures = [];
  const range = dateRangeForRecentWeeks(new Date());
  const query = {
    area: cleanText(area) || DEFAULT_AREA,
    aoi: cleanText(aoi) || DEFAULT_AOI,
    startDate: startDate || range.startDate,
    endDate: endDate || range.endDate,
    statisticsType: clampInteger(statisticsType, 1, 2, 1),
  };
  const areaPercentUrl = buildStatisticsUrl({
    ...query,
    statistic: 'GetDroughtSeverityStatisticsByAreaPercent',
  });
  const dsciUrl = buildStatisticsUrl({
    ...query,
    statistic: 'GetDSCI',
  });

  let severityRows = [];
  let dsciRows = [];
  let pageSummary = null;

  try {
    const payload = await fetchJson(areaPercentUrl, timeoutMs);
    severityRows = normalizeSeverityRows(payload);
    emit(onEvent, 'usdm-drought', 46, 'debug', 'Fetched U.S. Drought Monitor severity statistics.', {
      rows: severityRows.length,
      areaPercentUrl,
    });
  } catch (error) {
    failures.push({ source: 'usdm-area-percent-statistics', url: areaPercentUrl, error: error.message });
    emit(onEvent, 'usdm-drought', 46, 'warn', 'U.S. Drought Monitor severity statistics unavailable.', {
      areaPercentUrl,
      error: error.message,
    });
  }

  try {
    const payload = await fetchJson(dsciUrl, timeoutMs);
    dsciRows = normalizeDsciRows(payload);
    emit(onEvent, 'usdm-drought', 47, 'debug', 'Fetched U.S. Drought Monitor DSCI statistics.', {
      rows: dsciRows.length,
      dsciUrl,
    });
  } catch (error) {
    failures.push({ source: 'usdm-dsci-statistics', url: dsciUrl, error: error.message });
  }

  try {
    const text = await fetchText(US_DROUGHT_MONITOR_URL, timeoutMs);
    pageSummary = parseDroughtMonitorPage(text);
    emit(onEvent, 'usdm-drought', 48, 'debug', 'Parsed U.S. Drought Monitor release cadence and current-map notes.', pageSummary);
  } catch (error) {
    failures.push({ source: 'usdm-home-page', url: US_DROUGHT_MONITOR_URL, error: error.message });
  }

  return evaluateDroughtContext({
    severityRows,
    dsciRows,
    pageSummary,
    failures,
    areaPercentUrl,
    dsciUrl,
    query,
  });
}

function buildStatisticsUrl({
  area = DEFAULT_AREA,
  statistic = 'GetDroughtSeverityStatisticsByAreaPercent',
  aoi = DEFAULT_AOI,
  startDate,
  endDate,
  statisticsType = 1,
} = {}) {
  const range = dateRangeForRecentWeeks(new Date());
  const params = new URLSearchParams({
    aoi: cleanText(aoi) || DEFAULT_AOI,
    startdate: startDate || range.startDate,
    enddate: endDate || range.endDate,
    statisticsType: String(clampInteger(statisticsType, 1, 2, 1)),
  });
  return `${USDM_REST_BASE_URL}/${encodeURIComponent(cleanText(area) || DEFAULT_AREA)}/${encodeURIComponent(cleanText(statistic) || 'GetDroughtSeverityStatisticsByAreaPercent')}?${params.toString()}`;
}

function buildWeeksInDroughtUrl({
  consecutive = 'consecutive',
  aoi = DEFAULT_AOI,
  droughtLevel = 2,
  minimumWeeks = 4,
  startDate,
  endDate,
} = {}) {
  const range = dateRangeForRecentWeeks(new Date(), 26);
  const params = new URLSearchParams({
    aoi: cleanText(aoi) || DEFAULT_AOI,
    dx: String(clampInteger(droughtLevel, 0, 4, 2)),
    minimumweeks: String(clampInteger(minimumWeeks, 1, 520, 4)),
    startdate: startDate || range.startDate,
    enddate: endDate || range.endDate,
  });
  const mode = /^non/i.test(String(consecutive)) ? 'nonconsecutive' : 'consecutive';
  return `${USDM_REST_BASE_URL}/ConsecutiveNonConsecutiveStatistics/${mode}?${params.toString()}`;
}

function normalizeSeverityRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      mapDate: toIsoDate(row.mapDate || row.MapDate || row.date),
      areaOfInterest: cleanText(row.areaOfInterest || row.AreaOfInterest || row.name || row.Name),
      none: finiteNumber(row.none ?? row.None),
      d0: finiteNumber(row.d0 ?? row.D0),
      d1: finiteNumber(row.d1 ?? row.D1),
      d2: finiteNumber(row.d2 ?? row.D2),
      d3: finiteNumber(row.d3 ?? row.D3),
      d4: finiteNumber(row.d4 ?? row.D4),
      validStart: toIsoDate(row.validStart || row.ValidStart),
      validEnd: toIsoDate(row.validEnd || row.ValidEnd),
      statisticFormatID: finiteNumber(row.statisticFormatID ?? row.StatisticFormatID),
    }))
    .filter((row) => row.mapDate || row.areaOfInterest)
    .sort((a, b) => String(b.mapDate || '').localeCompare(String(a.mapDate || '')));
}

function normalizeDsciRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      name: cleanText(row.name || row.Name || row.areaOfInterest || row.AreaOfInterest),
      mapDate: toIsoDate(row.mapDate || row.MapDate || row.date),
      dsci: finiteNumber(row.dsci ?? row.DSCI),
    }))
    .filter((row) => row.mapDate || row.name || Number.isFinite(row.dsci))
    .sort((a, b) => String(b.mapDate || '').localeCompare(String(a.mapDate || '')));
}

function evaluateDroughtContext({
  severityRows = [],
  dsciRows = [],
  pageSummary = null,
  failures = [],
  areaPercentUrl,
  dsciUrl,
  query = {},
} = {}) {
  const latestArea = selectPrimarySeverityRow(severityRows);
  const priorArea = selectPriorSeverityRow(severityRows, latestArea);
  const latestDsci = selectPrimaryDsciRow(dsciRows, latestArea);
  const priorDsci = selectPriorDsciRow(dsciRows, latestDsci);
  const dsci = finiteNumber(latestDsci?.dsci);
  const priorDsciValue = finiteNumber(priorDsci?.dsci);
  const severeDroughtPct = finiteNumber(latestArea?.d2) ?? 0;
  const extremeExceptionalPct = Math.max(finiteNumber(latestArea?.d3) ?? 0, finiteNumber(latestArea?.d4) ?? 0);
  const exceptionalDroughtPct = finiteNumber(latestArea?.d4) ?? 0;
  const d1Pct = finiteNumber(latestArea?.d1) ?? 0;
  const d0Pct = finiteNumber(latestArea?.d0) ?? 0;
  const dsciRisk = Number.isFinite(dsci) ? dsci / 5 : null;
  const weightedSeverity = (d0Pct * 0.16) + (d1Pct * 0.28) + (severeDroughtPct * 0.45) + (extremeExceptionalPct * 0.65) + (exceptionalDroughtPct * 0.85);
  const droughtRiskScore = clampScore(Math.max(dsciRisk ?? 0, 28 + weightedSeverity));
  const dsciChange = Number.isFinite(dsci) && Number.isFinite(priorDsciValue) ? Number((dsci - priorDsciValue).toFixed(1)) : null;
  const severeChangePct = Number.isFinite(latestArea?.d2) && Number.isFinite(priorArea?.d2)
    ? Number((latestArea.d2 - priorArea.d2).toFixed(2))
    : null;
  const worsening = (dsciChange || 0) > 3 || (severeChangePct || 0) > 2;
  const improving = (dsciChange || 0) < -3 || (severeChangePct || 0) < -2;

  const agricultureRiskScore = clampScore(droughtRiskScore + severeDroughtPct * 0.18 + extremeExceptionalPct * 0.2);
  const cropInputDemandScore = clampScore(38 + droughtRiskScore * 0.36 + severeDroughtPct * 0.22);
  const waterUtilityRiskScore = clampScore(34 + droughtRiskScore * 0.42 + exceptionalDroughtPct * 0.35);
  const wildfireAmplificationRiskScore = clampScore(32 + droughtRiskScore * 0.45 + severeDroughtPct * 0.24 + extremeExceptionalPct * 0.28);
  const foodInflationRiskScore = clampScore(34 + droughtRiskScore * 0.38 + d1Pct * 0.12 + severeDroughtPct * 0.22);
  const livestockRiskScore = clampScore(35 + droughtRiskScore * 0.36 + severeDroughtPct * 0.24 + exceptionalDroughtPct * 0.4);
  const logisticsRiskScore = clampScore(30 + droughtRiskScore * 0.24 + severeDroughtPct * 0.18);
  const irrigationInfrastructureOpportunityScore = clampScore(40 + droughtRiskScore * 0.42 + severeDroughtPct * 0.24 + (worsening ? 6 : 0));
  const recoveryOpportunityScore = clampScore(36 + droughtRiskScore * 0.3 + extremeExceptionalPct * 0.2 + (improving ? 5 : 0));
  const momentum = droughtRiskScore >= 72 || extremeExceptionalPct >= 18
    ? (worsening ? 'drought-risk-elevated-worsening' : 'drought-risk-elevated')
    : droughtRiskScore >= 50 || severeDroughtPct >= 20
      ? (improving ? 'drought-risk-watch-improving' : 'drought-risk-watch')
      : 'drought-risk-quiet';

  return {
    available: Boolean(latestArea || latestDsci || pageSummary),
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList({ areaPercentUrl, dsciUrl }),
    failures,
    query,
    areaPercentUrl,
    dsciUrl,
    pageSummary,
    mapReleaseDate: pageSummary?.mapReleaseDate || null,
    dataValidDate: pageSummary?.dataValidDate || latestArea?.mapDate || latestDsci?.mapDate || null,
    latestPeriod: latestArea?.mapDate || latestDsci?.mapDate || null,
    latestArea,
    priorArea,
    latestDsci,
    priorDsci,
    severityRows,
    dsciRows,
    areaOfInterest: latestArea?.areaOfInterest || latestDsci?.name || query.aoi || DEFAULT_AOI,
    dsci,
    dsciChange,
    severeChangePct,
    severeDroughtPct,
    extremeExceptionalPct,
    exceptionalDroughtPct,
    droughtRiskScore,
    agricultureRiskScore,
    cropInputDemandScore,
    waterUtilityRiskScore,
    wildfireAmplificationRiskScore,
    foodInflationRiskScore,
    livestockRiskScore,
    logisticsRiskScore,
    irrigationInfrastructureOpportunityScore,
    recoveryOpportunityScore,
    riskScore: droughtRiskScore,
    opportunityScore: irrigationInfrastructureOpportunityScore,
    momentum,
    topAreas: severityRows.slice(0, 8),
    narrative: latestArea
      ? `U.S. Drought Monitor ${momentum}: ${latestArea.areaOfInterest || 'selected area'} ${latestArea.mapDate || 'latest'} has D0 ${formatPct(latestArea.d0)}, D1 ${formatPct(latestArea.d1)}, D2 ${formatPct(latestArea.d2)}, D3 ${formatPct(latestArea.d3)}, D4 ${formatPct(latestArea.d4)} and DSCI ${dsci ?? 'n/a'}.`
      : 'U.S. Drought Monitor context unavailable or no severity rows were returned.',
  };
}

function scoreCandidate({ candidate, droughtContext }) {
  if (!droughtContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'U.S. Drought Monitor context unavailable.' };
  }
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const irrigationWaterInfra = new Set(['XYL', 'AWK', 'AWR', 'CWT', 'WTRG', 'LNN', 'PNR', 'BMI']);
  const agEquipmentInputs = new Set(['DE', 'CAT', 'CTVA', 'MOS', 'NTR', 'CF', 'AGCO']);
  const foodProcessors = new Set(['ADM', 'BG', 'TSN', 'HRL', 'GIS', 'K', 'KHC', 'MDLZ']);
  const grocersRestaurants = new Set(['KR', 'WMT', 'COST', 'SYY', 'MCD', 'SBUX', 'YUM', 'CMG']);
  const utilitiesInsurers = new Set(['PCG', 'EIX', 'NEE', 'DUK', 'SO', 'AEP', 'XLU', 'ALL', 'TRV', 'PGR']);
  const logistics = new Set(['UNP', 'CSX', 'NSC', 'FDX', 'UPS', 'JBHT', 'CHRW']);

  let exposure = 0.28;
  let direction = -0.06;
  let label = 'limited direct U.S. drought classification exposure';

  if (irrigationWaterInfra.has(symbol) || /water|irrigation|pump|filtration|meter|infrastructure/.test(theme)) {
    exposure = 0.86;
    direction = 0.78;
    label = 'can benefit from water infrastructure, monitoring, irrigation, pumping, and drought resilience demand';
  } else if (agEquipmentInputs.has(symbol) || /agriculture|farm|crop|fertilizer|seed|equipment|tractor/.test(theme)) {
    exposure = 0.76;
    direction = droughtContext.cropInputDemandScore >= droughtContext.agricultureRiskScore ? 0.24 : -0.26;
    label = 'has mixed crop stress, input demand, farmer-income, irrigation, and equipment replacement exposure';
  } else if (foodProcessors.has(symbol) || /food processor|grain|meat|livestock|packaged food|commodity/.test(theme)) {
    exposure = 0.8;
    direction = -0.56;
    label = 'faces crop, grain, livestock, water, and input-cost pressure when severe drought expands';
  } else if (grocersRestaurants.has(symbol) || /grocery|restaurant|coffee|food retail|consumer staples/.test(theme)) {
    exposure = 0.66;
    direction = -0.34;
    label = 'faces food-cost inflation, availability, and consumer affordability risk';
  } else if (utilitiesInsurers.has(symbol) || /utility|insurance|reinsurance|power|grid/.test(theme)) {
    exposure = 0.72;
    direction = -0.42;
    label = 'faces water availability, wildfire amplification, claim, and operational-risk pressure';
  } else if (logistics.has(symbol) || /rail|truck|logistics|shipping|freight|barge/.test(theme)) {
    exposure = 0.58;
    direction = -0.22;
    label = 'can be exposed to crop volume, river level, wildfire-smoke, and route disruption';
  }

  const riskDelta = (droughtContext.riskScore - 50) / 55;
  const opportunityDelta = (droughtContext.irrigationInfrastructureOpportunityScore - 50) / 50;
  const raw = 0.5 + (direction >= 0 ? opportunityDelta * direction : riskDelta * direction) * exposure;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `USDM ${droughtContext.momentum}; ${symbol || 'candidate'} ${label}. Drought risk ${droughtContext.riskScore}, agriculture risk ${droughtContext.agricultureRiskScore}, food inflation risk ${droughtContext.foodInflationRiskScore}, water utility risk ${droughtContext.waterUtilityRiskScore}, wildfire amplification ${droughtContext.wildfireAmplificationRiskScore}, irrigation infrastructure opportunity ${droughtContext.irrigationInfrastructureOpportunityScore}.`,
    topAreas: droughtContext.topAreas?.slice(0, 5) || [],
  };
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    fetchedAt: context?.fetchedAt,
    momentum: context?.momentum || 'unavailable',
    latestPeriod: context?.latestPeriod || null,
    mapReleaseDate: context?.mapReleaseDate || null,
    dataValidDate: context?.dataValidDate || null,
    areaOfInterest: context?.areaOfInterest || null,
    dsci: context?.dsci ?? null,
    dsciChange: context?.dsciChange ?? null,
    severeChangePct: context?.severeChangePct ?? null,
    droughtClassifications: context?.latestArea ? {
      none: context.latestArea.none,
      d0: context.latestArea.d0,
      d1: context.latestArea.d1,
      d2: context.latestArea.d2,
      d3: context.latestArea.d3,
      d4: context.latestArea.d4,
    } : null,
    scores: {
      risk: context?.riskScore || 50,
      agricultureRisk: context?.agricultureRiskScore || 50,
      cropInputDemand: context?.cropInputDemandScore || 50,
      waterUtilityRisk: context?.waterUtilityRiskScore || 50,
      wildfireAmplificationRisk: context?.wildfireAmplificationRiskScore || 50,
      foodInflationRisk: context?.foodInflationRiskScore || 50,
      livestockRisk: context?.livestockRiskScore || 50,
      logisticsRisk: context?.logisticsRiskScore || 50,
      irrigationInfrastructureOpportunity: context?.irrigationInfrastructureOpportunityScore || 50,
      recoveryOpportunity: context?.recoveryOpportunityScore || 50,
    },
    topAreas: (context?.topAreas || []).slice(0, 8),
    sources: (context?.sourceList || []).slice(0, 12),
    failures: (context?.failures || []).slice(0, 5),
    narrative: context?.narrative || '',
    bmclUse: 'Use as official weekly U.S. Drought Monitor drought-classification and DSCI evidence. Share compact D0-D4, DSCI, AOI, dates, and URLs; localize against company facilities, customers, agriculture, water utilities, food costs, wildfire amplification, livestock, logistics, and recovery-demand exposure before scoring.',
  };
}

function parseDroughtMonitorPage(text) {
  const clean = stripHtml(text);
  const releaseMatch = clean.match(/Map\s+released\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  const validMatch = clean.match(/Data\s+valid\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  const cutoffMatch = clean.match(/Data\s+Cutoff[^.]{0,180}/i);
  return {
    mapReleaseDate: releaseMatch ? toIsoDate(releaseMatch[1]) : null,
    dataValidDate: validMatch ? toIsoDate(validMatch[1]) : null,
    dataCutoffNote: cleanText(cutoffMatch?.[0]),
    summaryExcerpt: clean.slice(0, 600),
  };
}

function dateRangeForRecentWeeks(referenceDate = new Date(), weeks = 3) {
  const end = new Date(referenceDate);
  const start = new Date(referenceDate);
  start.setDate(start.getDate() - weeks * 7);
  return {
    startDate: formatUsDate(start),
    endDate: formatUsDate(end),
  };
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'application/json,text/json,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader U.S. Drought Monitor research bot',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.json();
}

async function fetchText(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/html,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader U.S. Drought Monitor research bot',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers }, { bucket: 'drought', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList({ areaPercentUrl, dsciUrl } = {}) {
  return [
    { name: 'U.S. Drought Monitor', type: 'usdm-home', url: US_DROUGHT_MONITOR_URL },
    { name: 'U.S. Drought Monitor data downloads', type: 'usdm-data-downloads', url: USDM_DATA_DOWNLOAD_URL },
    { name: 'U.S. Drought Monitor REST web service information', type: 'usdm-rest-web-service-info', url: USDM_WEB_SERVICE_INFO_URL },
    { name: 'U.S. Drought Monitor area-percent statistics query used this run', type: 'usdm-area-percent-statistics', url: areaPercentUrl || buildStatisticsUrl() },
    { name: 'U.S. Drought Monitor DSCI query used this run', type: 'usdm-dsci-statistics', url: dsciUrl || buildStatisticsUrl({ statistic: 'GetDSCI' }) },
    { name: 'U.S. Drought Monitor GIS data', type: 'usdm-gis-data', url: USDM_GIS_DATA_URL },
    { name: 'U.S. Drought Monitor weeks-in-drought REST template', type: 'usdm-weeks-in-drought-template', url: buildWeeksInDroughtUrl() },
  ];
}

function selectPrimarySeverityRow(rows = []) {
  return rows.find((row) => /^conus$/i.test(row.areaOfInterest))
    || rows.find((row) => /^total$/i.test(row.areaOfInterest))
    || rows[0]
    || null;
}

function selectPriorSeverityRow(rows = [], latest) {
  if (!latest) return null;
  return rows.find((row) => row !== latest && String(row.areaOfInterest || '').toLowerCase() === String(latest.areaOfInterest || '').toLowerCase())
    || rows.find((row) => row !== latest)
    || null;
}

function selectPrimaryDsciRow(rows = [], latestArea) {
  const area = String(latestArea?.areaOfInterest || '').toLowerCase();
  return rows.find((row) => String(row.name || '').toLowerCase() === area)
    || rows.find((row) => /^conus$/i.test(row.name))
    || rows.find((row) => /^total$/i.test(row.name))
    || rows[0]
    || null;
}

function selectPriorDsciRow(rows = [], latest) {
  if (!latest) return null;
  return rows.find((row) => row !== latest && String(row.name || '').toLowerCase() === String(latest.name || '').toLowerCase())
    || rows.find((row) => row !== latest)
    || null;
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return cleanText(value);
  return date.toISOString().slice(0, 10);
}

function formatUsDate(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

function formatPct(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}%` : 'n/a';
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
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
  US_DROUGHT_MONITOR_URL,
  USDM_DATA_DOWNLOAD_URL,
  USDM_GIS_DATA_URL,
  USDM_WEB_SERVICE_INFO_URL,
  USDM_REST_BASE_URL,
  collectDroughtContext,
  buildStatisticsUrl,
  buildWeeksInDroughtUrl,
  normalizeSeverityRows,
  normalizeDsciRows,
  evaluateDroughtContext,
  parseDroughtMonitorPage,
  dateRangeForRecentWeeks,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
