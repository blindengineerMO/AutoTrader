const cheerio = require('cheerio');
const { resilientFetch } = require('../utils/resilientFetch');

const SIPRI_DATASETS_URL = 'https://www.sipri.org/databases';

const SIPRI_DATASETS = [
  {
    id: 'military_expenditure',
    name: 'SIPRI Military Expenditure Database',
    url: 'https://www.sipri.org/databases/milex',
    measureType: 'military-expenditure',
    coverage: 'Country-level annual military spending time series from 1949 through the latest annual release.',
    fields: ['local currency current prices', 'current US dollars', 'constant US dollars', 'share of GDP', 'per-capita spending', 'share of government expenditure'],
    caveat: 'Use as country defense-budget context. It is not a company revenue measure and not a contract award value.',
  },
  {
    id: 'arms_transfers',
    name: 'SIPRI Arms Transfers Database',
    url: 'https://www.sipri.org/databases/armstransfers',
    methodologyUrl: 'https://www.sipri.org/databases/armstransfers/sources-and-methods',
    measureType: 'arms-transfer-volume',
    coverage: 'International transfers of major conventional weapons from 1950 through the latest full calendar year.',
    fields: ['supplier', 'recipient', 'weapon designation', 'order/license year', 'delivery years', 'number ordered', 'number delivered', 'Trend Indicator Value'],
    caveat: 'SIPRI TIV is a transfer-volume indicator, not the financial price of a transaction.',
  },
  {
    id: 'arms_company_revenue',
    name: 'SIPRI Arms Industry Database',
    url: 'https://www.sipri.org/databases/armsindustry',
    measureType: 'arms-company-revenue',
    coverage: 'Top arms-producing and military services companies using annual report and open-source financial data.',
    fields: ['company', 'country', 'arms sales/revenue estimate', 'total sales when available', 'rank/year'],
    caveat: 'Use as defense-company revenue exposure context; verify public-company segment materiality before scoring.',
  },
  {
    id: 'financial_value_arms_trade',
    name: 'SIPRI Financial Value of the Global Arms Trade',
    url: 'https://www.sipri.org/databases/financial-value-global-arms-trade',
    measureType: 'arms-export-financial-value',
    coverage: 'Official national arms-export financial-value reports, with differing national definitions and coverage.',
    fields: ['country', 'year', 'export value', 'license/agreement/order terminology', 'source/methodology notes'],
    caveat: 'Use as financial-value context only with the stated national definition; do not substitute for SIPRI TIV or contract awards.',
  },
  {
    id: 'arms_embargoes',
    name: 'SIPRI Arms Embargoes Database',
    url: 'https://www.sipri.org/databases/embargoes',
    measureType: 'arms-embargo-regulatory-risk',
    coverage: 'Arms embargoes and sanctions context for country and defense-supply-chain restrictions.',
    fields: ['embargo authority', 'target country/entity', 'start/end dates', 'scope', 'source instrument'],
    caveat: 'Use as regulatory/geopolitical risk context; corroborate active restrictions with primary legal notices.',
  },
  {
    id: 'peace_operations',
    name: 'SIPRI Multilateral Peace Operations Database',
    url: 'https://www.sipri.org/databases/pko',
    measureType: 'peace-operation-country-exposure',
    coverage: 'Peace operation personnel, contributors, fatalities, and budgets listed from the SIPRI database directory.',
    fields: ['operation', 'country/location', 'personnel', 'contributors', 'fatalities', 'budget'],
    caveat: 'Use as conflict/peacekeeping location context, not as company revenue evidence.',
  },
  {
    id: 'nuclear_forces',
    name: 'SIPRI Nuclear Forces Dataset',
    url: `${SIPRI_DATASETS_URL}#nuclear-forces`,
    measureType: 'nuclear-force-geopolitical-context',
    coverage: 'Nuclear-force context listed by SIPRI alongside its armament and disarmament datasets.',
    fields: ['country', 'force estimate', 'modernization signal', 'source year'],
    caveat: 'Use as long-run geopolitical/defense context only; verify current details before high-impact scoring.',
  },
];

const MEASURE_DISTINCTIONS = {
  military_expenditure: 'Total spending on military personnel, operations, equipment, construction, and related activities.',
  arms_transfers: 'Cross-border transfer volume of major weapons; SIPRI TIV is a volume indicator, not a transaction price.',
  arms_company_revenue: 'Revenue earned by companies from arms production and military services.',
  contract_award_value: 'Maximum or obligated value of a particular government contract; use USAspending or DoD announcements, not SIPRI TIV, for this.',
};

async function collectSipriMilitaryContext({
  timeoutMs = 10000,
  includePages = true,
  onEvent = () => {},
} = {}) {
  const failures = [];
  const pageSummaries = [];
  if (includePages) {
    const urls = Array.from(new Set([
      SIPRI_DATASETS_URL,
      ...SIPRI_DATASETS.flatMap((dataset) => [dataset.url, dataset.methodologyUrl]).filter(Boolean),
    ]));
    for (const url of urls) {
      try {
        const html = await fetchText(url, timeoutMs);
        const summary = summarizePage(html, url);
        pageSummaries.push(summary);
        emit(onEvent, 'sipri-defense-data', 46, 'debug', 'Fetched SIPRI military and arms data source page.', {
          url,
          title: summary.title,
          signals: summary.signals,
        });
      } catch (err) {
        failures.push({ source: 'sipri', url, error: err.message });
        emit(onEvent, 'sipri-defense-data', 46, 'warn', 'SIPRI source page unavailable; continuing with static dataset definitions.', {
          url,
          error: err.message,
        });
      }
    }
  }

  return evaluateSipriContext({ pageSummaries, failures });
}

function evaluateSipriContext({ pageSummaries = [], failures = [] } = {}) {
  const signals = aggregateSignals(pageSummaries);
  const fetchedDatasetIds = new Set(pageSummaries.map((page) => page.datasetId).filter(Boolean));
  return {
    available: pageSummaries.length > 0 || SIPRI_DATASETS.length > 0,
    provider: 'sipri',
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(),
    datasetCount: SIPRI_DATASETS.length,
    fetchedPageCount: pageSummaries.length,
    failures,
    datasets: SIPRI_DATASETS.map((dataset) => ({
      ...dataset,
      fetched: fetchedDatasetIds.has(dataset.id) || dataset.url === SIPRI_DATASETS_URL,
      observedSignals: signals[dataset.id] || [],
    })),
    measureDistinctions: MEASURE_DISTINCTIONS,
    analysisRules: [
      'Never treat SIPRI TIV as dollars, sales, GDP share, military expenditure, company revenue, or a contract award value.',
      'Use military expenditure for country defense-budget trend and defense-demand context.',
      'Use arms transfers for supplier/recipient/weapon-flow context and major conventional weapons transfer volume.',
      'Use arms industry revenue for company defense exposure, then verify ticker mapping and segment materiality.',
      'Use USAspending and DoD/War.gov daily contract announcements for contract award values.',
      'Label war, conflict, and embargo effects as geographic or regulatory context unless tied to a verified company exposure.',
    ],
    caveat: 'SIPRI data is strategic, source-based defense/geopolitical context. Preserve each dataset measure type and do not interchange TIV, spending, company revenue, and contract award values.',
    bmclUse: 'Share compact SIPRI measure-specific context for defense budget, arms-transfer, arms-company revenue, embargo, peace-operation, nuclear-force, and geopolitical debate. Agents must state the measure type before using it in a recommendation.',
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'sipri',
    fetchedAt: context.fetchedAt,
    datasetCount: context.datasetCount || 0,
    fetchedPageCount: context.fetchedPageCount || 0,
    datasets: (context.datasets || []).map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      url: dataset.url,
      methodologyUrl: dataset.methodologyUrl,
      measureType: dataset.measureType,
      coverage: dataset.coverage,
      fields: dataset.fields,
      caveat: dataset.caveat,
      observedSignals: dataset.observedSignals,
    })),
    measureDistinctions: context.measureDistinctions || MEASURE_DISTINCTIONS,
    analysisRules: context.analysisRules || [],
    failures: (context.failures || []).slice(0, 8),
    sources: sourceList(),
    caveat: context.caveat,
    bmclUse: context.bmclUse,
  };
}

function summarizePage(html, url) {
  const $ = cheerio.load(String(html || ''));
  $('script, style, noscript, svg').remove();
  const title = cleanText($('h1').first().text() || $('title').first().text());
  const text = cleanText($('main').text() || $('body').text()).slice(0, 12000);
  return {
    url,
    title,
    datasetId: inferDatasetId(url, text),
    signals: extractSignals(text),
    excerpt: text.slice(0, 800),
  };
}

function extractSignals(text) {
  const signals = [];
  const checks = [
    ['military-expenditure', /military expenditure|military spending/i],
    ['arms-transfers', /arms transfers|major conventional arms|trend indicator value|TIV/i],
    ['arms-industry', /arms industry|arms-producing|military services companies|Top 100/i],
    ['financial-value', /financial value|arms trade|exports|licences|agreements|orders/i],
    ['peace-operations', /peace operations|personnel|fatalities|budgets/i],
    ['arms-embargoes', /arms embargo/i],
    ['nuclear-forces', /nuclear forces/i],
    ['open-source', /open sources|publicly available/i],
  ];
  for (const [signal, pattern] of checks) {
    if (pattern.test(text)) signals.push(signal);
  }
  return signals;
}

function aggregateSignals(pageSummaries) {
  const byDataset = {};
  for (const page of pageSummaries) {
    const id = page.datasetId || 'directory';
    byDataset[id] = Array.from(new Set([...(byDataset[id] || []), ...(page.signals || [])]));
  }
  return byDataset;
}

function inferDatasetId(url, text) {
  const lowerUrl = String(url || '').toLowerCase();
  if (lowerUrl.includes('/milex')) return 'military_expenditure';
  if (lowerUrl.includes('/armstransfers')) return 'arms_transfers';
  if (lowerUrl.includes('/armsindustry')) return 'arms_company_revenue';
  if (lowerUrl.includes('/financial-value-global-arms-trade')) return 'financial_value_arms_trade';
  if (lowerUrl.includes('/embargoes')) return 'arms_embargoes';
  if (/military expenditure|military spending/i.test(text)) return 'military_expenditure';
  if (/trend indicator value|major conventional arms/i.test(text)) return 'arms_transfers';
  if (/arms industry|arms-producing/i.test(text)) return 'arms_company_revenue';
  return '';
}

function sourceList() {
  return [
    { name: 'SIPRI database directory', type: 'source-directory', url: SIPRI_DATASETS_URL },
    ...SIPRI_DATASETS.map((dataset) => ({
      name: dataset.name,
      type: dataset.measureType,
      url: dataset.url,
      methodologyUrl: dataset.methodologyUrl,
    })),
  ];
}

async function fetchText(url, timeoutMs) {
  const res = await resilientFetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 AutoTrader SIPRI defense research bot; contact=local',
    },
    redirect: 'follow',
  }, {
    bucket: 'sipri-military-data',
    perMinute: 24,
    timeoutMs,
    maxRetries: 1,
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

function emit(onEvent, phase, pct, level, message, data = {}) {
  try {
    onEvent({ phase, pct, level, message, data, ts: new Date().toISOString() });
  } catch (_) {
    // Best-effort progress hooks should never break research collection.
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

module.exports = {
  SIPRI_DATASETS,
  MEASURE_DISTINCTIONS,
  collectSipriMilitaryContext,
  evaluateSipriContext,
  compactForBmcl,
  summarizePage,
  sourceList,
};
