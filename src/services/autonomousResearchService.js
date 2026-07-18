const researchRepo = require('../db/repositories/researchRepo');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const finnhub = require('./marketData/finnhubClient');
const alpacaAssetClient = require('./marketData/alpacaAssetClient');
const webScrapeClient = require('./marketData/webScrapeClient');
const sourceLearning = require('./researchSourceLearningService');
const brainModelService = require('./brainModelService');
const ensembleService = require('./models/ensembleService');
const companyIntelligence = require('./companyIntelligenceService');
const investorPlaybook = require('./investorPlaybookService');
const jsonDatasetIndicators = require('./jsonDatasetIndicatorService');
const companyDiscovery = require('./companyDiscoveryService');
const chatResearch = require('./chatResearchService');
const articleComprehension = require('./articleComprehensionService');
const financialEventWeights = require('./financialEventWeightingService');
const eventOutcomeLabeling = require('./eventOutcomeLabelingService');
const eventTrainingLabelRepo = require('../db/repositories/eventTrainingLabelRepo');
const challengerScorerService = require('./challengerScorerService');
const researchQuestionReasoning = require('./researchQuestionReasoningService');
const locationCoordinator = require('./locationCoordinatorService');
const censusBfs = require('./censusBfsService');
const censusBds = require('./censusBdsService');
const censusRetailTrade = require('./censusRetailTradeService');
const gdeltDoc = require('./gdeltDocService');
const eiaEnergy = require('./eiaEnergyService');
const vehicleSales = require('./vehicleSalesService');
const blsPricing = require('./blsPricingService');
const amazonBestsellers = require('./amazonBestsellerService');
const walmartRetailDemand = require('./walmartRetailDemandService');
const consumerGoodsIndustry = require('./consumerGoodsIndustryService');
const finvizScreener = require('./finvizScreenerService');
const tradingViewScreener = require('./tradingViewScreenerService');
const yahooFinanceScreener = require('./yahooFinanceScreenerService');
const nasdaqMarketResearch = require('./nasdaqMarketResearchService');
const marketBeatAnalyst = require('./marketBeatAnalystService');
const wallStreetZen = require('./wallStreetZenService');
const finraMarketData = require('./finraMarketDataService');
const secInstitutionalOwnership = require('./secInstitutionalOwnershipService');
const usaspendingAwards = require('./usaspendingAwardsService');
const dodContracts = require('./dodContractsService');
const analystDecisionGate = require('./analystDecisionGateService');
const gdacsDisasters = require('./gdacsDisasterService');
const eonetNaturalEvents = require('./eonetNaturalEventService');
const reliefWebHumanitarian = require('./reliefWebHumanitarianService');
const unhcrRefugees = require('./unhcrRefugeeStatisticsService');
const emdatHistoricalDisasters = require('./emdatHistoricalDisasterService');
const usgsEarthquakes = require('./usgsEarthquakeService');
const nwsWeatherAlerts = require('./nwsWeatherAlertService');
const nrcNuclearEvents = require('./nrcNuclearEventService');
const nifcWildfires = require('./nifcWildfireService');
const usDroughtMonitor = require('./usDroughtMonitorService');
const brainMesh = require('./brainMeshService');
const watcherAgentService = require('./watcherAgentService');
const httpCache = require('../utils/httpCache');
const { config } = require('../config');
const logger = require('../utils/logger');

// Per-source snapshot cache so back-to-back research cycles skip a re-fetch of
// data that only changes on a slower cadence than the cycle itself. Statistical/
// screener sources cache the longest; hazard/alert feeds get a short TTL since
// event-to-company correlation depends on catching new events promptly.
const STAT_SOURCE_TTL_MS = 4 * 60 * 60 * 1000;
const HAZARD_SOURCE_TTL_MS = 30 * 60 * 1000;
function cachedSource(key, ttlMs, fn) {
  return httpCache.getOrFetch(`source-snapshot:${key}`, ttlMs, fn);
}

const DEFAULT_UNIVERSE = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'AMD', 'META', 'SPY', 'QQQ'];
const PRICE_TIER_BONUS_THRESHOLD = watcherAgentService.PRICE_TIER_THRESHOLD;
const PRICE_TIER_BONUS_POINTS = 5;
const WATCHER_SIGNAL_BONUS_POINTS = 4;
const WATCHER_SIGNAL_MIN_AGREEING = 2;

const MAX_WATCHER_SIGNALS_PER_USER = 40;
const recentWatcherSignalsByUser = new Map();

// watcher.research.reported is broadcast via tell() from every watcher's hourly
// cycle; without this handler the top-level research agent showed "handlers":0
// and the signal was logged but never fed back into the next scoring pass.
brainMesh.registerHandler('agent.research.top-level', 'watcher.research.reported', (envelope) => {
  const userId = envelope.ctx?.userId;
  if (!userId || !envelope.body?.symbol) return { acknowledged: false };
  const list = recentWatcherSignalsByUser.get(userId) || [];
  list.push({
    symbol: envelope.body.symbol,
    predictedAction: envelope.body.predictedAction,
    localAiScore: envelope.body.localAiScore,
    receivedAt: new Date().toISOString(),
  });
  recentWatcherSignalsByUser.set(userId, list.slice(-MAX_WATCHER_SIGNALS_PER_USER));
  return { acknowledged: true };
});

function listRecentWatcherSignals(userId, symbol) {
  const signals = recentWatcherSignalsByUser.get(userId) || [];
  return symbol ? signals.filter((signal) => signal.symbol === symbol) : signals;
}

const NEWS_FEEDS = [
  { name: 'Yahoo Finance', region: 'US markets', url: 'https://finance.yahoo.com/news/rssindex' },
  { name: 'CNBC Economy', region: 'US economy', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { name: 'BBC Business', region: 'world business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { name: 'Google News World Business', region: 'world news', url: 'https://news.google.com/rss/search?q=world+economy+markets&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News Business Search', region: 'US business discovery', url: 'https://news.google.com/rss/search?q=business&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News New Company Search', region: 'US startup discovery', url: 'https://news.google.com/rss/search?q=%22new+company%22+OR+startup+OR+%22business+launch%22&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News Startup Funding', region: 'US startup funding', url: 'https://news.google.com/rss/search?q=startup+%22funding+round%22+when%3A7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News IPO Activity', region: 'US IPO discovery', url: 'https://news.google.com/rss/search?q=IPO+OR+%22filed+to+go+public%22+when%3A7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News Business Topic', region: 'US business discovery', url: 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en' },
  { name: 'MarketWatch Pulse', region: 'US markets', url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse' },
  { name: 'MarketWatch Top Stories', region: 'US markets', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'MarketWatch Bulletins', region: 'US markets', url: 'https://feeds.content.dowjones.io/public/rss/mw_bulletins' },
  { name: 'MarketWatch Realtime Headlines', region: 'US markets', url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines' },
  { name: 'CNBC Finance', region: 'US markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  { name: 'CNBC Economy (search feed)', region: 'US economy', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910' },
  { name: 'CNBC Earnings', region: 'US markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362' },
  { name: 'CNBC Business', region: 'US business', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768' },
  { name: 'CNBC Top News', region: 'US markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000116' },
  { name: 'WSJ Markets Main', region: 'US markets', url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain' },
  { name: 'WSJ US Business', region: 'US business', url: 'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness' },
  { name: 'Federal Reserve Press Releases', region: 'US monetary policy', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { name: 'CNBC Markets', region: 'US markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147' },
  { name: 'SEC Press Releases', region: 'US regulatory filings', url: 'https://www.sec.gov/news/pressreleases.rss' },
  { name: 'SEC Speeches and Statements', region: 'US regulatory policy', url: 'https://www.sec.gov/news/speeches-statements.rss' },
  { name: 'SEC Litigation Releases', region: 'US enforcement', url: 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss' },
  { name: 'SEC Administrative Proceedings', region: 'US enforcement', url: 'https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss' },
  { name: 'SEC Trading Suspensions', region: 'US enforcement', url: 'https://www.sec.gov/enforcement-litigation/trading-suspensions/rss' },
  { name: 'SEC Structured Filings', region: 'US filings', url: 'https://www.sec.gov/Archives/edgar/usgaap.rss.xml' },
  { name: 'SEC Mutual Fund Structured Filings', region: 'US filings', url: 'https://www.sec.gov/Archives/edgar/xbrl-rr.rss.xml' },
  { name: 'SEC Inline XBRL Filings', region: 'US filings', url: 'https://www.sec.gov/Archives/edgar/xbrl-inline.rss.xml' },
  { name: 'SEC All XBRL Filings', region: 'US filings', url: 'https://www.sec.gov/Archives/edgar/xbrlrss.all.xml' },
  { name: 'FTC Press Releases', region: 'US antitrust consumer protection', url: 'https://www.ftc.gov/feeds/press-release.xml' },
  { name: 'DOJ Justice News', region: 'US antitrust fraud enforcement', url: 'https://www.justice.gov/feeds/justice-news.xml' },
  { name: 'CFPB Newsroom', region: 'US consumer finance', url: 'https://www.consumerfinance.gov/about-us/blog/feed/' },
  { name: 'FDA Press Releases', region: 'US healthcare regulatory', url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml' },
  { name: 'Department of Defense Contracts', region: 'US defense contracts', url: 'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&Category=549&max=20' },
  { name: 'GlobeNewswire Public Companies', region: 'issuer-paid company press releases', url: 'https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies' },
  { name: 'GlobeNewswire Earnings', region: 'issuer-paid earnings releases', url: 'https://www.globenewswire.com/RssFeed/subjectcode/13-Earnings%20Releases%20And%20Operating%20Results/feedTitle/GlobeNewswire%20-%20Earnings%20Releases%20And%20Operating%20Results' },
  { name: 'GlobeNewswire Mergers and Acquisitions', region: 'issuer-paid M&A releases', url: 'https://www.globenewswire.com/RssFeed/subjectcode/27-Mergers%20And%20Acquisitions/feedTitle/GlobeNewswire%20-%20Mergers%20And%20Acquisitions' },
  { name: 'GlobeNewswire Company Announcements', region: 'issuer-paid company announcements', url: 'https://www.globenewswire.com/RssFeed/subjectcode/9-Company%20Announcement/feedTitle/GlobeNewswire%20-%20Company%20Announcement' },
  { name: 'GlobeNewswire IPOs', region: 'issuer-paid IPO releases', url: 'https://www.globenewswire.com/RssFeed/subjectcode/21-Initial%20Public%20Offerings/feedTitle/GlobeNewswire%20-%20Initial%20Public%20Offerings' },
  { name: 'GlobeNewswire Partnerships', region: 'issuer-paid partnership releases', url: 'https://www.globenewswire.com/RssFeed/subjectcode/29-Partnerships/feedTitle/GlobeNewswire%20-%20Partnerships' },
  { name: 'GlobeNewswire Product Services Announcements', region: 'issuer-paid product launches', url: 'https://www.globenewswire.com/RssFeed/subjectcode/32-Product%202f%20Services%20Announcement/feedTitle/GlobeNewswire%20-%20Product%20%2C%20Services%20Announcement' },
  { name: 'GlobeNewswire Management Changes', region: 'issuer-paid executive appointments', url: 'https://www.globenewswire.com/RssFeed/subjectcode/86-Management%20Changes/feedTitle/GlobeNewswire%20-%20Management%20Changes' },
  { name: 'PR Newswire News Releases', region: 'issuer-paid company press releases', url: 'https://www.prnewswire.com/rss/news-releases-list.rss' },
];

const THEMES = [
  { id: 'semiconductors', symbols: ['NVDA', 'AMD', 'TSM', 'SOXX'], terms: ['ai chip', 'semiconductor', 'gpu', 'datacenter', 'data center'] },
  { id: 'consumer', symbols: ['AMZN', 'WMT', 'COST', 'TGT', 'XLY'], terms: ['retail', 'consumer', 'sales', 'spending', 'holiday'] },
  { id: 'mega-cap-tech', symbols: ['AAPL', 'MSFT', 'GOOGL', 'META', 'QQQ'], terms: ['cloud', 'software', 'advertising', 'iphone', 'search'] },
  { id: 'energy', symbols: ['XLE', 'XOM', 'CVX'], terms: ['oil', 'gas', 'opec', 'energy', 'crude'] },
  { id: 'industrial-defense', symbols: ['LMT', 'RTX', 'CAT', 'XLI'], terms: ['defense', 'aerospace', 'infrastructure', 'manufacturing'] },
  { id: 'financials', symbols: ['JPM', 'BAC', 'XLF'], terms: ['bank', 'credit', 'loan', 'yield curve'] },
  { id: 'broad-market', symbols: ['SPY', 'QQQ', 'DIA', 'IWM'], terms: ['fed', 'inflation', 'rates', 'recession', 'jobs'] },
];

const POSITIVE_TERMS = ['beat', 'growth', 'surge', 'record', 'strong', 'rally', 'upbeat', 'profit', 'expand', 'accelerate'];
const NEGATIVE_TERMS = ['miss', 'fall', 'slump', 'weak', 'risk', 'warning', 'cut', 'lawsuit', 'recession', 'slowdown'];

async function runAutonomousResearch({ userId, watchlist = DEFAULT_UNIVERSE, researchRunId, onEvent = () => {} } = {}) {
  const meshConversation = brainMesh.startConversation({
    userId,
    topic: `autonomous-research${researchRunId ? `:${researchRunId}` : ''}`,
    metadata: { researchRunId, watchlist },
  });
  meshTell({
    conversation: meshConversation,
    from: 'brain.research.source',
    to: ['brain.discovery.company', 'brain.research.chat', 'brain.model.neural'],
    op: 'research.run.started',
    body: { watchlist, researchRunId },
    userId,
    researchRunId,
  });
  emit(onEvent, 'source-scan', 8, 'info', 'Collecting market, news, macro, and consumer-sales inputs.', {
    watchlist,
  });

  const [learned, news, macro, consumer, jsonDatasets, businessFormation, businessDynamics, energyFuel, vehicleSalesContext, blsPricingContext, consumerGoodsContext, finvizContext, tradingViewContext, yahooFinanceContext, nasdaqContext, marketBeatContext, wallStreetZenContext, finraContext, ownershipContext, federalAwardsContext, dodContractsContext, disasterContext, naturalEventContext, humanitarianContext, refugeeContext, historicalDisasterContext, earthquakeContext, weatherAlertContext, nuclearEventContext, wildfireContext, droughtContext] = await Promise.all([
    sourceLearning.collectLearnedResearch({ userId, researchRunId, onEvent }),
    collectNews(onEvent, { userId }),
    collectMacroData(onEvent),
    collectConsumerSales(userId, onEvent),
    jsonDatasetIndicators.collectJsonDatasetIndicators({ onEvent }),
    cachedSource(`businessFormation:${userId}`, STAT_SOURCE_TTL_MS, () => censusBfs.collectBusinessFormationStatistics({ userId, onEvent })),
    cachedSource(`businessDynamics:${userId}`, STAT_SOURCE_TTL_MS, () => censusBds.collectBusinessDynamicsStatistics({ userId, onEvent })),
    cachedSource(`energyFuel:${userId}`, STAT_SOURCE_TTL_MS, () => eiaEnergy.collectEnergyFuelContext({ userId, onEvent })),
    cachedSource(`vehicleSales:${userId}`, STAT_SOURCE_TTL_MS, () => vehicleSales.collectVehicleSalesContext({ userId, onEvent })),
    cachedSource(`blsPricing:${userId}`, STAT_SOURCE_TTL_MS, () => blsPricing.collectBlsPricingContext({ userId, onEvent })),
    cachedSource('consumerGoodsIndustry', STAT_SOURCE_TTL_MS, () => consumerGoodsIndustry.collectConsumerGoodsIndustryContext({ onEvent })),
    cachedSource('finviz', STAT_SOURCE_TTL_MS, () => finvizScreener.collectFinvizScreenerContext({ onEvent })),
    cachedSource('tradingView', STAT_SOURCE_TTL_MS, () => tradingViewScreener.collectTradingViewScreenerContext({ onEvent })),
    cachedSource('yahooFinance', STAT_SOURCE_TTL_MS, () => yahooFinanceScreener.collectYahooFinanceScreenerContext({ onEvent })),
    cachedSource('nasdaq', STAT_SOURCE_TTL_MS, () => nasdaqMarketResearch.collectNasdaqMarketResearchContext({ onEvent })),
    cachedSource('marketBeat', STAT_SOURCE_TTL_MS, () => marketBeatAnalyst.collectMarketBeatAnalystContext({ onEvent })),
    cachedSource('wallStreetZen', STAT_SOURCE_TTL_MS, () => wallStreetZen.collectWallStreetZenContext({ onEvent })),
    cachedSource('finra', STAT_SOURCE_TTL_MS, () => finraMarketData.collectFinraMarketContext({ onEvent })),
    cachedSource(`ownership:${userId}`, STAT_SOURCE_TTL_MS, () => secInstitutionalOwnership.collectInstitutionalOwnershipContext({ userId, onEvent })),
    cachedSource('usaspendingAwards', STAT_SOURCE_TTL_MS, () => usaspendingAwards.collectFederalAwardsContext({
      limit: 30,
      awardType: 'contracts',
      awardingAgency: 'Department of Defense',
      dateRange: { start: `${new Date().getUTCFullYear() - 1}-01-01`, end: `${new Date().getUTCFullYear()}-12-31` },
      onEvent,
    })),
    cachedSource('dodContracts', STAT_SOURCE_TTL_MS, () => dodContracts.collectDodContractsContext({
      limit: 24,
      searchTerms: ['lockheed', 'boeing', 'palantir', 'foreign'],
      onEvent,
    })),
    cachedSource('gdacsDisaster', HAZARD_SOURCE_TTL_MS, () => gdacsDisasters.collectDisasterContext({ onEvent })),
    cachedSource('eonetNaturalEvent', HAZARD_SOURCE_TTL_MS, () => eonetNaturalEvents.collectNaturalEventContext({ onEvent })),
    cachedSource(`humanitarian:${userId}`, HAZARD_SOURCE_TTL_MS, () => reliefWebHumanitarian.collectHumanitarianContext({ userId, onEvent })),
    cachedSource('refugeeStats', STAT_SOURCE_TTL_MS, () => unhcrRefugees.collectRefugeeStatisticsContext({ onEvent })),
    cachedSource('historicalDisaster', STAT_SOURCE_TTL_MS, () => emdatHistoricalDisasters.collectHistoricalDisasterContext({ onEvent })),
    cachedSource('earthquake', HAZARD_SOURCE_TTL_MS, () => usgsEarthquakes.collectEarthquakeContext({ onEvent })),
    cachedSource(`weatherAlert:${userId}`, HAZARD_SOURCE_TTL_MS, () => nwsWeatherAlerts.collectWeatherAlertContext({ userId, onEvent })),
    cachedSource('nuclearEvent', HAZARD_SOURCE_TTL_MS, () => nrcNuclearEvents.collectNuclearEventContext({ onEvent })),
    cachedSource('wildfire', HAZARD_SOURCE_TTL_MS, () => nifcWildfires.collectWildfireContext({ onEvent })),
    cachedSource('drought', STAT_SOURCE_TTL_MS, () => usDroughtMonitor.collectDroughtContext({ onEvent })),
  ]);
  meshTell({
    conversation: meshConversation,
    from: 'brain.research.source',
    to: ['brain.discovery.company', 'brain.research.chat'],
    op: 'research.collection.ready',
    body: {
      learnedObservations: learned.observations.length,
      learnedSources: learned.learnedSources.length,
      newsItems: news.items.length,
      macroIndicators: macro.indicators.length,
      consumerReports: consumer.reports.length,
      jsonDatasetSources: jsonDatasets.sourceList?.length || 0,
      businessFormationAvailable: businessFormation.available,
      businessFormationMomentum: businessFormation.momentum,
      businessDynamicsAvailable: businessDynamics.available,
      businessDynamicsMomentum: businessDynamics.momentum,
      energyFuelAvailable: energyFuel.available,
      energyFuelMomentum: energyFuel.momentum,
      vehicleSalesAvailable: vehicleSalesContext.available,
      vehicleSalesMomentum: vehicleSalesContext.momentum,
      blsPricingAvailable: blsPricingContext.available,
      blsPricingMomentum: blsPricingContext.momentum,
      blsPricingSeriesCount: blsPricingContext.seriesCount,
      blsMarginPressureScore: blsPricingContext.scores?.marginPressure,
      blsAffordabilityRiskScore: blsPricingContext.scores?.affordabilityRisk,
      consumerGoodsIndustryAvailable: consumerGoodsContext.available,
      consumerGoodsIndustryMomentum: consumerGoodsContext.momentum,
      consumerGoodsIndustrySignalCount: consumerGoodsContext.signalCount,
      consumerGoodsIndustryScore: consumerGoodsContext.industryScore,
      amazonBestsellerAvailable: consumer.amazonBestsellers?.available || false,
      amazonBestsellerDemandBias: consumer.amazonBestsellers?.demandBias,
      amazonBestsellerSignalCount: consumer.amazonBestsellers?.signalCount || 0,
      walmartRetailAvailable: consumer.walmartRetailDemand?.available || false,
      walmartRetailDemandBias: consumer.walmartRetailDemand?.demandBias,
      walmartRetailSignalCount: consumer.walmartRetailDemand?.signalCount || 0,
      finvizAvailable: finvizContext.available,
      finvizMomentum: finvizContext.momentum,
      finvizSignalCount: finvizContext.signalCount,
      tradingViewAvailable: tradingViewContext.available,
      tradingViewMomentum: tradingViewContext.momentum,
      tradingViewSignalCount: tradingViewContext.signalCount,
      yahooFinanceAvailable: yahooFinanceContext.available,
      yahooFinanceMomentum: yahooFinanceContext.momentum,
      yahooFinanceSignalCount: yahooFinanceContext.signalCount,
      nasdaqAvailable: nasdaqContext.available,
      nasdaqMomentum: nasdaqContext.momentum,
      nasdaqSignalCount: nasdaqContext.signalCount,
      nasdaqEarningsCatalysts: nasdaqContext.earningsCatalystCount,
      nasdaqIpoCatalysts: nasdaqContext.ipoCatalystCount,
      marketBeatAvailable: marketBeatContext.available,
      marketBeatMomentum: marketBeatContext.momentum,
      marketBeatSignalCount: marketBeatContext.signalCount,
      marketBeatBullishCount: marketBeatContext.bullishCount,
      marketBeatBearishCount: marketBeatContext.bearishCount,
      marketBeatTargetChanges: marketBeatContext.targetChangeCount,
      wallStreetZenAvailable: wallStreetZenContext.available,
      wallStreetZenMomentum: wallStreetZenContext.momentum,
      wallStreetZenSignalCount: wallStreetZenContext.signalCount,
      wallStreetZenRatedCount: wallStreetZenContext.ratedCount,
      wallStreetZenTickerPages: wallStreetZenContext.tickerPageCount,
      finraAvailable: finraContext.available,
      finraMomentum: finraContext.momentum,
      finraTradeSignalCount: finraContext.tradeSignalCount,
      finraCreditStressScore: finraContext.creditStressScore,
      finraRefinancingPressureScore: finraContext.refinancingPressureScore,
      ownershipAvailable: ownershipContext.available,
      ownershipMomentum: ownershipContext.momentum,
      ownershipEntryCount: ownershipContext.entryCount,
      ownershipActivistSignals: ownershipContext.activistSignalCount,
      ownershipInstitutionalSignals: ownershipContext.institutionalSignalCount,
      federalAwardsAvailable: federalAwardsContext.available,
      federalAwardsMomentum: federalAwardsContext.momentum,
      federalAwardsReturned: federalAwardsContext.returnedAwardCount,
      federalAwardsDefenseSignals: federalAwardsContext.defenseAwardCount,
      federalAwardsConflictInferences: federalAwardsContext.inferredConflictAwardCount,
      dodContractsAvailable: dodContractsContext.available,
      dodContractsMomentum: dodContractsContext.momentum,
      dodContractsCount: dodContractsContext.contractCount,
      dodContractsValue: dodContractsContext.totalAnnouncedValue,
      dodContractsInnovationSignals: dodContractsContext.innovationContractCount,
      disasterAlertsAvailable: disasterContext.available,
      disasterRiskMomentum: disasterContext.momentum,
      naturalEventsAvailable: naturalEventContext.available,
      naturalEventMomentum: naturalEventContext.momentum,
      humanitarianReportsAvailable: humanitarianContext.available,
      humanitarianMomentum: humanitarianContext.momentum,
      refugeeStatisticsAvailable: refugeeContext.available,
      refugeeMomentum: refugeeContext.momentum,
      historicalDisastersAvailable: historicalDisasterContext.available,
      historicalDisasterMomentum: historicalDisasterContext.momentum,
      earthquakesAvailable: earthquakeContext.available,
      earthquakeMomentum: earthquakeContext.momentum,
      weatherAlertsAvailable: weatherAlertContext.available,
      weatherAlertMomentum: weatherAlertContext.momentum,
      nuclearEventsAvailable: nuclearEventContext.available,
      nuclearEventMomentum: nuclearEventContext.momentum,
      wildfiresAvailable: wildfireContext.available,
      wildfireMomentum: wildfireContext.momentum,
      droughtAvailable: droughtContext.available,
      droughtMomentum: droughtContext.momentum,
    },
    userId,
    researchRunId,
  });

  const valuableArticles = selectValuableArticles(news.items);
  if (valuableArticles.length) {
    emit(onEvent, 'crawlee-article-deep-crawl', 12, 'info', 'Following headline links of valuable articles for deeper research leads.', {
      articles: valuableArticles.map((article) => ({ title: article.title, url: article.link })),
    });
  }
  const deepCrawlResults = await Promise.allSettled(
    valuableArticles.map((article) => brainMesh.ask({
      from: 'brain.research.source',
      to: ['brain.research.source'],
      op: 'crawler.crawl',
      ctx: { userId },
      body: {
        urls: [article.link],
        queries: [article.title || ''].filter(Boolean),
        maxRequests: 24,
        maxWaves: 4,
        minContinuationScore: 1.85,
        maxRuntimeMs: 90 * 1000,
      },
    }, { timeoutMs: 100_000 }).then((askResult) => {
      const body = askResult.replies?.find((reply) => reply.kind === 'reply')?.body || {};
      for (const event of body.events || []) onEvent(event);
      return body;
    }))
  );
  learned.entityLeads = learned.entityLeads || [];
  learned.entityLeads.push(...(news.entityLeads || []));
  for (const result of deepCrawlResults) {
    if (result.status !== 'fulfilled') continue;
    learned.observations.push(
      ...(result.value.pages || []).map((page) => ({ title: page.title, excerpt: page.excerpt, url: page.url }))
    );
    learned.entityLeads.push(...(result.value.entityLeads || []));
  }

  const comprehension = await articleComprehension.comprehendArticles({
    userId,
    articles: valuableArticles.map((article) => ({ title: article.title, url: article.link, excerpt: article.description })),
    onEvent,
  });
  if (comprehension.inferredCompanies.length) {
    learned.entityLeads.push(
      ...comprehension.inferredCompanies.map((company) => ({
        key: `llm:${(company.symbol || company.name).toLowerCase()}`,
        name: company.name,
        symbol: company.symbol,
        type: 'llm-inferred',
        score: 6,
        evidence: [{ title: 'LLM article comprehension', url: '', reason: company.reason }],
      }))
    );
  }
  if (comprehension.followUpQueries.length) {
    emit(onEvent, 'article-comprehension-crawl', 13, 'info', 'Crawling follow-up questions generated from article comprehension.', {
      queries: comprehension.followUpQueries,
    });
    try {
      const followUpAsk = await brainMesh.ask({
        from: 'brain.research.source',
        to: ['brain.research.source'],
        op: 'crawler.search',
        ctx: { userId },
        body: { queries: comprehension.followUpQueries, maxRequests: 12, maxWaves: 2 },
      }, { timeoutMs: 45_000 });
      const followUpResult = followUpAsk.replies?.find((reply) => reply.kind === 'reply')?.body || {};
      for (const event of followUpResult.events || []) onEvent(event);
      learned.observations.push(
        ...(followUpResult.pages || []).map((page) => ({ title: page.title, excerpt: page.excerpt, url: page.url }))
      );
      learned.entityLeads.push(...(followUpResult.entityLeads || []));
    } catch (error) {
      logger.warn('Follow-up crawl from article comprehension failed', { error: error.message });
    }
  }

  const reasonedQuestions = await researchQuestionReasoning.reasonFollowUpQuestions({
    sources: {
      macro, consumer, energyFuel, blsPricingContext, consumerGoodsContext, disasterContext, weatherAlertContext, droughtContext,
      humanitarianContext, businessFormation, finvizContext, tradingViewContext, yahooFinanceContext, nasdaqContext, marketBeatContext, wallStreetZenContext, finraContext, ownershipContext, federalAwardsContext, dodContractsContext,
    },
    news,
    onEvent,
  }).catch((error) => {
    logger.warn('Research-question reasoning failed', { error: error.message });
    return { questions: [] };
  });
  if (reasonedQuestions.questions.length) {
    emit(onEvent, 'research-reasoning-crawl', 21, 'info', 'Crawling follow-up questions reasoned by the local LLM from data-source snapshots.', {
      queries: reasonedQuestions.questions,
    });
    try {
      const reasonedAsk = await brainMesh.ask({
        from: 'brain.research.source',
        to: ['brain.research.source'],
        op: 'crawler.search',
        ctx: { userId },
        body: { queries: reasonedQuestions.questions, maxRequests: 14, maxWaves: 2 },
      }, { timeoutMs: 45_000 });
      const reasonedResult = reasonedAsk.replies?.find((reply) => reply.kind === 'reply')?.body || {};
      for (const event of reasonedResult.events || []) onEvent(event);
      learned.observations.push(
        ...(reasonedResult.pages || []).map((page) => ({ title: page.title, excerpt: page.excerpt, url: page.url }))
      );
      learned.entityLeads.push(...(reasonedResult.entityLeads || []));
    } catch (error) {
      logger.warn('Follow-up crawl from LLM-reasoned questions failed', { error: error.message });
    }
  }

  const crawledDiscoveredCompanies = await filterCandidatesByAlpacaEligibility({
    userId,
    candidates: companyDiscovery.discoverCompanies({ news, learned, maxCandidates: 36 }),
    onEvent,
    phase: 'crawled-company-discovery',
  });
  const entityExpandedCompanies = await expandEntityLeadsWithAlpacaThenFinnhub({
    userId,
    entityLeads: learned.entityLeads || [],
    onEvent,
  });
  const initialDiscoveredCompanies = mergeDiscoveredCompanies(crawledDiscoveredCompanies, entityExpandedCompanies).slice(0, 42);
  meshTell({
    conversation: meshConversation,
    from: 'brain.discovery.company',
    to: ['brain.research.chat', 'brain.intelligence.company'],
    op: 'candidate.discovery.ready',
    body: {
      candidates: initialDiscoveredCompanies.slice(0, 12).map((candidate) => ({
        symbol: candidate.symbol,
        companyName: candidate.companyName,
        themeHits: candidate.themeHits,
        method: candidate.discovery?.method,
        reason: candidate.discovery?.evidence?.[0]?.reason,
      })),
      entityLeads: (learned.entityLeads || []).slice(0, 12).map((lead) => ({
        name: lead.name,
        symbol: lead.symbol,
        score: lead.score,
      })),
    },
    userId,
    researchRunId,
  });
  const chatResearchResult = await chatResearch.runChatResearch({
    userId,
    news,
    learned,
    macro,
    consumer,
    jsonDatasets,
    businessFormation,
    businessDynamics,
    energyFuel,
    vehicleSales: vehicleSalesContext,
    finvizContext,
    tradingViewContext,
    yahooFinanceContext,
    nasdaqContext,
    marketBeatContext,
    wallStreetZenContext,
    finraContext,
    ownershipContext,
    federalAwardsContext,
    dodContractsContext,
    disasterContext,
    naturalEventContext,
    humanitarianContext,
    refugeeContext,
    historicalDisasterContext,
    earthquakeContext,
    weatherAlertContext,
    nuclearEventContext,
    wildfireContext,
    droughtContext,
    discoveredCompanies: initialDiscoveredCompanies,
    onEvent,
  });
  meshTell({
    conversation: meshConversation,
    from: 'brain.research.chat',
    to: ['brain.research.source', 'brain.discovery.company'],
    op: 'chat.research.ready',
    body: {
      providers: chatResearchResult.providers.map((provider) => ({
        provider: provider.provider,
        available: provider.available,
        skipped: provider.skipped,
        error: provider.error,
      })),
      candidateHints: chatResearchResult.candidateHints.slice(0, 12),
      sourceHints: chatResearchResult.sourceHints.slice(0, 12),
    },
    userId,
    researchRunId,
  });
  const prePlan = await applyAlpacaPrePlanEligibility(
    buildPrePlan({ watchlist, news, macro, consumer, learned, jsonDatasets, businessFormation, businessDynamics, energyFuel, vehicleSales: vehicleSalesContext, blsPricingContext, consumerGoodsContext, finvizContext, tradingViewContext, yahooFinanceContext, nasdaqContext, marketBeatContext, wallStreetZenContext, finraContext, ownershipContext, federalAwardsContext, dodContractsContext, disasterContext, naturalEventContext, humanitarianContext, refugeeContext, historicalDisasterContext, earthquakeContext, weatherAlertContext, nuclearEventContext, wildfireContext, droughtContext, chatResearch: chatResearchResult, discoveredCompanies: initialDiscoveredCompanies }),
    { userId, onEvent }
  );
  meshTell({
    conversation: meshConversation,
    from: 'brain.discovery.company',
    to: ['brain.intelligence.company', 'brain.model.neural', 'brain.playbook.investor'],
    op: 'preplan.ready',
    body: {
      thesis: prePlan.thesis,
      candidates: prePlan.candidates.map((candidate) => ({
        symbol: candidate.symbol,
        theme: candidate.theme,
        themeHits: candidate.themeHits,
        fromChat: Boolean(candidate.chatResearch),
        fromCrawl: Boolean(candidate.discovery),
      })).slice(0, 30),
    },
    userId,
    researchRunId,
  });
  emit(onEvent, 'pre-plan', 38, 'debug', 'Generated first-pass opportunity map from news themes, crawled company discovery, and economic context.', {
    candidates: prePlan.candidates.map((c) => c.symbol),
    discoveredCompanies: prePlan.discoveredCompanies.map((c) => ({ symbol: c.symbol, score: c.themeHits, reason: c.discovery?.evidence?.[0]?.reason })),
    themes: prePlan.themes.slice(0, 6),
  });

  const quotes = await collectQuotes(prePlan.candidates.map((c) => c.symbol), { userId, onEvent });
  const companyIntel = await companyIntelligence.researchCompanies({
    userId,
    candidates: prePlan.candidates,
    macro,
    consumer,
    quotes,
    news,
    learned,
    onEvent,
  });
  const investorPlaybookSummary = investorPlaybook.getPlaybookSummary();
  // Geo footprint refresh runs entirely off the idle path (idleResearchService)
  // now; live cycles only read the cached profile below, never trigger research.
  const scored = scoreCandidates({ userId, candidates: prePlan.candidates, quotes, news, macro, consumer, learned, companyIntel, jsonDatasets, businessFormation, businessDynamics, energyFuel, vehicleSalesContext, blsPricingContext, consumerGoodsContext, finvizContext, tradingViewContext, yahooFinanceContext, nasdaqContext, marketBeatContext, wallStreetZenContext, finraContext, ownershipContext, federalAwardsContext, dodContractsContext, disasterContext, naturalEventContext, humanitarianContext, refugeeContext, historicalDisasterContext, earthquakeContext, weatherAlertContext, nuclearEventContext, wildfireContext, droughtContext, onEvent });

  for (const signal of scored) {
    try {
      const candidate = prePlan.candidates.find((c) => c.symbol === signal.symbol);
      watcherAgentService.ensureWatcherAgent(userId, {
        symbol: signal.symbol,
        companyName: candidate?.companyName,
        price: signal.price,
        theme: candidate?.theme,
      });
    } catch (error) {
      logger.warn('Failed to ensure watcher agent for symbol', { symbol: signal.symbol, error: error.message });
    }
  }

  meshTell({
    conversation: meshConversation,
    from: 'brain.model.neural',
    to: ['brain.reporting', 'brain.evaluation'],
    op: 'candidate.scores.ready',
    body: {
      scored: scored.slice(0, 12).map((signal) => ({
        symbol: signal.symbol,
        localAiScore: signal.localAiScore,
        actionBias: signal.actionBias,
        theme: signal.theme,
      })),
    },
    userId,
    researchRunId,
  });

  emit(onEvent, 'financial-evaluation', 72, 'debug', 'Financial resource pass complete; ranking candidates by blended signal score.', {
    top: scored.slice(0, 6).map((s) => ({ symbol: s.symbol, score: s.localAiScore, actionBias: s.actionBias })),
  });

  const snapshot = researchRepo.create({
    userId,
    source: 'autonomous:news-macro-consumer-market',
    summary: {
      watchlist,
      fetchedAt: new Date().toISOString(),
      sourceStack: [
        ...learned.learnedSources.slice(0, 20).map((source) => ({
          name: source.title || source.url,
          type: `learned:${source.source_type}`,
          url: source.url,
          relevanceScore: source.relevance_score,
          credibilityScore: source.credibility_score,
          discoveryMethod: source.discovery_method,
        })),
        ...news.sources,
        ...macro.sources,
        ...consumer.sources,
        ...jsonDatasets.sourceList,
        ...businessFormation.sourceList,
        ...businessDynamics.sourceList,
        ...energyFuel.sourceList,
        ...vehicleSalesContext.sourceList,
        ...blsPricingContext.sourceList,
        ...consumerGoodsContext.sourceList,
        ...finvizContext.sourceList,
        ...tradingViewContext.sourceList,
        ...yahooFinanceContext.sourceList,
        ...nasdaqContext.sourceList,
        ...marketBeatContext.sourceList,
        ...wallStreetZenContext.sourceList,
        ...finraContext.sourceList,
        ...ownershipContext.sourceList,
        ...federalAwardsContext.sourceList,
        ...dodContractsContext.sourceList,
        ...disasterContext.sourceList,
        ...naturalEventContext.sourceList,
        ...humanitarianContext.sourceList,
        ...refugeeContext.sourceList,
        ...historicalDisasterContext.sourceList,
        ...earthquakeContext.sourceList,
        ...weatherAlertContext.sourceList,
        ...nuclearEventContext.sourceList,
        ...wildfireContext.sourceList,
        ...droughtContext.sourceList,
        {
          name: investorPlaybookSummary.title,
          type: investorPlaybookSummary.source?.type || 'local-research-artifact',
          url: investorPlaybookSummary.source?.path || 'tmp/data.json',
          investorCount: investorPlaybookSummary.investorCount,
        },
        {
          name: 'SEC company submissions API',
          type: 'regulatory-filings-api',
          url: 'https://data.sec.gov/submissions/CIK##########.json',
          tickerDirectoryUrl: 'https://www.sec.gov/files/company_tickers.json',
        },
        { name: 'Finnhub quote API', type: 'market-data', url: 'https://finnhub.io/docs/api/quote' },
        { name: 'Yahoo Finance chart scrape fallback', type: 'market-data', url: 'https://query1.finance.yahoo.com/v8/finance/chart/SPY' },
        { name: 'Stooq CSV quote scrape fallback', type: 'market-data', url: 'https://stooq.com/q/l/' },
      ],
      newsBrief: news.items.slice(0, 10),
      gdelt: news.gdelt ? {
        available: news.gdelt.available,
        summary: news.gdelt.summary,
        articleCount: news.gdelt.articles?.length || 0,
        entityLeadCount: news.gdelt.entityLeads?.length || 0,
        failures: news.gdelt.failures || [],
      } : null,
      learnedResearch: {
        observations: learned.observations.slice(0, 12).map((item) => ({
          url: item.url,
          title: item.title,
          excerpt: item.excerpt,
          score: item.score,
          followedLinks: item.links.slice(0, 5),
        })),
        discovered: learned.discovered,
        entityLeads: learned.entityLeads || [],
      },
      chatResearch: chatResearchResult,
      discoveredCompanies: prePlan.discoveredCompanies,
      macro,
      consumer,
      businessFormation,
      businessDynamics,
      energyFuel,
      blsPricingContext,
      consumerGoodsContext,
      finvizContext,
      tradingViewContext,
      yahooFinanceContext,
      nasdaqContext,
      marketBeatContext,
      wallStreetZenContext,
      finraContext,
      ownershipContext,
      federalAwardsContext,
      dodContractsContext,
      disasterContext,
      naturalEventContext,
      humanitarianContext,
      refugeeContext,
      historicalDisasterContext,
      earthquakeContext,
      weatherAlertContext,
      nuclearEventContext,
      wildfireContext,
      droughtContext,
      prePlan,
      evaluator: {
        localModel: 'brain.js NeuralNetwork via persisted JSON model',
        fallback: false,
        features: [
          'momentum',
          'volatility',
          'news sentiment',
          'theme pressure',
          'macro risk',
          'consumer strength',
          'broker factor intelligence',
          'high-earning investor indicator playbook',
          'public JSON dataset context',
          'Census business formation momentum',
          'Census business dynamics trend',
          'EIA fuel and energy price-volume pressure',
          'BEA/FRED aggregate vehicle-sales demand momentum',
          'BLS CPI, selected average-price, and PPI pricing pressure, affordability risk, and margin-pressure context',
          'Stock Analysis, Yahoo Finance, CompaniesMarketCap, and Fortune consumer-goods industry discovery, revenue-rank, valuation, market-cap, profit, and dividend comparison context',
          'FINVIZ scraped screener technical/fundamental/analyst/insider signals',
          'TradingView scraped screener momentum, pre-market, all-time-high, and sector-leadership signals',
          'Yahoo Finance scraped screener, analyst-rating, market-mover, and company-page signals',
          'Nasdaq scraped market-activity, earnings/IPO catalyst, analyst-research, institutional-holdings, and insider-activity signals',
          'GDACS global disaster alert and exposure risk',
          'NASA EONET natural-event and satellite-imagery risk',
          'ReliefWeb humanitarian disaster and report impact risk',
          'UNHCR Refugee Statistics forced-displacement origin/host country pressure',
          'EM-DAT historical disaster impact and economic-loss modeling',
          'USGS earthquake catalog and real-time seismic risk',
          'NWS active U.S. weather alert operational risk',
          'NRC nuclear event notifications and power reactor status risk',
          'NIFC/WFIGS wildfire perimeter, containment, acres, and preparedness-level risk',
          'U.S. Drought Monitor weekly drought classification and DSCI risk',
          'DoD/War.gov daily major contract announcements for contractor revenue catalysts, product/service demand, place-of-performance, funding-source, and contracting-activity signals',
        ],
      },
      jsonDatasets,
      investorPlaybook: investorPlaybookSummary,
      companyWorkspace: companyIntel.records.map((record) => ({
        symbol: record.symbol,
        companyName: record.company_name,
        compositeScore: record.summary.compositeScore,
        summary: record.summary.summary,
        factors: record.summary.factors,
      })),
      reportNarrative: buildResearchNarrative({ scored, news, macro, consumer, learned, investorPlaybookSummary, jsonDatasets, businessFormation, businessDynamics, energyFuel, vehicleSales: vehicleSalesContext, consumerGoodsContext, finvizContext, tradingViewContext, yahooFinanceContext, nasdaqContext, marketBeatContext, wallStreetZenContext, finraContext, ownershipContext, federalAwardsContext, dodContractsContext, disasterContext, naturalEventContext, humanitarianContext, refugeeContext, historicalDisasterContext, earthquakeContext, weatherAlertContext, nuclearEventContext, wildfireContext, droughtContext }),
      evidence: quotes.map((q) => ({
        symbol: q.symbol,
        current: q.current,
        open: q.open,
        high: q.high,
        low: q.low,
        prevClose: q.prevClose,
        changePct: Number((q.changePct || 0).toFixed(2)),
      })),
    },
    signals: scored,
  });

  emit(onEvent, 'snapshot', 78, 'info', 'Persisted autonomous research snapshot.', {
    snapshotId: snapshot.id,
    signalCount: snapshot.signals.length,
  });
  meshTell({
    conversation: meshConversation,
    from: 'brain.reporting',
    to: ['brain.evaluation', 'brain.research.source'],
    op: 'research.snapshot.persisted',
    body: {
      snapshotId: snapshot.id,
      signalCount: snapshot.signals.length,
      top: snapshot.signals.slice(0, 5).map((signal) => ({ symbol: signal.symbol, score: signal.localAiScore })),
    },
    userId,
    researchRunId,
  });

  logger.info('Autonomous research complete', { userId, snapshotId: snapshot.id, signalCount: scored.length });
  return snapshot;
}

async function expandEntityLeadsWithAlpacaThenFinnhub({ userId, entityLeads = [], onEvent }) {
  if (!entityLeads.length) return [];
  const expanded = [];
  const unresolved = [];
  for (const lead of entityLeads.slice(0, 36)) {
    const alpacaResult = await alpacaAssetClient.evaluateCompanyLead(lead, {
      userId,
      source: 'autonomous-entity-expansion',
    });
    if (alpacaResult.eligible && alpacaResult.symbol) {
      expanded.push(entityLeadToCandidate(
        lead,
        alpacaResult.symbol,
        alpacaResult.companyName || lead.name,
        'crawled-entity-alpaca-lookup',
        alpacaResult.asset
      ));
    } else if (alpacaResult.degraded || alpacaResult.reason === 'alpaca-not-configured' || alpacaResult.reason === 'alpaca-assets-lookup-failed') {
      unresolved.push(lead);
    } else {
      emit(onEvent, 'alpaca-symbol-eligibility', 32, 'warn', 'Excluded crawled entity because Alpaca does not report it as tradable.', {
        entity: lead.name,
        symbol: lead.symbol || alpacaResult.symbol,
        reason: alpacaResult.reason,
      });
    }
  }
  if (expanded.length) {
    emit(onEvent, 'alpaca-symbol-eligibility', 33, 'debug', 'Mapped crawled entities through Alpaca asset lookup before Finnhub.', {
      expanded: expanded.slice(0, 12).map((item) => ({ symbol: item.symbol, companyName: item.companyName, score: item.themeHits })),
      unresolved: unresolved.length,
    });
  }
  if (!unresolved.length) return expanded;

  const finnhubCredentials = userId ? providerCredentialRepo.getSecret(userId, 'finnhub') : null;
  const apiKey = finnhubCredentials?.apiKey || config.finnhubApiKey;
  if (!apiKey) {
    if (unresolved.length) {
      emit(onEvent, 'entity-expansion', 33, 'warn', 'Crawled entity leads found, but Finnhub search is unavailable; retaining direct ticker leads only.', {
        entityLeads: unresolved.slice(0, 10).map((lead) => ({ name: lead.name, symbol: lead.symbol, score: lead.score })),
      });
    }
    const direct = unresolved
      .filter((lead) => lead.symbol)
      .map((lead) => entityLeadToCandidate(lead, lead.symbol, lead.name, 'crawled-direct-ticker'));
    return filterCandidatesByAlpacaEligibility({
      userId,
      candidates: [...expanded, ...direct],
      onEvent,
      phase: 'direct-entity-without-finnhub',
    });
  }

  const finnhubExpanded = [];
  const searchable = unresolved
    .filter((lead) => lead.name && !lead.symbol)
    .sort((a, b) => b.score - a.score)
    .slice(0, 24);
  for (const lead of searchable) {
    try {
      const matches = await finnhub.searchSymbol(lead.name, { apiKey });
      const match = matches.find((item) => item.type === 'Common Stock' && /^[A-Z.]{1,7}$/.test(item.symbol)) || matches.find((item) => /^[A-Z.]{1,7}$/.test(item.symbol));
      if (!match) continue;
      const eligible = await alpacaAssetClient.evaluateSymbol(match.symbol, {
        userId,
        companyName: match.description || lead.name,
        source: 'finnhub-symbol-search-after-alpaca',
      });
      if (eligible.eligible) {
        finnhubExpanded.push(entityLeadToCandidate(lead, eligible.symbol || match.symbol, eligible.companyName || match.description || lead.name, 'crawled-entity-finnhub-search', eligible.asset));
      } else {
        emit(onEvent, 'alpaca-symbol-eligibility', 34, 'warn', 'Excluded Finnhub symbol match because Alpaca does not report it as tradable.', {
          entity: lead.name,
          symbol: match.symbol,
          reason: eligible.reason,
        });
      }
    } catch (err) {
      emit(onEvent, 'entity-expansion', 34, 'warn', 'Finnhub symbol search failed for crawled entity lead.', {
        entity: lead.name,
        error: err.message,
      });
    }
  }
  for (const lead of unresolved.filter((item) => item.symbol).slice(0, 24)) {
    const eligible = await alpacaAssetClient.evaluateSymbol(lead.symbol, {
      userId,
      companyName: lead.name,
      source: 'direct-entity-symbol-after-alpaca',
    });
    if (eligible.eligible) {
      finnhubExpanded.push(entityLeadToCandidate(lead, eligible.symbol || lead.symbol, eligible.companyName || lead.name, 'crawled-direct-ticker', eligible.asset));
    }
  }
  emit(onEvent, 'entity-expansion', 35, 'debug', 'Expanded crawled entity leads into quoteable company candidates.', {
    entityLeads: entityLeads.length,
    expanded: [...expanded, ...finnhubExpanded].slice(0, 12).map((item) => ({ symbol: item.symbol, companyName: item.companyName, score: item.themeHits })),
  });
  return [...expanded, ...finnhubExpanded];
}

function entityLeadToCandidate(lead, symbol, companyName, method = null, alpacaAsset = null) {
  return {
    symbol: String(symbol || '').toUpperCase(),
    companyName: companyName || lead.name || symbol,
    theme: 'crawled-entity-expansion',
    themeHits: Math.max(2.2, Number(lead.score || 0)),
    discovery: {
      method: method || (lead.symbol ? 'crawled-direct-ticker' : 'crawled-entity-finnhub-search'),
      tags: ['entity-lead', lead.type || 'company', alpacaAsset?.tradable ? 'alpaca-tradable' : null].filter(Boolean),
      evidence: (lead.evidence || []).slice(0, 5).map((item) => ({
        title: item.title,
        url: item.url,
        reason: `${item.reason}; mapped to ${symbol}`,
      })),
    },
    evidence: (lead.evidence || []).map((item) => item.reason).slice(0, 5),
    alpacaAsset: alpacaAsset?.tradable ? {
      symbol: alpacaAsset.symbol,
      name: alpacaAsset.name,
      exchange: alpacaAsset.exchange,
      status: alpacaAsset.status,
      tradable: alpacaAsset.tradable,
    } : undefined,
  };
}

async function filterCandidatesByAlpacaEligibility({ userId, candidates, onEvent, phase }) {
  const { kept, excluded } = await alpacaAssetClient.filterCandidates(candidates || [], {
    userId,
    source: phase || 'autonomous-research',
  });
  if (excluded.length) {
    emit(onEvent, 'alpaca-symbol-eligibility', 36, 'warn', 'Excluded non-tradable Alpaca symbols from research candidates.', {
      phase,
      excluded: excluded.slice(0, 12).map((item) => ({
        symbol: item.symbol,
        companyName: item.companyName,
        reason: item.alpacaEligibility?.reason,
      })),
    });
  }
  return kept;
}

async function applyAlpacaPrePlanEligibility(prePlan, { userId, onEvent }) {
  const candidates = await filterCandidatesByAlpacaEligibility({
    userId,
    candidates: prePlan.candidates,
    onEvent,
    phase: 'preplan-final-candidates',
  });
  return {
    ...prePlan,
    candidates,
    excludedSymbols: settingsRepoSafeExcluded(userId),
  };
}

function settingsRepoSafeExcluded(userId) {
  try {
    const settingsRepo = require('../db/repositories/settingsRepo');
    return settingsRepo.getExcludedSymbols(userId);
  } catch {
    return [];
  }
}

function mergeDiscoveredCompanies(...lists) {
  const map = new Map();
  for (const item of lists.flat()) {
    if (!item?.symbol) continue;
    const symbol = item.symbol.toUpperCase();
    const existing = map.get(symbol);
    if (!existing) {
      map.set(symbol, { ...item, symbol });
      continue;
    }
    existing.themeHits = Math.max(existing.themeHits || 0, item.themeHits || 0);
    existing.theme = existing.theme === item.theme ? existing.theme : `${existing.theme}+${item.theme}`;
    existing.discovery = existing.discovery || item.discovery;
    if (existing.discovery && item.discovery?.evidence) {
      existing.discovery.evidence = [...(existing.discovery.evidence || []), ...item.discovery.evidence].slice(0, 8);
    }
  }
  return [...map.values()].sort((a, b) => (b.themeHits || 0) - (a.themeHits || 0));
}

async function collectQuotes(symbols, { userId, onEvent }) {
  const uniqueSymbols = [...new Set(symbols)].slice(0, 30);
  const finnhubCredentials = userId ? providerCredentialRepo.getSecret(userId, 'finnhub') : null;
  const finnhubApiKey = finnhubCredentials?.apiKey || config.finnhubApiKey;
  let quotes = [];
  if (finnhubApiKey) {
    emit(onEvent, 'market-data', 48, 'debug', 'Checking Finnhub quote data before scrape fallback.', { symbols: uniqueSymbols });
    quotes = await finnhub.getQuotes(uniqueSymbols, { apiKey: finnhubApiKey });
  }
  if (!quotes.length) {
    emit(onEvent, 'market-data', 50, 'warn', 'No Finnhub credits/data available; using Yahoo/Stooq web scrape fallback.', {
      symbols: uniqueSymbols,
    });
    quotes = await webScrapeClient.getQuotes(uniqueSymbols);
  }
  return quotes;
}

async function collectNews(onEvent, { userId } = {}) {
  const [rssSettled, gdeltResult] = await Promise.all([
    Promise.allSettled(
      NEWS_FEEDS.map(async (feed) => {
        try {
          const text = await fetchText(feed.url, 7000);
          return { feed, items: parseRssItems(text, feed).slice(0, 8) };
        } catch (error) {
          error.feed = feed;
          throw error;
        }
      })
    ),
    gdeltDoc.collectGdeltResearch({ onEvent }),
  ]);

  const items = [];
  const sources = [];
  const entityLeads = [];
  for (const result of rssSettled) {
    if (result.status === 'fulfilled') {
      sources.push({ name: result.value.feed.name, type: 'news-rss', region: result.value.feed.region, url: result.value.feed.url });
      items.push(...result.value.items);
    } else {
      emit(onEvent, 'news', 18, 'warn', 'News source unavailable; continuing with remaining feeds.', {
        error: result.reason.message,
      });
      const fallback = await crawlNewsFeedFallback(result.reason.feed, { userId });
      if (fallback.items.length) {
        sources.push({ name: result.reason.feed.name, type: 'news-rss-bmcl-fallback', region: result.reason.feed.region, url: result.reason.feed.url });
        items.push(...fallback.items);
        emit(onEvent, 'news', 19, 'info', 'Recovered news source via BMCL crawl fallback.', {
          feed: result.reason.feed.name,
          articles: fallback.items.length,
        });
      } else if (fallback.reason) {
        emit(onEvent, 'news', 19, 'debug', 'BMCL crawl fallback did not recover the news source.', {
          feed: result.reason.feed.name,
          reason: fallback.reason,
        });
      }
    }
  }
  if (gdeltResult?.articles?.length) {
    items.push(...gdeltResult.articles);
    sources.push(...gdeltResult.sources);
    entityLeads.push(...gdeltResult.entityLeads);
  }
  emit(onEvent, 'news', 24, 'debug', 'News scan complete.', {
    articles: items.length,
    sources: sources.length,
    gdeltArticles: gdeltResult?.articles?.length || 0,
    gdeltEntityLeads: entityLeads.length,
  });
  return {
    items: dedupeNewsItems(items),
    sources,
    entityLeads,
    gdelt: gdeltResult,
  };
}

async function crawlNewsFeedFallback(feed, { userId } = {}) {
  if (!feed?.url) return { items: [], reason: 'No feed URL to fall back on.' };
  try {
    const result = await brainMesh.ask({
      from: 'brain.research.source',
      to: ['brain.research.source'],
      op: 'crawler.crawl',
      ctx: { userId },
      body: { urls: [feed.url] },
    }, { timeoutMs: 15000 });
    const reply = result.replies.find((item) => item.kind === 'reply')?.body;
    if (!reply?.ok || !reply.pages?.length) {
      return { items: [], reason: reply?.reason || 'BMCL crawl fallback returned no pages.' };
    }
    const items = reply.pages
      .filter((page) => page.excerpt || page.title)
      .map((page) => ({
        source: feed.name,
        region: feed.region,
        title: page.title || feed.name,
        link: page.url,
        publishedAt: null,
        description: String(page.excerpt || '').slice(0, 280),
      }));
    return { items, reason: items.length ? null : 'BMCL crawl fallback pages had no usable content.' };
  } catch (error) {
    return { items: [], reason: error.message };
  }
}

async function collectMacroData(onEvent) {
  const worldBankUrl = 'https://api.worldbank.org/v2/country/WLD/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=3';
  const usInflationUrl = 'https://api.worldbank.org/v2/country/US/indicator/FP.CPI.TOTL.ZG?format=json&per_page=3';
  const payload = { indicators: [], sources: [] };
  const requests = [
    { id: 'world-gdp-growth', name: 'World GDP growth', url: worldBankUrl },
    { id: 'us-cpi-inflation', name: 'US CPI inflation', url: usInflationUrl },
  ];

  for (const req of requests) {
    try {
      const data = await fetchJson(req.url, 7000);
      const latest = Array.isArray(data?.[1]) ? data[1].find((row) => row.value !== null) : null;
      if (latest) {
        payload.indicators.push({
          id: req.id,
          name: req.name,
          period: latest.date,
          value: Number(latest.value.toFixed(2)),
          source: 'World Bank',
        });
        payload.sources.push({ name: `World Bank ${req.name}`, type: 'macro-api', url: req.url });
      }
    } catch (err) {
      emit(onEvent, 'macro', 28, 'warn', 'Macro source unavailable; continuing with partial context.', {
        source: req.name,
        error: err.message,
      });
    }
  }

  payload.riskBias = inferMacroRisk(payload.indicators);
  emit(onEvent, 'macro', 31, 'debug', 'Global macro scan complete.', {
    indicators: payload.indicators.length,
    riskBias: payload.riskBias,
  });
  return payload;
}

async function collectConsumerSales(userId, onEvent) {
  const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=RSAFS';
  const payload = { reports: [], sources: [], consumerBias: 'neutral', retailTrade: null, amazonBestsellers: null, walmartRetailDemand: null };
  try {
    const csv = await fetchText(url, 7000);
    const rows = csv.trim().split(/\r?\n/).slice(1).filter(Boolean);
    const latest = rows.at(-1);
    const prior = rows.at(-2);
    if (latest) {
      const [period, value] = latest.split(',');
      const [, priorValue] = prior?.split(',') || [];
      const numericValue = Number(value);
      const changePct = Number(priorValue) ? ((numericValue - Number(priorValue)) / Number(priorValue)) * 100 : 0;
      payload.reports.push({
        name: 'US advance retail and food services sales',
        period,
        value: numericValue,
        unit: 'millions USD',
        seasonallyAdjusted: true,
        monthOverMonthPct: Number(changePct.toFixed(2)),
        source: 'FRED RSAFS / US Census retail sales',
      });
      payload.sources.push({ name: 'FRED RSAFS retail and food services sales', type: 'consumer-sales-csv', url });
    }
  } catch (err) {
    emit(onEvent, 'consumer-sales', 34, 'warn', 'Consumer sales report unavailable; using news-derived consumer proxy.', {
      error: err.message,
    });
  }
  try {
    const retailTrade = await censusRetailTrade.collectRetailTradeContext({ userId, timeoutMs: 7000, onEvent });
    payload.retailTrade = censusRetailTrade.compactForBmcl(retailTrade);
    payload.sources.push(...(retailTrade.sourceList || []));
    payload.reports.push({
      name: 'Census retail/trade category demand and inventory context',
      period: retailTrade.datasets?.find((dataset) => dataset.latestPeriod)?.latestPeriod || null,
      consumerBias: retailTrade.consumerBias,
      retailDemandScore: retailTrade.retailDemandScore,
      inventoryPressureScore: retailTrade.inventoryPressureScore,
      demandSlowdownScore: retailTrade.demandSlowdownScore,
      rows: retailTrade.rows,
      seriesCount: retailTrade.seriesCount,
      source: 'Census MRTS/MARTS/MTIS and ARTS/AIES',
      caveat: retailTrade.caveat,
    });
  } catch (err) {
    emit(onEvent, 'consumer-sales', 34, 'warn', 'Census retail/trade context unavailable; continuing with FRED retail proxy.', {
      error: err.message,
    });
  }
  try {
    const amazonContext = await cachedSource('amazonBestsellers', STAT_SOURCE_TTL_MS, () =>
      amazonBestsellers.collectAmazonBestsellerContext({ timeoutMs: 9000, limit: 20, onEvent }));
    payload.amazonBestsellers = amazonBestsellers.compactForBmcl(amazonContext);
    payload.sources.push(...(amazonContext.sourceList || []));
    payload.reports.push({
      name: 'Amazon bestseller and Movers & Shakers product-rank context',
      demandBias: amazonContext.demandBias,
      productMomentumScore: amazonContext.productMomentumScore,
      accelerationScore: amazonContext.accelerationScore,
      stableDemandScore: amazonContext.stableDemandScore,
      signalCount: amazonContext.signalCount,
      categoryCount: amazonContext.categoryCount,
      source: 'Amazon Best Sellers and Movers & Shakers',
      caveat: amazonContext.caveat,
    });
  } catch (err) {
    emit(onEvent, 'consumer-sales', 34, 'warn', 'Amazon bestseller context unavailable; continuing with official retail proxies.', {
      error: err.message,
    });
  }
  try {
    const walmartContext = await cachedSource('walmartRetailDemand', STAT_SOURCE_TTL_MS, () =>
      walmartRetailDemand.collectWalmartRetailDemandContext({ timeoutMs: 9000, limit: 24, onEvent }));
    payload.walmartRetailDemand = walmartRetailDemand.compactForBmcl(walmartContext);
    payload.sources.push(...(walmartContext.sourceList || []));
    payload.reports.push({
      name: 'Walmart bestseller, trending, and availability product-demand context',
      demandBias: walmartContext.demandBias,
      productDemandScore: walmartContext.productDemandScore,
      trendAccelerationScore: walmartContext.trendAccelerationScore,
      availabilityPressureScore: walmartContext.availabilityPressureScore,
      signalCount: walmartContext.signalCount,
      categoryCount: walmartContext.categoryCount,
      source: 'Walmart bestsellers, trending, and category pages',
      caveat: walmartContext.caveat,
    });
  } catch (err) {
    emit(onEvent, 'consumer-sales', 34, 'warn', 'Walmart retail demand context unavailable; continuing with official retail proxies.', {
      error: err.message,
    });
  }
  const latestChange = payload.reports[0]?.monthOverMonthPct;
  const fredBias = latestChange > 0.3 ? 'constructive' : latestChange < -0.3 ? 'softening' : payload.reports.length ? 'neutral' : 'neutral';
  const censusBias = payload.retailTrade?.consumerBias || 'neutral';
  const amazonBias = payload.amazonBestsellers?.demandBias || 'unavailable';
  const walmartBias = payload.walmartRetailDemand?.demandBias || 'unavailable';
  payload.consumerBias = fredBias === 'softening' || censusBias === 'softening' ? 'softening'
    : fredBias === 'constructive' || censusBias === 'constructive' || amazonBias === 'accelerating' || walmartBias === 'accelerating' ? 'constructive'
      : 'neutral';
  emit(onEvent, 'consumer-sales', 35, 'debug', 'Consumer sales scan complete.', {
    reports: payload.reports.length,
    consumerBias: payload.consumerBias,
  });
  return payload;
}

function buildPrePlan({ watchlist, news, macro, consumer, learned, jsonDatasets, businessFormation, businessDynamics, energyFuel, vehicleSales, consumerGoodsContext, finvizContext, tradingViewContext, yahooFinanceContext, nasdaqContext, marketBeatContext, wallStreetZenContext, finraContext, ownershipContext, federalAwardsContext, dodContractsContext, disasterContext, naturalEventContext, humanitarianContext, refugeeContext, historicalDisasterContext, earthquakeContext, weatherAlertContext, nuclearEventContext, wildfireContext, droughtContext, chatResearch: chatResearchResult, discoveredCompanies: providedDiscoveredCompanies }) {
  const text = [
    news.items.map((item) => `${item.title} ${item.description}`).join(' '),
    learned.observations.map((item) => `${item.title} ${item.excerpt}`).join(' '),
  ].join(' ').toLowerCase();
  const themes = THEMES.map((theme) => {
    const hits = theme.terms.reduce((count, term) => count + occurrences(text, term), 0);
    return {
      id: theme.id,
      hits,
      symbols: theme.symbols,
      rationale: hits
        ? `${theme.id} appeared ${hits} time(s) in the collected news stream.`
        : `${theme.id} kept as a baseline market comparison.`,
    };
  }).sort((a, b) => b.hits - a.hits);

  const candidateMap = new Map();
  for (const symbol of watchlist) candidateMap.set(symbol, { symbol, theme: 'watchlist', themeHits: 0 });
  for (const theme of themes.slice(0, 4)) {
    for (const symbol of theme.symbols) {
      const existing = candidateMap.get(symbol);
      candidateMap.set(symbol, {
        symbol,
        theme: existing?.theme === 'watchlist' ? `${existing.theme}+${theme.id}` : theme.id,
        themeHits: Math.max(existing?.themeHits || 0, theme.hits),
      });
    }
  }
  const discoveredCompanies = providedDiscoveredCompanies || companyDiscovery.discoverCompanies({ news, learned });
  for (const discovered of discoveredCompanies) {
    const existing = candidateMap.get(discovered.symbol);
    candidateMap.set(discovered.symbol, {
      symbol: discovered.symbol,
      companyName: discovered.companyName,
      theme: existing?.theme ? `${existing.theme}+crawled-discovery` : discovered.theme,
      themeHits: Math.max(existing?.themeHits || 0, discovered.themeHits),
      discovery: discovered.discovery,
    });
  }
  for (const finvizSignal of finvizContext?.records?.slice(0, 36) || []) {
    const existing = candidateMap.get(finvizSignal.symbol);
    const discovery = {
      method: 'finviz-screener',
      tags: ['finviz', 'stock-screener', 'scraped-market-screener', finvizSignal.screenId, finvizSignal.stance].filter(Boolean),
      evidence: [{
        title: `FINVIZ ${finvizSignal.signal}`,
        url: finvizSignal.sourceUrl,
        reason: finvizSignal.reason,
      }],
    };
    candidateMap.set(finvizSignal.symbol, {
      symbol: finvizSignal.symbol,
      companyName: finvizSignal.companyName || existing?.companyName,
      theme: existing?.theme ? `${existing.theme}+finviz-${finvizSignal.screenId}` : `finviz-${finvizSignal.screenId}`,
      themeHits: Math.max(existing?.themeHits || 0, 2 + (finvizSignal.signalScore || 50) / 12),
      discovery: existing?.discovery || discovery,
      finvizSignal,
    });
  }
  for (const tradingViewSignal of tradingViewContext?.records?.slice(0, 36) || []) {
    const existing = candidateMap.get(tradingViewSignal.symbol);
    const discovery = {
      method: 'tradingview-screener',
      tags: ['tradingview', 'stock-screener', 'scraped-market-screener', tradingViewSignal.screenId, tradingViewSignal.stance].filter(Boolean),
      evidence: [{
        title: `TradingView ${tradingViewSignal.signal}`,
        url: tradingViewSignal.sourceUrl,
        reason: tradingViewSignal.reason,
      }],
    };
    candidateMap.set(tradingViewSignal.symbol, {
      symbol: tradingViewSignal.symbol,
      companyName: tradingViewSignal.companyName || existing?.companyName,
      theme: existing?.theme ? `${existing.theme}+tradingview-${tradingViewSignal.screenId}` : `tradingview-${tradingViewSignal.screenId}`,
      themeHits: Math.max(existing?.themeHits || 0, 2 + (tradingViewSignal.signalScore || 50) / 12),
      discovery: existing?.discovery || discovery,
      tradingViewSignal,
    });
  }
  for (const yahooFinanceSignal of yahooFinanceContext?.records?.slice(0, 36) || []) {
    const existing = candidateMap.get(yahooFinanceSignal.symbol);
    const discovery = {
      method: 'yahoo-finance-screener',
      tags: ['yahoo-finance', 'stock-screener', 'scraped-market-screener', yahooFinanceSignal.screenId, yahooFinanceSignal.stance].filter(Boolean),
      evidence: [{
        title: `Yahoo Finance ${yahooFinanceSignal.signal}`,
        url: yahooFinanceSignal.sourceUrl,
        reason: yahooFinanceSignal.reason,
      }],
    };
    candidateMap.set(yahooFinanceSignal.symbol, {
      symbol: yahooFinanceSignal.symbol,
      companyName: yahooFinanceSignal.companyName || existing?.companyName,
      theme: existing?.theme ? `${existing.theme}+yahoo-${yahooFinanceSignal.screenId}` : `yahoo-${yahooFinanceSignal.screenId}`,
      themeHits: Math.max(existing?.themeHits || 0, 2 + (yahooFinanceSignal.signalScore || 50) / 12),
      discovery: existing?.discovery || discovery,
      yahooFinanceSignal,
    });
  }
  for (const consumerGoodsSignal of consumerGoodsContext?.records?.slice(0, 36) || []) {
    if (!consumerGoodsSignal.symbol) continue;
    const existing = candidateMap.get(consumerGoodsSignal.symbol);
    const discovery = {
      method: 'consumer-goods-industry',
      tags: ['consumer-goods', 'household-personal-products', 'industry-ranking', 'scraped-comparison', consumerGoodsSignal.provider, consumerGoodsSignal.focus].filter(Boolean),
      evidence: [{
        title: consumerGoodsSignal.sourceLabel,
        url: consumerGoodsSignal.sourceUrl,
        reason: consumerGoodsSignal.reason,
      }],
    };
    candidateMap.set(consumerGoodsSignal.symbol, {
      symbol: consumerGoodsSignal.symbol,
      companyName: consumerGoodsSignal.companyName || existing?.companyName,
      theme: existing?.theme ? `${existing.theme}+consumer-goods-industry` : 'consumer-goods-industry',
      themeHits: Math.max(existing?.themeHits || 0, 2 + (consumerGoodsSignal.signalScore || 50) / 12),
      discovery: existing?.discovery || discovery,
      consumerGoodsSignal,
    });
  }
  for (const nasdaqSignal of nasdaqContext?.records?.slice(0, 36) || []) {
    const existing = candidateMap.get(nasdaqSignal.symbol);
    const discovery = {
      method: 'nasdaq-market-research',
      tags: ['nasdaq', 'market-research', 'scraped-market-screener', nasdaqSignal.screenId, nasdaqSignal.stance].filter(Boolean),
      evidence: [{
        title: `Nasdaq ${nasdaqSignal.signal}`,
        url: nasdaqSignal.sourceUrl,
        reason: nasdaqSignal.reason,
      }],
    };
    candidateMap.set(nasdaqSignal.symbol, {
      symbol: nasdaqSignal.symbol,
      companyName: nasdaqSignal.companyName || existing?.companyName,
      theme: existing?.theme ? `${existing.theme}+nasdaq-${nasdaqSignal.screenId}` : `nasdaq-${nasdaqSignal.screenId}`,
      themeHits: Math.max(existing?.themeHits || 0, 2 + (nasdaqSignal.signalScore || 50) / 12),
      discovery: existing?.discovery || discovery,
      nasdaqSignal,
    });
  }
  for (const marketBeatSignal of marketBeatContext?.records?.slice(0, 36) || []) {
    const existing = candidateMap.get(marketBeatSignal.symbol);
    const discovery = {
      method: 'marketbeat-analyst-research',
      tags: ['marketbeat', 'analyst-recommendations', 'broker-actions', 'scraped-market-screener', marketBeatSignal.screenId, marketBeatSignal.stance].filter(Boolean),
      evidence: [{
        title: `MarketBeat ${marketBeatSignal.signal}`,
        url: marketBeatSignal.sourceUrl,
        reason: marketBeatSignal.reason,
      }],
    };
    candidateMap.set(marketBeatSignal.symbol, {
      symbol: marketBeatSignal.symbol,
      companyName: marketBeatSignal.companyName || existing?.companyName,
      theme: existing?.theme ? `${existing.theme}+marketbeat-${marketBeatSignal.screenId}` : `marketbeat-${marketBeatSignal.screenId}`,
      themeHits: Math.max(existing?.themeHits || 0, 2 + (marketBeatSignal.signalScore || 50) / 12),
      discovery: existing?.discovery || discovery,
      marketBeatSignal,
    });
  }
  for (const wallStreetZenSignal of wallStreetZenContext?.records?.slice(0, 36) || []) {
    const existing = candidateMap.get(wallStreetZenSignal.symbol);
    const discovery = {
      method: 'wallstreetzen-quant-research',
      tags: ['wallstreetzen', 'zen-ratings', 'quant-ratings', 'stock-screener', 'scraped-market-screener', wallStreetZenSignal.screenId, wallStreetZenSignal.stance].filter(Boolean),
      evidence: [{
        title: `WallStreetZen ${wallStreetZenSignal.signal}`,
        url: wallStreetZenSignal.sourceUrl,
        reason: wallStreetZenSignal.reason,
      }],
    };
    candidateMap.set(wallStreetZenSignal.symbol, {
      symbol: wallStreetZenSignal.symbol,
      companyName: wallStreetZenSignal.companyName || existing?.companyName,
      theme: existing?.theme ? `${existing.theme}+wallstreetzen-${wallStreetZenSignal.screenId}` : `wallstreetzen-${wallStreetZenSignal.screenId}`,
      themeHits: Math.max(existing?.themeHits || 0, 2 + (wallStreetZenSignal.signalScore || 50) / 12),
      discovery: existing?.discovery || discovery,
      wallStreetZenSignal,
    });
  }
  for (const finraSignal of finraContext?.tradeSignals?.slice(0, 36) || []) {
    if (!finraSignal.symbol) continue;
    const existing = candidateMap.get(finraSignal.symbol);
    const discovery = {
      method: 'finra-fixed-income-credit-risk',
      tags: ['finra', 'fixed-income', 'corporate-bonds', 'credit-risk', 'bond-trade-activity', finraSignal.creditStance].filter(Boolean),
      evidence: [{
        title: `FINRA ${finraSignal.creditStance} bond signal`,
        url: finraSignal.sourceUrl,
        reason: finraSignal.reason,
      }],
    };
    candidateMap.set(finraSignal.symbol, {
      symbol: finraSignal.symbol,
      companyName: finraSignal.issuer || existing?.companyName,
      theme: existing?.theme ? `${existing.theme}+finra-credit-${finraSignal.creditStance}` : `finra-credit-${finraSignal.creditStance}`,
      themeHits: Math.max(existing?.themeHits || 0, 2 + Math.max(0, (finraContext.riskScore || 50) - 40) / 10),
      discovery: existing?.discovery || discovery,
      finraSignal,
    });
  }

  for (const ownershipSignal of ownershipContext?.entries?.slice(0, 48) || []) {
    const symbol = ownershipSignal.symbol;
    if (!symbol) continue;
    const existing = candidateMap.get(symbol);
    const evidence = {
      method: 'sec-institutional-ownership',
      tags: ['sec', '13f', '13d', '13g', 'institutional-holdings', 'beneficial-ownership', ownershipSignal.signalType].filter(Boolean),
      evidence: [{
        title: `SEC ${ownershipSignal.formType} ownership signal`,
        url: ownershipSignal.url,
        reason: `${ownershipSignal.filerName || 'SEC filer'} filed ${ownershipSignal.formType}${ownershipSignal.percentOwned ? ` reporting ${ownershipSignal.percentOwned}% ownership` : ''}. ${ownershipSignal.caveat || ''}`.trim(),
      }],
    };
    candidateMap.set(symbol, {
      ...(existing || {}),
      symbol,
      companyName: existing?.companyName || ownershipSignal.issuerName,
      theme: existing?.theme ? `${existing.theme}+sec-ownership-${ownershipSignal.signalType}` : `sec-ownership-${ownershipSignal.signalType}`,
      themeHits: Math.max(existing?.themeHits || 0, 2 + Math.max(0, (ownershipSignal.influenceScore || 50) - 45) / 10),
      discovery: mergeDiscovery(existing?.discovery, evidence),
      ownershipSignal,
    });
  }
  for (const hint of chatResearchResult?.candidateHints || []) {
    const existing = candidateMap.get(hint.symbol);
    const discovery = {
      method: 'chat-research',
      tags: ['chat-research'],
      evidence: [{
        title: `${hint.providers?.join(', ') || 'chat'} research hint`,
        url: hint.sourceUrls?.[0],
        reason: hint.reasons?.[0] || hint.reason,
      }],
    };
    candidateMap.set(hint.symbol, {
      symbol: hint.symbol,
      companyName: hint.companyName || existing?.companyName,
      theme: existing?.theme ? `${existing.theme}+chat-research` : 'chat-research',
      themeHits: Math.max(existing?.themeHits || 0, 2 + (hint.confidence || 0.5) * 8),
      discovery: existing?.discovery || discovery,
      chatResearch: hint,
    });
  }

  return {
    thesis:
      'Start broad with US/world news, crawled web intelligence, macro risk, and consumer demand, then let discovered products/companies create quote-backed candidates.',
    macroRiskBias: macro.riskBias,
    consumerBias: consumer.consumerBias,
    jsonDatasetRiskScore: jsonDatasets?.compositeRiskScore,
    jsonDatasetOpportunityScore: jsonDatasets?.opportunityScore,
    businessFormationMomentum: businessFormation?.momentum,
    businessFormationOpportunityScore: businessFormation?.opportunityScore,
    businessDynamicsMomentum: businessDynamics?.momentum,
    businessDynamicsOpportunityScore: businessDynamics?.opportunityScore,
    energyFuelMomentum: energyFuel?.momentum,
    energyFuelOpportunityScore: energyFuel?.opportunityScore,
    energyFuelRiskScore: energyFuel?.riskScore,
    vehicleSalesMomentum: vehicleSales?.momentum,
    vehicleSalesOpportunityScore: vehicleSales?.opportunityScore,
    vehicleSalesRiskScore: vehicleSales?.riskScore,
    finvizMomentum: finvizContext?.momentum,
    finvizOpportunityScore: finvizContext?.opportunityScore,
    finvizRiskScore: finvizContext?.riskScore,
    finvizSignalCount: finvizContext?.signalCount,
    tradingViewMomentum: tradingViewContext?.momentum,
    tradingViewOpportunityScore: tradingViewContext?.opportunityScore,
    tradingViewRiskScore: tradingViewContext?.riskScore,
    tradingViewSectorLeadershipScore: tradingViewContext?.sectorLeadershipScore,
    tradingViewSignalCount: tradingViewContext?.signalCount,
    yahooFinanceMomentum: yahooFinanceContext?.momentum,
    yahooFinanceOpportunityScore: yahooFinanceContext?.opportunityScore,
    yahooFinanceRiskScore: yahooFinanceContext?.riskScore,
    yahooFinanceSignalCount: yahooFinanceContext?.signalCount,
    yahooFinanceAnalystSignalCount: yahooFinanceContext?.analystSignalCount,
    nasdaqMomentum: nasdaqContext?.momentum,
    nasdaqOpportunityScore: nasdaqContext?.opportunityScore,
    nasdaqRiskScore: nasdaqContext?.riskScore,
    nasdaqSignalCount: nasdaqContext?.signalCount,
    nasdaqEarningsCatalystCount: nasdaqContext?.earningsCatalystCount,
    nasdaqIpoCatalystCount: nasdaqContext?.ipoCatalystCount,
    marketBeatMomentum: marketBeatContext?.momentum,
    marketBeatOpportunityScore: marketBeatContext?.opportunityScore,
    marketBeatRiskScore: marketBeatContext?.riskScore,
    marketBeatSignalCount: marketBeatContext?.signalCount,
    marketBeatTargetChangeCount: marketBeatContext?.targetChangeCount,
    wallStreetZenMomentum: wallStreetZenContext?.momentum,
    wallStreetZenOpportunityScore: wallStreetZenContext?.opportunityScore,
    wallStreetZenRiskScore: wallStreetZenContext?.riskScore,
    wallStreetZenSignalCount: wallStreetZenContext?.signalCount,
    wallStreetZenRatedCount: wallStreetZenContext?.ratedCount,
    finraMomentum: finraContext?.momentum,
    finraCreditStressScore: finraContext?.creditStressScore,
    finraRefinancingPressureScore: finraContext?.refinancingPressureScore,
    finraEquityCreditDivergenceScore: finraContext?.equityCreditDivergenceScore,
    finraRiskScore: finraContext?.riskScore,
    finraTradeSignalCount: finraContext?.tradeSignalCount,
    ownershipMomentum: ownershipContext?.momentum,
    ownershipOpportunityScore: ownershipContext?.opportunityScore,
    ownershipRiskScore: ownershipContext?.riskScore,
    ownershipActivistPressureScore: ownershipContext?.activistPressureScore,
    ownershipInstitutionalDemandScore: ownershipContext?.institutionalDemandScore,
    ownershipEntryCount: ownershipContext?.entryCount,
    federalAwardsMomentum: federalAwardsContext?.momentum,
    federalAwardsOpportunityScore: federalAwardsContext?.opportunityScore,
    federalAwardsRiskScore: federalAwardsContext?.riskScore,
    federalAwardsGovernmentDemandScore: federalAwardsContext?.governmentDemandScore,
    federalAwardsDefenseDemandScore: federalAwardsContext?.defenseDemandScore,
    federalAwardsReturnedCount: federalAwardsContext?.returnedAwardCount,
    federalAwardsConflictInferences: federalAwardsContext?.inferredConflictAwardCount,
    dodContractsMomentum: dodContractsContext?.momentum,
    dodContractsOpportunityScore: dodContractsContext?.opportunityScore,
    dodContractsRiskScore: dodContractsContext?.riskScore,
    dodContractsDefenseDemandScore: dodContractsContext?.defenseDemandScore,
    dodContractsInnovationDemandScore: dodContractsContext?.innovationDemandScore,
    dodContractsCount: dodContractsContext?.contractCount,
    disasterRiskMomentum: disasterContext?.momentum,
    disasterRiskScore: disasterContext?.riskScore,
    disasterRecoveryOpportunityScore: disasterContext?.recoveryOpportunityScore,
    naturalEventMomentum: naturalEventContext?.momentum,
    naturalEventRiskScore: naturalEventContext?.riskScore,
    naturalEventRecoveryOpportunityScore: naturalEventContext?.recoveryOpportunityScore,
    humanitarianMomentum: humanitarianContext?.momentum,
    humanitarianRiskScore: humanitarianContext?.riskScore,
    humanitarianAidRequirementScore: humanitarianContext?.aidRequirementScore,
    refugeeMomentum: refugeeContext?.momentum,
    refugeeDisplacementPressureScore: refugeeContext?.displacementPressureScore,
    refugeeAidDemandScore: refugeeContext?.aidDemandScore,
    historicalDisasterMomentum: historicalDisasterContext?.momentum,
    historicalDisasterRiskScore: historicalDisasterContext?.riskScore,
    historicalDisasterEconomicLossScore: historicalDisasterContext?.economicLossModelingScore,
    earthquakeMomentum: earthquakeContext?.momentum,
    earthquakeRiskScore: earthquakeContext?.riskScore,
    earthquakeRecoveryOpportunityScore: earthquakeContext?.recoveryOpportunityScore,
    weatherAlertMomentum: weatherAlertContext?.momentum,
    weatherAlertRiskScore: weatherAlertContext?.riskScore,
    weatherAlertRecoveryOpportunityScore: weatherAlertContext?.recoveryOpportunityScore,
    nuclearEventMomentum: nuclearEventContext?.momentum,
    nuclearEventRiskScore: nuclearEventContext?.riskScore,
    nuclearReactorOutageScore: nuclearEventContext?.reactorOutageScore,
    nuclearServicesOpportunityScore: nuclearEventContext?.nuclearServicesOpportunityScore,
    wildfireMomentum: wildfireContext?.momentum,
    wildfireRiskScore: wildfireContext?.riskScore,
    wildfireRecoveryOpportunityScore: wildfireContext?.recoveryOpportunityScore,
    droughtMomentum: droughtContext?.momentum,
    droughtRiskScore: droughtContext?.riskScore,
    droughtAgricultureRiskScore: droughtContext?.agricultureRiskScore,
    droughtFoodInflationRiskScore: droughtContext?.foodInflationRiskScore,
    learnedSourceCount: learned.learnedSources.length,
    learnedObservationCount: learned.observations.length,
    discoveredCompanies,
    chatResearchCandidateCount: chatResearchResult?.candidateHints?.length || 0,
    chatResearchSourceHintCount: chatResearchResult?.sourceHints?.length || 0,
    themes,
    candidates: [...candidateMap.values()]
      .sort((a, b) => {
        const aDiscovery = a.discovery ? 1 : 0;
        const bDiscovery = b.discovery ? 1 : 0;
        return bDiscovery - aDiscovery || (b.themeHits || 0) - (a.themeHits || 0);
      })
      .slice(0, 30),
  };
}

function mergeDiscovery(existing, next) {
  if (!existing) return next;
  if (!next) return existing;
  return {
    ...existing,
    method: [existing.method, next.method].filter(Boolean).join('+'),
    tags: [...new Set([...(existing.tags || []), ...(next.tags || [])])].slice(0, 12),
    evidence: [...(existing.evidence || []), ...(next.evidence || [])].slice(0, 10),
  };
}

function scoreCandidates({ userId, candidates, quotes, news, macro, consumer, learned, companyIntel, jsonDatasets, businessFormation, businessDynamics, energyFuel, vehicleSalesContext, consumerGoodsContext, finvizContext, tradingViewContext, yahooFinanceContext, nasdaqContext, marketBeatContext, wallStreetZenContext, finraContext, ownershipContext, federalAwardsContext, dodContractsContext, disasterContext, naturalEventContext, humanitarianContext, refugeeContext, historicalDisasterContext, earthquakeContext, weatherAlertContext, nuclearEventContext, wildfireContext, droughtContext, onEvent }) {
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const intelBySymbol = new Map(companyIntel.records.map((record) => [record.symbol, record]));
  const newsText = [
    news.items.map((item) => `${item.title} ${item.description}`).join(' '),
    learned.observations.map((item) => `${item.title} ${item.excerpt}`).join(' '),
  ].join(' ').toLowerCase();
  const { net, record } = buildBrainScorer(userId);
  const scored = [];
  let learnedCategoryMultipliers = {};
  try {
    learnedCategoryMultipliers = eventTrainingLabelRepo.getCategoryMultipliers(userId);
  } catch (err) {
    logger.warn('Could not load learned event-category multipliers', { userId, error: err.message });
  }
  let challengerScorer = null;
  try {
    challengerScorer = challengerScorerService.getPromotedScorer(userId);
  } catch (err) {
    logger.warn('Could not load promoted event-outcome challenger scorer', { userId, error: err.message });
  }

  for (const candidate of candidates) {
    const quote = quoteBySymbol.get(candidate.symbol);
    if (!quote) continue;
    // Attach the coordinator's cached geographic footprint so event weighting can
    // correlate geo events (war/disaster/strike/gas) to this company.
    if (!candidate.locationProfile) {
      candidate.locationProfile = locationCoordinator.getLocationProfile(userId, candidate.symbol) || undefined;
    }
    const changePct = Number((quote.changePct || 0).toFixed(2));
    const volatilityPct = quote.open ? Number((((quote.high - quote.low) / quote.open) * 100).toFixed(2)) : 0;
    const sentiment = sentimentFor(candidate, newsText);
    const macroRisk = macro.riskBias === 'risk-off' ? 0.75 : macro.riskBias === 'risk-on' ? 0.2 : 0.45;
    const consumerStrength = consumer.consumerBias === 'constructive' ? 0.65 : 0.45;
    const factorIntel = companyIntelligence.factorScoreForSymbol(intelBySymbol.get(candidate.symbol));
    const historicalWatchFactors = factorIntel.historicalWatchFactors || [];
    const playbookIntel = investorPlaybook.scoreCandidate({
      candidate,
      quote,
      changePct,
      volatilityPct,
      sentiment,
      macro,
      consumer,
      companyRecord: intelBySymbol.get(candidate.symbol),
      factorIntel,
    });
    const datasetIntel = jsonDatasetIndicators.scoreCandidate({
      candidate,
      companyRecord: intelBySymbol.get(candidate.symbol),
      datasetContext: jsonDatasets,
    });
    const businessFormationIntel = censusBfs.scoreCandidate({
      candidate,
      bfsContext: businessFormation,
    });
    const businessDynamicsIntel = censusBds.scoreCandidate({
      candidate,
      bdsContext: businessDynamics,
    });
    const energyFuelIntel = eiaEnergy.scoreCandidate({
      candidate,
      energyContext: energyFuel,
    });
    const vehicleSalesIntel = vehicleSales.scoreCandidate({
      candidate,
      vehicleSalesContext,
    });
    const consumerGoodsIntel = consumerGoodsIndustry.scoreCandidate({
      candidate,
      consumerGoodsContext,
    });
    const finvizIntel = finvizScreener.scoreCandidate({
      candidate,
      finvizContext,
    });
    const tradingViewIntel = tradingViewScreener.scoreCandidate({
      candidate,
      tradingViewContext,
    });
    const yahooFinanceIntel = yahooFinanceScreener.scoreCandidate({
      candidate,
      yahooFinanceContext,
    });
    const nasdaqIntel = nasdaqMarketResearch.scoreCandidate({
      candidate,
      nasdaqContext,
    });
    const marketBeatIntel = marketBeatAnalyst.scoreCandidate({
      candidate,
      marketBeatContext,
    });
    const wallStreetZenIntel = wallStreetZen.scoreCandidate({
      candidate,
      wallStreetZenContext,
    });
    const finraIntel = finraMarketData.scoreCandidate({
      candidate,
      finraContext,
    });
    const ownershipIntel = secInstitutionalOwnership.scoreCandidate({
      candidate,
      ownershipContext,
    });
    const federalAwardsIntel = usaspendingAwards.scoreCandidate({
      candidate,
      awardsContext: federalAwardsContext,
    });
    const dodContractsIntel = dodContracts.scoreCandidate({
      candidate,
      dodContractsContext,
    });
    const analystGate = analystDecisionGate.evaluateAnalystDecisionGate({
      candidate,
      quote,
      factorIntel,
      marketBeatIntel,
      yahooFinanceIntel,
      nasdaqIntel,
      secOwnershipIntel: ownershipIntel,
      portfolioContext: { userId },
    });
    const disasterIntel = gdacsDisasters.scoreCandidate({
      candidate,
      disasterContext,
    });
    const naturalEventIntel = eonetNaturalEvents.scoreCandidate({
      candidate,
      naturalEventContext,
    });
    const humanitarianIntel = reliefWebHumanitarian.scoreCandidate({
      candidate,
      humanitarianContext,
    });
    const refugeeIntel = unhcrRefugees.scoreCandidate({
      candidate,
      refugeeContext,
    });
    const historicalDisasterIntel = emdatHistoricalDisasters.scoreCandidate({
      candidate,
      historicalDisasterContext,
    });
    const earthquakeIntel = usgsEarthquakes.scoreCandidate({
      candidate,
      earthquakeContext,
    });
    const weatherAlertIntel = nwsWeatherAlerts.scoreCandidate({
      candidate,
      weatherAlertContext,
    });
    const nuclearEventIntel = nrcNuclearEvents.scoreCandidate({
      candidate,
      nuclearEventContext,
    });
    const wildfireIntel = nifcWildfires.scoreCandidate({
      candidate,
      wildfireContext,
    });
    const droughtIntel = usDroughtMonitor.scoreCandidate({
      candidate,
      droughtContext,
    });
    const eventWeightIntel = financialEventWeights.scoreCandidateEvidence({
      candidate,
      news,
      learned,
      chatResearch: candidate.chatResearch,
      learnedCategoryMultipliers,
    });
    try {
      eventOutcomeLabeling.recordCandidateEvents({ userId, candidate, events: eventWeightIntel.topEvents });
    } catch (err) {
      logger.warn('Failed to persist event training labels', { userId, symbol: candidate.symbol, error: err.message });
    }
    const input = {
      momentum: clamp01((changePct + 8) / 16),
      volatility: clamp01(volatilityPct / 8),
      news: clamp01((sentiment + 4) / 8),
      theme: clamp01((candidate.themeHits || 0) / 8),
      macroRisk,
      consumer: consumerStrength,
      brokerFactors: factorIntel.normalized,
      historicalWatchFactors: factorIntel.historicalWatchNormalized ?? 0.5,
      secFilingHistory: factorIntel.secFilingNormalized ?? 0.5,
      investorPlaybook: playbookIntel.normalized,
      jsonDatasets: datasetIntel.normalized,
      businessFormation: businessFormationIntel.normalized,
      businessDynamics: businessDynamicsIntel.normalized,
      energyFuel: energyFuelIntel.normalized,
      vehicleSales: vehicleSalesIntel.normalized,
      consumerGoodsIndustry: consumerGoodsIntel.normalized,
      finvizScreener: finvizIntel.normalized,
      tradingViewScreener: tradingViewIntel.normalized,
      yahooFinanceScreener: yahooFinanceIntel.normalized,
      nasdaqMarketResearch: nasdaqIntel.normalized,
      marketBeatAnalyst: marketBeatIntel.normalized,
      wallStreetZenQuant: wallStreetZenIntel.normalized,
      finraCreditRisk: finraIntel.normalized,
      secOwnership: ownershipIntel.normalized,
      usaspendingAwards: federalAwardsIntel.normalized,
      dodContracts: dodContractsIntel.normalized,
      disasterRisk: disasterIntel.normalized,
      naturalEvents: naturalEventIntel.normalized,
      humanitarianRisk: humanitarianIntel.normalized,
      forcedDisplacement: refugeeIntel.normalized,
      historicalDisasters: historicalDisasterIntel.normalized,
      earthquakeRisk: earthquakeIntel.normalized,
      weatherAlerts: weatherAlertIntel.normalized,
      nuclearEvents: nuclearEventIntel.normalized,
      wildfires: wildfireIntel.normalized,
      droughtRisk: droughtIntel.normalized,
      financialEvents: eventWeightIntel.normalized,
      eventOutcomeConfidence: challengerScorer && eventWeightIntel.topEvents?.length
        ? clamp01(eventWeightIntel.topEvents.reduce((sum, event) => sum + challengerScorer.scoreEvent(event), 0) / eventWeightIntel.topEvents.length)
        : 0.5,
    };
    const output = net.run(input);
    const brainNetScore01 = clamp01(output.score || output[0] || 0);
    const ensemble = ensembleService.scoreEnsemble({
      userId,
      input,
      brainNetScore01,
      trainingData: CANDIDATE_SCORER_TRAINING_DATA,
    });
    const eventScoreAdjustment = clamp(eventWeightIntel.aggregateScore * 2.2, -18, 18);
    const baseLocalAiScore = Number(clamp(ensemble.combined * 100 + eventScoreAdjustment, 0, 100).toFixed(1));
    const priceTierBonusApplied = quote.current > 0 && quote.current < PRICE_TIER_BONUS_THRESHOLD;
    const priceTierAdjustedScore = priceTierBonusApplied
      ? Number(Math.min(100, baseLocalAiScore + PRICE_TIER_BONUS_POINTS).toFixed(1))
      : baseLocalAiScore;
    const watcherSignals = listRecentWatcherSignals(userId, candidate.symbol);
    const watcherBullish = watcherSignals.filter((signal) => signal.predictedAction === 'buy-candidate').length;
    const watcherBearish = watcherSignals.filter((signal) => signal.predictedAction === 'sell-or-avoid').length;
    const watcherSignalAdjustment = watcherBullish >= WATCHER_SIGNAL_MIN_AGREEING
      ? WATCHER_SIGNAL_BONUS_POINTS
      : watcherBearish >= WATCHER_SIGNAL_MIN_AGREEING
        ? -WATCHER_SIGNAL_BONUS_POINTS
        : 0;
    const localAiScore = Number(clamp(priceTierAdjustedScore + watcherSignalAdjustment, 0, 100).toFixed(1));
    const analystGateBlocksBuy = analystGate.analystDriven && !analystGate.passed;
    const actionBias = localAiScore >= 66 && changePct > -2 && !analystGateBlocksBuy
      ? 'buy-candidate'
      : localAiScore <= 36
        ? 'sell-or-avoid'
        : 'hold-watch';
    scored.push({
      symbol: candidate.symbol,
      price: quote.current,
      changePct,
      volatilityPct,
      momentum: changePct > 1 ? 'bullish' : changePct < -1 ? 'bearish' : 'neutral',
      actionBias,
      localAiScore,
      baseLocalAiScore,
      priceTierBonusApplied,
      ensembleMemberScores: ensemble.memberScores,
      theme: candidate.theme,
      themeHits: candidate.themeHits,
      discovery: candidate.discovery || null,
      chatResearch: candidate.chatResearch || null,
      newsSentiment: sentiment,
      macroRisk: macro.riskBias,
      consumerBias: consumer.consumerBias,
      brokerFactorScore: factorIntel.compositeScore,
      investorPlaybookScore: playbookIntel.compositeScore,
      jsonDatasetScore: datasetIntel.compositeScore,
      businessFormationScore: businessFormationIntel.compositeScore,
      businessDynamicsScore: businessDynamicsIntel.compositeScore,
      energyFuelScore: energyFuelIntel.compositeScore,
      vehicleSalesScore: vehicleSalesIntel.compositeScore,
      consumerGoodsIndustryScore: consumerGoodsIntel.compositeScore,
      finvizScreenerScore: finvizIntel.compositeScore,
      tradingViewScreenerScore: tradingViewIntel.compositeScore,
      yahooFinanceScreenerScore: yahooFinanceIntel.compositeScore,
      nasdaqMarketResearchScore: nasdaqIntel.compositeScore,
      marketBeatAnalystScore: marketBeatIntel.compositeScore,
      analystDecisionGateScore: analystGate.compositeScore,
      analystDecisionGateStatus: analystGate.status,
      wallStreetZenQuantScore: wallStreetZenIntel.compositeScore,
      finraCreditRiskScore: finraIntel.compositeScore,
      secOwnershipScore: ownershipIntel.compositeScore,
      usaspendingAwardsScore: federalAwardsIntel.compositeScore,
      dodContractsScore: dodContractsIntel.compositeScore,
      disasterRiskScore: disasterIntel.compositeScore,
      naturalEventScore: naturalEventIntel.compositeScore,
      humanitarianRiskScore: humanitarianIntel.compositeScore,
      forcedDisplacementScore: refugeeIntel.compositeScore,
      historicalDisasterScore: historicalDisasterIntel.compositeScore,
      earthquakeRiskScore: earthquakeIntel.compositeScore,
      weatherAlertScore: weatherAlertIntel.compositeScore,
      nuclearEventScore: nuclearEventIntel.compositeScore,
      wildfireScore: wildfireIntel.compositeScore,
      droughtScore: droughtIntel.compositeScore,
      financialEventScore: eventWeightIntel.aggregateScore,
      brainModelKey: record.model_key,
      evidence: {
        quote: {
          current: quote.current,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          prevClose: quote.prevClose,
        },
        featureInput: input,
        explanation: [
          `Momentum ${changePct}%`,
          `Volatility range ${volatilityPct}%`,
          ...(priceTierBonusApplied ? [`sub_20_priority_bonus: +${PRICE_TIER_BONUS_POINTS} pts for price under $${PRICE_TIER_BONUS_THRESHOLD} (base score ${baseLocalAiScore})`] : []),
          ...(watcherSignalAdjustment !== 0 ? [`watcher_agent_signal: ${watcherSignalAdjustment > 0 ? '+' : ''}${watcherSignalAdjustment} pts from ${watcherBullish} bullish / ${watcherBearish} bearish recent watcher reports`] : []),
          `News and learned-source sentiment score ${sentiment}`,
          `Theme ${candidate.theme} with ${candidate.themeHits || 0} hits`,
          ...(candidate.discovery?.evidence?.slice(0, 2).map((item) => `Crawled discovery: ${item.reason}`) || []),
          ...(candidate.chatResearch?.reasons?.slice(0, 2).map((reason) => `Chat research: ${reason}`) || []),
          `Macro bias ${macro.riskBias}`,
          `Consumer bias ${consumer.consumerBias}`,
          `Broker factor intelligence ${factorIntel.compositeScore}`,
          ...historicalWatchFactors.map((factor) => (
            `${factor.label} ${factor.score}: ${factor.stance}`
          )),
          ...(factorIntel.secFilingFactor ? [
            `SEC filing history ${factorIntel.secFilingFactor.score}: ${factorIntel.secFilingFactor.stance} (${factorIntel.secFilingFactor.latestForm || 'no latest form'} ${factorIntel.secFilingFactor.latestFilingDate || 'unknown date'})`,
          ] : []),
          `Investor playbook score ${playbookIntel.compositeScore}`,
          `Public JSON dataset score ${datasetIntel.compositeScore}`,
          `Census BFS score ${businessFormationIntel.compositeScore}: ${businessFormationIntel.explanation}`,
          `Census BDS score ${businessDynamicsIntel.compositeScore}: ${businessDynamicsIntel.explanation}`,
          `EIA energy/fuel score ${energyFuelIntel.compositeScore}: ${energyFuelIntel.explanation}`,
          `BEA/FRED vehicle-sales score ${vehicleSalesIntel.compositeScore}: ${vehicleSalesIntel.explanation}`,
          `Consumer-goods industry score ${consumerGoodsIntel.compositeScore}: ${consumerGoodsIntel.explanation}`,
          `FINVIZ screener score ${finvizIntel.compositeScore}: ${finvizIntel.explanation}`,
          `TradingView screener score ${tradingViewIntel.compositeScore}: ${tradingViewIntel.explanation}`,
          `Yahoo Finance screener score ${yahooFinanceIntel.compositeScore}: ${yahooFinanceIntel.explanation}`,
          `Nasdaq market research score ${nasdaqIntel.compositeScore}: ${nasdaqIntel.explanation}`,
          `MarketBeat analyst score ${marketBeatIntel.compositeScore}: ${marketBeatIntel.explanation}`,
          `Analyst decision gate ${analystGate.compositeScore}: ${analystGate.summary}`,
          ...(analystGateBlocksBuy ? ['Analyst gate blocked buy-candidate status; recommendation remains further-research/watch until all analyst checks pass.'] : []),
          `WallStreetZen quant score ${wallStreetZenIntel.compositeScore}: ${wallStreetZenIntel.explanation}`,
          `FINRA fixed-income credit score ${finraIntel.compositeScore}: ${finraIntel.explanation}`,
          `SEC institutional ownership score ${ownershipIntel.compositeScore}: ${ownershipIntel.explanation}`,
          `USAspending federal awards score ${federalAwardsIntel.compositeScore}: ${federalAwardsIntel.explanation}`,
          `DoD daily contracts score ${dodContractsIntel.compositeScore}: ${dodContractsIntel.explanation}`,
          `GDACS disaster score ${disasterIntel.compositeScore}: ${disasterIntel.explanation}`,
          `NASA EONET natural-event score ${naturalEventIntel.compositeScore}: ${naturalEventIntel.explanation}`,
          `ReliefWeb humanitarian score ${humanitarianIntel.compositeScore}: ${humanitarianIntel.explanation}`,
          `UNHCR forced-displacement score ${refugeeIntel.compositeScore}: ${refugeeIntel.explanation}`,
          `EM-DAT historical disaster score ${historicalDisasterIntel.compositeScore}: ${historicalDisasterIntel.explanation}`,
          `USGS earthquake score ${earthquakeIntel.compositeScore}: ${earthquakeIntel.explanation}`,
          `NWS weather alert score ${weatherAlertIntel.compositeScore}: ${weatherAlertIntel.explanation}`,
          `NRC nuclear event/status score ${nuclearEventIntel.compositeScore}: ${nuclearEventIntel.explanation}`,
          `NIFC wildfire score ${wildfireIntel.compositeScore}: ${wildfireIntel.explanation}`,
          `U.S. Drought Monitor score ${droughtIntel.compositeScore}: ${droughtIntel.explanation}`,
          `WEIGHT.md event score ${eventWeightIntel.aggregateScore} (${eventWeightIntel.topEvents.length} weighted events)`,
          ...datasetIntel.explanations,
          ...eventWeightIntel.topEvents.slice(0, 4).map((event) => (
            `Weighted ${event.event.direction} ${event.event.category}: ${event.event.type} => ${event.final_event_score}`
          )),
          ...playbookIntel.indicators.slice(0, 3).map((indicator) => `${indicator.indicator} ${indicator.score}: ${indicator.interpretation}`),
          ...factorIntel.explanations.slice(0, 4),
        ],
        investorPlaybook: {
          available: playbookIntel.available,
          title: playbookIntel.title,
          source: playbookIntel.source,
          score: playbookIntel.compositeScore,
          indicators: playbookIntel.indicators,
          investorMatches: playbookIntel.investorMatches,
          sellRisks: playbookIntel.sellRisks,
        },
        jsonDatasets: {
          score: datasetIntel.compositeScore,
          categoryImpacts: datasetIntel.categoryImpacts,
          compositeRiskScore: jsonDatasets?.compositeRiskScore,
          opportunityScore: jsonDatasets?.opportunityScore,
        },
        businessFormation: {
          score: businessFormationIntel.compositeScore,
          normalized: businessFormationIntel.normalized,
          exposure: businessFormationIntel.exposure,
          topSeries: businessFormationIntel.topSeries,
          context: businessFormation ? {
            available: businessFormation.available,
            momentum: businessFormation.momentum,
            opportunityScore: businessFormation.opportunityScore,
            riskScore: businessFormation.riskScore,
            averageGrowthPct: businessFormation.averageGrowthPct,
            latestPeriod: businessFormation.latestPeriod,
          } : null,
        },
        businessDynamics: {
          score: businessDynamicsIntel.compositeScore,
          normalized: businessDynamicsIntel.normalized,
          exposure: businessDynamicsIntel.exposure,
          topMetrics: businessDynamicsIntel.topMetrics,
          context: businessDynamics ? {
            available: businessDynamics.available,
            momentum: businessDynamics.momentum,
            opportunityScore: businessDynamics.opportunityScore,
            riskScore: businessDynamics.riskScore,
            netDynamismPct: businessDynamics.netDynamismPct,
            latestYear: businessDynamics.latestYear,
          } : null,
        },
        energyFuel: {
          score: energyFuelIntel.compositeScore,
          normalized: energyFuelIntel.normalized,
          exposure: energyFuelIntel.exposure,
          latestSeries: energyFuelIntel.latestSeries,
          context: energyFuel ? {
            available: energyFuel.available,
            momentum: energyFuel.momentum,
            opportunityScore: energyFuel.opportunityScore,
            riskScore: energyFuel.riskScore,
            shippingCostPressureScore: energyFuel.shippingCostPressureScore,
            consumerFuelPressureScore: energyFuel.consumerFuelPressureScore,
            latestPeriod: energyFuel.latestPeriod,
          } : null,
        },
        vehicleSales: {
          score: vehicleSalesIntel.compositeScore,
          normalized: vehicleSalesIntel.normalized,
          exposure: vehicleSalesIntel.exposure,
          latestSeries: vehicleSalesIntel.latestSeries,
          context: vehicleSalesContext ? {
            available: vehicleSalesContext.available,
            momentum: vehicleSalesContext.momentum,
            opportunityScore: vehicleSalesContext.opportunityScore,
            riskScore: vehicleSalesContext.riskScore,
            demandMomentumScore: vehicleSalesContext.demandMomentumScore,
            domesticDemandScore: vehicleSalesContext.domesticDemandScore,
            lightVehicleDemandScore: vehicleSalesContext.lightVehicleDemandScore,
            latestPeriod: vehicleSalesContext.latestPeriod,
          } : null,
        },
        consumerGoodsIndustry: {
          score: consumerGoodsIntel.compositeScore,
          normalized: consumerGoodsIntel.normalized,
          exposure: consumerGoodsIntel.exposure,
          signals: consumerGoodsIntel.signals,
          context: consumerGoodsContext ? {
            available: consumerGoodsContext.available,
            provider: consumerGoodsContext.provider,
            momentum: consumerGoodsContext.momentum,
            industryScore: consumerGoodsContext.industryScore,
            revenueLeadershipScore: consumerGoodsContext.revenueLeadershipScore,
            valuationCoverageScore: consumerGoodsContext.valuationCoverageScore,
            signalCount: consumerGoodsContext.signalCount,
            uniqueSymbolCount: consumerGoodsContext.uniqueSymbolCount,
            caveat: consumerGoodsContext.caveat,
          } : null,
        },
        finvizScreener: {
          score: finvizIntel.compositeScore,
          normalized: finvizIntel.normalized,
          exposure: finvizIntel.exposure,
          signals: finvizIntel.signals,
          context: finvizContext ? {
            available: finvizContext.available,
            provider: finvizContext.provider,
            momentum: finvizContext.momentum,
            opportunityScore: finvizContext.opportunityScore,
            riskScore: finvizContext.riskScore,
            signalCount: finvizContext.signalCount,
            bullishCount: finvizContext.bullishCount,
            bearishCount: finvizContext.bearishCount,
            caveat: finvizContext.quoteDelayNote,
          } : null,
        },
        tradingViewScreener: {
          score: tradingViewIntel.compositeScore,
          normalized: tradingViewIntel.normalized,
          exposure: tradingViewIntel.exposure,
          signals: tradingViewIntel.signals,
          sectorSignals: tradingViewIntel.sectorSignals,
          context: tradingViewContext ? {
            available: tradingViewContext.available,
            provider: tradingViewContext.provider,
            momentum: tradingViewContext.momentum,
            opportunityScore: tradingViewContext.opportunityScore,
            riskScore: tradingViewContext.riskScore,
            signalCount: tradingViewContext.signalCount,
            preMarketCount: tradingViewContext.preMarketCount,
            allTimeHighCount: tradingViewContext.allTimeHighCount,
            sectorCount: tradingViewContext.sectorCount,
            caveat: tradingViewContext.quoteDelayNote,
          } : null,
        },
        yahooFinanceScreener: {
          score: yahooFinanceIntel.compositeScore,
          normalized: yahooFinanceIntel.normalized,
          exposure: yahooFinanceIntel.exposure,
          signals: yahooFinanceIntel.signals,
          companyPages: yahooFinanceIntel.companyPages,
          context: yahooFinanceContext ? {
            available: yahooFinanceContext.available,
            provider: yahooFinanceContext.provider,
            momentum: yahooFinanceContext.momentum,
            opportunityScore: yahooFinanceContext.opportunityScore,
            riskScore: yahooFinanceContext.riskScore,
            signalCount: yahooFinanceContext.signalCount,
            analystSignalCount: yahooFinanceContext.analystSignalCount,
            companyPageCount: yahooFinanceContext.companyPageCount,
            caveat: yahooFinanceContext.quoteDelayNote,
          } : null,
        },
        nasdaqMarketResearch: {
          score: nasdaqIntel.compositeScore,
          normalized: nasdaqIntel.normalized,
          exposure: nasdaqIntel.exposure,
          signals: nasdaqIntel.signals,
          companyPages: nasdaqIntel.companyPages,
          context: nasdaqContext ? {
            available: nasdaqContext.available,
            provider: nasdaqContext.provider,
            momentum: nasdaqContext.momentum,
            opportunityScore: nasdaqContext.opportunityScore,
            riskScore: nasdaqContext.riskScore,
            catalystScore: nasdaqContext.catalystScore,
            signalCount: nasdaqContext.signalCount,
            earningsCatalystCount: nasdaqContext.earningsCatalystCount,
            ipoCatalystCount: nasdaqContext.ipoCatalystCount,
            companyPageCount: nasdaqContext.companyPageCount,
            caveat: nasdaqContext.quoteDelayNote,
          } : null,
        },
        marketBeatAnalyst: {
          score: marketBeatIntel.compositeScore,
          normalized: marketBeatIntel.normalized,
          exposure: marketBeatIntel.exposure,
          signals: marketBeatIntel.signals,
          consensusPages: marketBeatIntel.consensusPages,
          context: marketBeatContext ? {
            available: marketBeatContext.available,
            provider: marketBeatContext.provider,
            momentum: marketBeatContext.momentum,
            opportunityScore: marketBeatContext.opportunityScore,
            riskScore: marketBeatContext.riskScore,
            targetScore: marketBeatContext.targetScore,
            signalCount: marketBeatContext.signalCount,
            bullishCount: marketBeatContext.bullishCount,
            bearishCount: marketBeatContext.bearishCount,
            targetChangeCount: marketBeatContext.targetChangeCount,
            consensusPageCount: marketBeatContext.consensusPageCount,
            caveat: marketBeatContext.quoteDelayNote,
          } : null,
        },
        analystDecisionGate: analystGate,
        wallStreetZenQuant: {
          score: wallStreetZenIntel.compositeScore,
          normalized: wallStreetZenIntel.normalized,
          exposure: wallStreetZenIntel.exposure,
          signals: wallStreetZenIntel.signals,
          tickerPages: wallStreetZenIntel.tickerPages,
          context: wallStreetZenContext ? {
            available: wallStreetZenContext.available,
            provider: wallStreetZenContext.provider,
            momentum: wallStreetZenContext.momentum,
            opportunityScore: wallStreetZenContext.opportunityScore,
            riskScore: wallStreetZenContext.riskScore,
            quantScore: wallStreetZenContext.quantScore,
            signalCount: wallStreetZenContext.signalCount,
            bullishCount: wallStreetZenContext.bullishCount,
            bearishCount: wallStreetZenContext.bearishCount,
            ratedCount: wallStreetZenContext.ratedCount,
            tickerPageCount: wallStreetZenContext.tickerPageCount,
            caveat: wallStreetZenContext.quoteDelayNote,
          } : null,
        },
        finraCreditRisk: {
          score: finraIntel.compositeScore,
          normalized: finraIntel.normalized,
          exposure: finraIntel.exposure,
          signals: finraIntel.signals,
          contextRiskScore: finraIntel.contextRiskScore,
          context: finraContext ? {
            available: finraContext.available,
            provider: finraContext.provider,
            momentum: finraContext.momentum,
            opportunityScore: finraContext.opportunityScore,
            riskScore: finraContext.riskScore,
            creditStressScore: finraContext.creditStressScore,
            refinancingPressureScore: finraContext.refinancingPressureScore,
            equityCreditDivergenceScore: finraContext.equityCreditDivergenceScore,
            tradeSignalCount: finraContext.tradeSignalCount,
            stressedCount: finraContext.stressedCount,
            constructiveCount: finraContext.constructiveCount,
            caveat: finraContext.quoteDelayNote,
          } : null,
        },
        secOwnership: {
          score: ownershipIntel.compositeScore,
          normalized: ownershipIntel.normalized,
          exposure: ownershipIntel.exposure,
          signals: ownershipIntel.signals,
          contextOpportunityScore: ownershipIntel.contextOpportunityScore,
          contextRiskScore: ownershipIntel.contextRiskScore,
          context: ownershipContext ? {
            available: ownershipContext.available,
            provider: ownershipContext.provider,
            momentum: ownershipContext.momentum,
            opportunityScore: ownershipContext.opportunityScore,
            riskScore: ownershipContext.riskScore,
            activistPressureScore: ownershipContext.activistPressureScore,
            institutionalDemandScore: ownershipContext.institutionalDemandScore,
            concentrationRiskScore: ownershipContext.concentrationRiskScore,
            entryCount: ownershipContext.entryCount,
            activistSignalCount: ownershipContext.activistSignalCount,
            passiveSignalCount: ownershipContext.passiveSignalCount,
            institutionalSignalCount: ownershipContext.institutionalSignalCount,
            newPositionSignalCount: ownershipContext.newPositionSignalCount,
            reductionSignalCount: ownershipContext.reductionSignalCount,
            caveat: ownershipContext.quoteDelayNote,
          } : null,
        },
        usaspendingAwards: {
          score: federalAwardsIntel.compositeScore,
          normalized: federalAwardsIntel.normalized,
          exposure: federalAwardsIntel.exposure,
          signals: federalAwardsIntel.signals,
          directAwardAmount: federalAwardsIntel.directAwardAmount,
          contextOpportunityScore: federalAwardsIntel.contextOpportunityScore,
          context: federalAwardsContext ? {
            available: federalAwardsContext.available,
            provider: federalAwardsContext.provider,
            momentum: federalAwardsContext.momentum,
            opportunityScore: federalAwardsContext.opportunityScore,
            riskScore: federalAwardsContext.riskScore,
            governmentDemandScore: federalAwardsContext.governmentDemandScore,
            defenseDemandScore: federalAwardsContext.defenseDemandScore,
            infrastructureDemandScore: federalAwardsContext.infrastructureDemandScore,
            conflictExposureScore: federalAwardsContext.conflictExposureScore,
            returnedAwardCount: federalAwardsContext.returnedAwardCount,
            defenseAwardCount: federalAwardsContext.defenseAwardCount,
            inferredConflictAwardCount: federalAwardsContext.inferredConflictAwardCount,
            caveat: federalAwardsContext.caveat,
          } : null,
        },
        dodContracts: {
          score: dodContractsIntel.compositeScore,
          normalized: dodContractsIntel.normalized,
          exposure: dodContractsIntel.exposure,
          signals: dodContractsIntel.signals,
          directContractAmount: dodContractsIntel.directContractAmount,
          contextOpportunityScore: dodContractsIntel.contextOpportunityScore,
          context: dodContractsContext ? {
            available: dodContractsContext.available,
            provider: dodContractsContext.provider,
            momentum: dodContractsContext.momentum,
            opportunityScore: dodContractsContext.opportunityScore,
            riskScore: dodContractsContext.riskScore,
            defenseDemandScore: dodContractsContext.defenseDemandScore,
            innovationDemandScore: dodContractsContext.innovationDemandScore,
            foreignExposureScore: dodContractsContext.foreignExposureScore,
            contractCount: dodContractsContext.contractCount,
            totalAnnouncedValue: dodContractsContext.totalAnnouncedValue,
            innovationContractCount: dodContractsContext.innovationContractCount,
            foreignContractCount: dodContractsContext.foreignContractCount,
            caveat: dodContractsContext.caveat,
          } : null,
        },
        disasterRisk: {
          score: disasterIntel.compositeScore,
          normalized: disasterIntel.normalized,
          exposure: disasterIntel.exposure,
          topEvents: disasterIntel.topEvents,
          context: disasterContext ? {
            available: disasterContext.available,
            momentum: disasterContext.momentum,
            riskScore: disasterContext.riskScore,
            supplyChainRiskScore: disasterContext.supplyChainRiskScore,
            insuranceRiskScore: disasterContext.insuranceRiskScore,
            recoveryOpportunityScore: disasterContext.recoveryOpportunityScore,
            highImpactCount: disasterContext.highImpactCount,
            eventCount: disasterContext.eventCount,
            latestPeriod: disasterContext.latestPeriod,
          } : null,
        },
        naturalEvents: {
          score: naturalEventIntel.compositeScore,
          normalized: naturalEventIntel.normalized,
          exposure: naturalEventIntel.exposure,
          topEvents: naturalEventIntel.topEvents,
          context: naturalEventContext ? {
            available: naturalEventContext.available,
            momentum: naturalEventContext.momentum,
            riskScore: naturalEventContext.riskScore,
            wildfireRiskScore: naturalEventContext.wildfireRiskScore,
            stormFloodRiskScore: naturalEventContext.stormFloodRiskScore,
            aviationVisibilityRiskScore: naturalEventContext.aviationVisibilityRiskScore,
            agricultureDroughtRiskScore: naturalEventContext.agricultureDroughtRiskScore,
            recoveryOpportunityScore: naturalEventContext.recoveryOpportunityScore,
            openEventCount: naturalEventContext.openEventCount,
            highImpactCount: naturalEventContext.highImpactCount,
            eventCount: naturalEventContext.eventCount,
            latestPeriod: naturalEventContext.latestPeriod,
          } : null,
        },
        humanitarianRisk: {
          score: humanitarianIntel.compositeScore,
          normalized: humanitarianIntel.normalized,
          exposure: humanitarianIntel.exposure,
          topDisasters: humanitarianIntel.topDisasters,
          topReports: humanitarianIntel.topReports,
          context: humanitarianContext ? {
            available: humanitarianContext.available,
            appConfigured: humanitarianContext.appConfigured,
            momentum: humanitarianContext.momentum,
            riskScore: humanitarianContext.riskScore,
            humanitarianImpactScore: humanitarianContext.humanitarianImpactScore,
            crisisSeverityScore: humanitarianContext.crisisSeverityScore,
            aidRequirementScore: humanitarianContext.aidRequirementScore,
            infrastructureRecoveryScore: humanitarianContext.infrastructureRecoveryScore,
            supplyChainDisruptionScore: humanitarianContext.supplyChainDisruptionScore,
            disasterCount: humanitarianContext.disasterCount,
            reportCount: humanitarianContext.reportCount,
            latestPeriod: humanitarianContext.latestPeriod,
          } : null,
        },
        forcedDisplacement: {
          score: refugeeIntel.compositeScore,
          normalized: refugeeIntel.normalized,
          exposure: refugeeIntel.exposure,
          topOriginCountries: refugeeIntel.topOriginCountries,
          topHostCountries: refugeeIntel.topHostCountries,
          context: refugeeContext ? {
            available: refugeeContext.available,
            momentum: refugeeContext.momentum,
            latestYear: refugeeContext.latestYear,
            riskScore: refugeeContext.riskScore,
            displacementPressureScore: refugeeContext.displacementPressureScore,
            refugeeAsylumPressureScore: refugeeContext.refugeeAsylumPressureScore,
            idpPressureScore: refugeeContext.idpPressureScore,
            statelessnessRiskScore: refugeeContext.statelessnessRiskScore,
            hostCountryPressureScore: refugeeContext.hostCountryPressureScore,
            aidDemandScore: refugeeContext.aidDemandScore,
            shelterInfrastructureDemandScore: refugeeContext.shelterInfrastructureDemandScore,
            healthcareDemandScore: refugeeContext.healthcareDemandScore,
            logisticsAccessRiskScore: refugeeContext.logisticsAccessRiskScore,
            borderPolicyRiskScore: refugeeContext.borderPolicyRiskScore,
            totalForcedDisplacement: refugeeContext.totalForcedDisplacement,
            refugeesAndAsylum: refugeeContext.refugeesAndAsylum,
          } : null,
        },
        historicalDisasters: {
          score: historicalDisasterIntel.compositeScore,
          normalized: historicalDisasterIntel.normalized,
          exposure: historicalDisasterIntel.exposure,
          topDatasets: historicalDisasterIntel.topDatasets,
          context: historicalDisasterContext ? {
            available: historicalDisasterContext.available,
            momentum: historicalDisasterContext.momentum,
            riskScore: historicalDisasterContext.riskScore,
            opportunityScore: historicalDisasterContext.opportunityScore,
            historicalImpactModelingScore: historicalDisasterContext.historicalImpactModelingScore,
            economicLossModelingScore: historicalDisasterContext.economicLossModelingScore,
            humanImpactModelingScore: historicalDisasterContext.humanImpactModelingScore,
            climateRiskBacktestScore: historicalDisasterContext.climateRiskBacktestScore,
            dataAccessFrictionScore: historicalDisasterContext.dataAccessFrictionScore,
            datasetCount: historicalDisasterContext.datasetCount,
            registeredAccessRequired: historicalDisasterContext.registeredAccessRequired,
            latestPeriod: historicalDisasterContext.latestPeriod,
          } : null,
        },
        earthquakeRisk: {
          score: earthquakeIntel.compositeScore,
          normalized: earthquakeIntel.normalized,
          exposure: earthquakeIntel.exposure,
          topEvents: earthquakeIntel.topEvents,
          context: earthquakeContext ? {
            available: earthquakeContext.available,
            momentum: earthquakeContext.momentum,
            riskScore: earthquakeContext.riskScore,
            seismicSupplyChainRiskScore: earthquakeContext.seismicSupplyChainRiskScore,
            infrastructureDamageRiskScore: earthquakeContext.infrastructureDamageRiskScore,
            tsunamiRiskScore: earthquakeContext.tsunamiRiskScore,
            insuranceRiskScore: earthquakeContext.insuranceRiskScore,
            recoveryOpportunityScore: earthquakeContext.recoveryOpportunityScore,
            highMagnitudeCount: earthquakeContext.highMagnitudeCount,
            shallowHighMagnitudeCount: earthquakeContext.shallowHighMagnitudeCount,
            tsunamiCount: earthquakeContext.tsunamiCount,
            eventCount: earthquakeContext.eventCount,
            latestPeriod: earthquakeContext.latestPeriod,
          } : null,
        },
        weatherAlerts: {
          score: weatherAlertIntel.compositeScore,
          normalized: weatherAlertIntel.normalized,
          exposure: weatherAlertIntel.exposure,
          topAlerts: weatherAlertIntel.topAlerts,
          context: weatherAlertContext ? {
            available: weatherAlertContext.available,
            userAgentConfigured: weatherAlertContext.userAgentConfigured,
            momentum: weatherAlertContext.momentum,
            riskScore: weatherAlertContext.riskScore,
            logisticsRiskScore: weatherAlertContext.logisticsRiskScore,
            utilityRiskScore: weatherAlertContext.utilityRiskScore,
            agricultureRiskScore: weatherAlertContext.agricultureRiskScore,
            insuranceRiskScore: weatherAlertContext.insuranceRiskScore,
            retailFootTrafficRiskScore: weatherAlertContext.retailFootTrafficRiskScore,
            recoveryOpportunityScore: weatherAlertContext.recoveryOpportunityScore,
            severeAlertCount: weatherAlertContext.severeAlertCount,
            alertCount: weatherAlertContext.alertCount,
            latestPeriod: weatherAlertContext.latestPeriod,
          } : null,
        },
        nuclearEvents: {
          score: nuclearEventIntel.compositeScore,
          normalized: nuclearEventIntel.normalized,
          exposure: nuclearEventIntel.exposure,
          topEvents: nuclearEventIntel.topEvents,
          topOutages: nuclearEventIntel.topOutages,
          context: nuclearEventContext ? {
            available: nuclearEventContext.available,
            momentum: nuclearEventContext.momentum,
            riskScore: nuclearEventContext.riskScore,
            safetyIncidentScore: nuclearEventContext.safetyIncidentScore,
            reactorOutageScore: nuclearEventContext.reactorOutageScore,
            regulatoryNotificationScore: nuclearEventContext.regulatoryNotificationScore,
            nuclearUtilityRiskScore: nuclearEventContext.nuclearUtilityRiskScore,
            nuclearServicesOpportunityScore: nuclearEventContext.nuclearServicesOpportunityScore,
            alternativeEnergyOpportunityScore: nuclearEventContext.alternativeEnergyOpportunityScore,
            highImpactEventCount: nuclearEventContext.highImpactEventCount,
            scramCount: nuclearEventContext.scramCount,
            part21Count: nuclearEventContext.part21Count,
            offlineUnitCount: nuclearEventContext.offlineUnitCount,
            deratedUnitCount: nuclearEventContext.deratedUnitCount,
            eventCount: nuclearEventContext.eventCount,
            reactorStatusCount: nuclearEventContext.reactorStatusCount,
            latestPeriod: nuclearEventContext.latestPeriod,
          } : null,
        },
        wildfires: {
          score: wildfireIntel.compositeScore,
          normalized: wildfireIntel.normalized,
          exposure: wildfireIntel.exposure,
          topIncidents: wildfireIntel.topIncidents,
          context: wildfireContext ? {
            available: wildfireContext.available,
            momentum: wildfireContext.momentum,
            riskScore: wildfireContext.riskScore,
            activeIncidentRiskScore: wildfireContext.activeIncidentRiskScore,
            perimeterRiskScore: wildfireContext.perimeterRiskScore,
            smokeAirQualityRiskScore: wildfireContext.smokeAirQualityRiskScore,
            utilityRiskScore: wildfireContext.utilityRiskScore,
            insuranceRiskScore: wildfireContext.insuranceRiskScore,
            timberAgricultureRiskScore: wildfireContext.timberAgricultureRiskScore,
            logisticsRiskScore: wildfireContext.logisticsRiskScore,
            recoveryOpportunityScore: wildfireContext.recoveryOpportunityScore,
            preparednessLevel: wildfireContext.preparednessLevel,
            totalAcres: wildfireContext.totalAcres,
            largeFireCount: wildfireContext.largeFireCount,
            uncontainedCount: wildfireContext.uncontainedCount,
            incidentCount: wildfireContext.incidentCount,
            latestPeriod: wildfireContext.latestPeriod,
          } : null,
        },
        droughtRisk: {
          score: droughtIntel.compositeScore,
          normalized: droughtIntel.normalized,
          exposure: droughtIntel.exposure,
          topAreas: droughtIntel.topAreas,
          context: droughtContext ? {
            available: droughtContext.available,
            momentum: droughtContext.momentum,
            riskScore: droughtContext.riskScore,
            agricultureRiskScore: droughtContext.agricultureRiskScore,
            cropInputDemandScore: droughtContext.cropInputDemandScore,
            waterUtilityRiskScore: droughtContext.waterUtilityRiskScore,
            wildfireAmplificationRiskScore: droughtContext.wildfireAmplificationRiskScore,
            foodInflationRiskScore: droughtContext.foodInflationRiskScore,
            livestockRiskScore: droughtContext.livestockRiskScore,
            logisticsRiskScore: droughtContext.logisticsRiskScore,
            irrigationInfrastructureOpportunityScore: droughtContext.irrigationInfrastructureOpportunityScore,
            dsci: droughtContext.dsci,
            dsciChange: droughtContext.dsciChange,
            severeDroughtPct: droughtContext.severeDroughtPct,
            extremeExceptionalPct: droughtContext.extremeExceptionalPct,
            latestPeriod: droughtContext.latestPeriod,
          } : null,
        },
        financialEvents: {
          model: eventWeightIntel.model,
          aggregateScore: eventWeightIntel.aggregateScore,
          normalized: eventWeightIntel.normalized,
          categoryImpacts: eventWeightIntel.categoryImpacts,
          topEvents: eventWeightIntel.topEvents,
          note: 'WEIGHT.md event scores update assumptions and ranking features; they do not directly authorize buy/sell orders.',
        },
        discovery: candidate.discovery || null,
        chatResearch: candidate.chatResearch || null,
        historicalWatchFactors,
        secFilingHistory: factorIntel.secFilingFactor,
      },
    });
  }

  if (!scored.length) {
    emit(onEvent, 'local-ai', 68, 'warn', 'No quote-backed candidates were available after source collection.', {});
  } else {
    emit(onEvent, 'local-ai', 66, 'debug', 'brain.js local evaluator scored quote-backed opportunities.', {
      model: 'NeuralNetwork',
      candidates: scored.length,
    });
  }

  return scored.sort((a, b) => b.localAiScore - a.localAiScore).slice(0, 12);
}

// Shared seed training set for both the brain.js net and the logistic
// regression ensemble member, so they're two independently-fit models over
// the same labeled feature space rather than one model wearing two hats.
const CANDIDATE_SCORER_TRAINING_DATA = [
  { input: { momentum: 0.9, volatility: 0.25, news: 0.85, theme: 0.8, macroRisk: 0.15, consumer: 0.8, brokerFactors: 0.9, historicalWatchFactors: 0.88, secFilingHistory: 0.7, investorPlaybook: 0.9, jsonDatasets: 0.85, businessFormation: 0.78, businessDynamics: 0.8, energyFuel: 0.72, vehicleSales: 0.74, consumerGoodsIndustry: 0.82, finvizScreener: 0.78, tradingViewScreener: 0.78, yahooFinanceScreener: 0.78, nasdaqMarketResearch: 0.8, marketBeatAnalyst: 0.82, wallStreetZenQuant: 0.8, finraCreditRisk: 0.82, secOwnership: 0.78, usaspendingAwards: 0.84, dodContracts: 0.86, disasterRisk: 0.62, naturalEvents: 0.62, humanitarianRisk: 0.62, forcedDisplacement: 0.66, historicalDisasters: 0.7, earthquakeRisk: 0.64, weatherAlerts: 0.62, nuclearEvents: 0.62, wildfires: 0.62, droughtRisk: 0.62, financialEvents: 0.92, eventOutcomeConfidence: 0.85 }, output: { score: 0.95 } },
  { input: { momentum: 0.75, volatility: 0.35, news: 0.65, theme: 0.55, macroRisk: 0.35, consumer: 0.6, brokerFactors: 0.75, historicalWatchFactors: 0.72, secFilingHistory: 0.68, investorPlaybook: 0.78, jsonDatasets: 0.72, businessFormation: 0.68, businessDynamics: 0.66, energyFuel: 0.62, vehicleSales: 0.64, consumerGoodsIndustry: 0.68, finvizScreener: 0.66, tradingViewScreener: 0.68, yahooFinanceScreener: 0.66, nasdaqMarketResearch: 0.68, marketBeatAnalyst: 0.7, wallStreetZenQuant: 0.68, finraCreditRisk: 0.66, secOwnership: 0.64, usaspendingAwards: 0.66, dodContracts: 0.68, disasterRisk: 0.55, naturalEvents: 0.55, humanitarianRisk: 0.55, forcedDisplacement: 0.56, historicalDisasters: 0.58, earthquakeRisk: 0.56, weatherAlerts: 0.55, nuclearEvents: 0.55, wildfires: 0.55, droughtRisk: 0.55, financialEvents: 0.72, eventOutcomeConfidence: 0.7 }, output: { score: 0.78 } },
  { input: { momentum: 0.55, volatility: 0.45, news: 0.5, theme: 0.35, macroRisk: 0.45, consumer: 0.5, brokerFactors: 0.55, historicalWatchFactors: 0.52, secFilingHistory: 0.54, investorPlaybook: 0.55, jsonDatasets: 0.5, businessFormation: 0.52, businessDynamics: 0.5, energyFuel: 0.5, vehicleSales: 0.5, consumerGoodsIndustry: 0.5, finvizScreener: 0.5, tradingViewScreener: 0.5, yahooFinanceScreener: 0.5, nasdaqMarketResearch: 0.5, marketBeatAnalyst: 0.5, wallStreetZenQuant: 0.5, finraCreditRisk: 0.5, secOwnership: 0.5, usaspendingAwards: 0.5, dodContracts: 0.5, disasterRisk: 0.5, naturalEvents: 0.5, humanitarianRisk: 0.5, forcedDisplacement: 0.5, historicalDisasters: 0.5, earthquakeRisk: 0.5, weatherAlerts: 0.5, nuclearEvents: 0.5, wildfires: 0.5, droughtRisk: 0.5, financialEvents: 0.5, eventOutcomeConfidence: 0.5 }, output: { score: 0.52 } },
  { input: { momentum: 0.25, volatility: 0.8, news: 0.25, theme: 0.2, macroRisk: 0.75, consumer: 0.35, brokerFactors: 0.25, historicalWatchFactors: 0.2, secFilingHistory: 0.38, investorPlaybook: 0.24, jsonDatasets: 0.22, businessFormation: 0.34, businessDynamics: 0.28, energyFuel: 0.18, vehicleSales: 0.22, consumerGoodsIndustry: 0.24, finvizScreener: 0.2, tradingViewScreener: 0.2, yahooFinanceScreener: 0.2, nasdaqMarketResearch: 0.2, marketBeatAnalyst: 0.18, wallStreetZenQuant: 0.18, finraCreditRisk: 0.16, secOwnership: 0.2, usaspendingAwards: 0.18, dodContracts: 0.16, disasterRisk: 0.2, naturalEvents: 0.2, humanitarianRisk: 0.2, forcedDisplacement: 0.2, historicalDisasters: 0.24, earthquakeRisk: 0.18, weatherAlerts: 0.2, nuclearEvents: 0.18, wildfires: 0.18, droughtRisk: 0.18, financialEvents: 0.18, eventOutcomeConfidence: 0.2 }, output: { score: 0.13 } },
  { input: { momentum: 0.75, volatility: 0.9, news: 0.4, theme: 0.4, macroRisk: 0.8, consumer: 0.4, brokerFactors: 0.35, historicalWatchFactors: 0.32, secFilingHistory: 0.4, investorPlaybook: 0.34, jsonDatasets: 0.3, businessFormation: 0.36, businessDynamics: 0.32, energyFuel: 0.24, vehicleSales: 0.26, consumerGoodsIndustry: 0.28, finvizScreener: 0.28, tradingViewScreener: 0.3, yahooFinanceScreener: 0.3, nasdaqMarketResearch: 0.3, marketBeatAnalyst: 0.26, wallStreetZenQuant: 0.24, finraCreditRisk: 0.22, secOwnership: 0.26, usaspendingAwards: 0.24, dodContracts: 0.24, disasterRisk: 0.24, naturalEvents: 0.24, humanitarianRisk: 0.24, forcedDisplacement: 0.24, historicalDisasters: 0.28, earthquakeRisk: 0.22, weatherAlerts: 0.22, nuclearEvents: 0.2, wildfires: 0.22, droughtRisk: 0.22, financialEvents: 0.28, eventOutcomeConfidence: 0.3 }, output: { score: 0.27 } },
  { input: { momentum: 0.35, volatility: 0.2, news: 0.7, theme: 0.65, macroRisk: 0.25, consumer: 0.75, brokerFactors: 0.7, historicalWatchFactors: 0.68, secFilingHistory: 0.66, investorPlaybook: 0.74, jsonDatasets: 0.76, businessFormation: 0.72, businessDynamics: 0.76, energyFuel: 0.64, vehicleSales: 0.68, consumerGoodsIndustry: 0.72, finvizScreener: 0.7, tradingViewScreener: 0.68, yahooFinanceScreener: 0.68, nasdaqMarketResearch: 0.7, marketBeatAnalyst: 0.72, wallStreetZenQuant: 0.7, finraCreditRisk: 0.72, secOwnership: 0.7, usaspendingAwards: 0.72, dodContracts: 0.72, disasterRisk: 0.7, naturalEvents: 0.7, humanitarianRisk: 0.7, forcedDisplacement: 0.72, historicalDisasters: 0.68, earthquakeRisk: 0.72, weatherAlerts: 0.7, nuclearEvents: 0.68, wildfires: 0.72, droughtRisk: 0.7, financialEvents: 0.76, eventOutcomeConfidence: 0.65 }, output: { score: 0.68 } },
  { input: { momentum: 0.65, volatility: 0.3, news: 0.45, theme: 0.35, macroRisk: 0.4, consumer: 0.45, brokerFactors: 0.85, historicalWatchFactors: 0.8, secFilingHistory: 0.68, investorPlaybook: 0.82, jsonDatasets: 0.7, businessFormation: 0.62, businessDynamics: 0.58, energyFuel: 0.74, vehicleSales: 0.58, consumerGoodsIndustry: 0.58, finvizScreener: 0.62, tradingViewScreener: 0.62, yahooFinanceScreener: 0.62, nasdaqMarketResearch: 0.64, marketBeatAnalyst: 0.66, wallStreetZenQuant: 0.64, finraCreditRisk: 0.64, secOwnership: 0.76, usaspendingAwards: 0.74, dodContracts: 0.76, disasterRisk: 0.58, naturalEvents: 0.58, humanitarianRisk: 0.58, forcedDisplacement: 0.58, historicalDisasters: 0.6, earthquakeRisk: 0.58, weatherAlerts: 0.58, nuclearEvents: 0.62, wildfires: 0.58, droughtRisk: 0.58, financialEvents: 0.68, eventOutcomeConfidence: 0.62 }, output: { score: 0.72 } },
];

function buildBrainScorer(userId) {
  return brainModelService.loadOrTrain({
    userId,
    modelKey: 'candidate-factor-scorer-v33-consumer-goods-industry',
    hiddenLayers: [10, 6],
    iterations: 100,
    metadata: {
      purpose: 'Scores trade candidates using market signals, broker-style factor intelligence, SEC filing recency/history, historical watch factors, Census BFS formation momentum, Census BDS annual business-dynamics trend, EIA fuel and energy price-volume pressure, BEA/FRED aggregate vehicle-sales demand momentum, consumer-goods industry/revenue/valuation/dividend comparison signals, FINVIZ scraped screener technical/fundamental/analyst/insider signals, TradingView scraped screener momentum, pre-market, all-time-high, and sector-leadership signals, Yahoo Finance scraped screener/analyst-rating/market-mover/company-page signals, Nasdaq scraped market activity, earnings/IPO catalyst, analyst-research, institutional-holdings, and insider-activity signals, MarketBeat scraped analyst recommendations, broker upgrades/downgrades, price-target changes, and consensus forecast signals, WallStreetZen scraped quantitative Zen Rating/component-grade/screener/ticker-analysis signals, FINRA fixed-income and corporate/agency bond trade-activity credit-risk signals, SEC 13F/13D/13G institutional holdings, activist stake, passive beneficial ownership, concentrated ownership, delayed hedge-fund positioning signals, USAspending federal awards/contracts government-demand and contractor revenue-catalyst signals, DoD/War.gov daily major contract-announcement signals, GDACS global disaster alert risk, NASA EONET natural-event and satellite-imagery risk, ReliefWeb humanitarian disaster and report impact risk, UNHCR Refugee Statistics forced-displacement origin/host country pressure, EM-DAT/CRED historical disaster impact and economic-loss modeling, USGS earthquake catalog and real-time seismic risk, NWS active U.S. weather alert risk, NRC nuclear event notification and power reactor status risk, NIFC/WFIGS wildfire perimeter and preparedness-level risk, U.S. Drought Monitor weekly drought classification and DSCI risk, high-earning investor playbooks, public JSON dataset context, WEIGHT.md financial-event multipliers, and (when a promoted challenger exists) event-outcome correctness confidence learned from realized training labels.',
      exportedFormat: 'brain.js toJSON',
      inputFeatures: ['momentum', 'volatility', 'news', 'theme', 'macroRisk', 'consumer', 'brokerFactors', 'historicalWatchFactors', 'secFilingHistory', 'investorPlaybook', 'jsonDatasets', 'businessFormation', 'businessDynamics', 'energyFuel', 'vehicleSales', 'consumerGoodsIndustry', 'finvizScreener', 'tradingViewScreener', 'yahooFinanceScreener', 'nasdaqMarketResearch', 'marketBeatAnalyst', 'wallStreetZenQuant', 'finraCreditRisk', 'secOwnership', 'usaspendingAwards', 'dodContracts', 'disasterRisk', 'naturalEvents', 'humanitarianRisk', 'forcedDisplacement', 'historicalDisasters', 'earthquakeRisk', 'weatherAlerts', 'nuclearEvents', 'wildfires', 'droughtRisk', 'financialEvents', 'eventOutcomeConfidence'],
    },
    trainingData: CANDIDATE_SCORER_TRAINING_DATA,
  });
}

function buildResearchNarrative({ scored, news, macro, consumer, learned, investorPlaybookSummary, jsonDatasets, businessFormation, businessDynamics, energyFuel, vehicleSales, consumerGoodsContext, finvizContext, tradingViewContext, yahooFinanceContext, nasdaqContext, marketBeatContext, wallStreetZenContext, finraContext, ownershipContext, federalAwardsContext, dodContractsContext, disasterContext, naturalEventContext, humanitarianContext, refugeeContext, historicalDisasterContext, earthquakeContext, weatherAlertContext, nuclearEventContext, wildfireContext, droughtContext }) {
  const leaders = scored.slice(0, 3).map((s) => `${s.symbol} (${s.localAiScore})`).join(', ') || 'none';
  return {
    summary: `Autonomous scan ranked ${leaders} highest after blending news, learned web sources, macro, consumer-sales, Census BFS business-formation momentum, Census BDS business-dynamics trends, EIA fuel and energy price-volume pressure, BEA/FRED vehicle-sales demand momentum, consumer-goods industry/revenue/valuation/dividend comparison signals, FINVIZ scraped screener technical/fundamental/analyst/insider signals, TradingView scraped screener momentum/pre-market/all-time-high/sector-leadership signals, Yahoo Finance scraped screener/analyst-rating/market-mover/company-page signals, Nasdaq scraped market activity, earnings/IPO catalyst, analyst-research, institutional-holdings, and insider-activity signals, MarketBeat scraped analyst recommendations, broker upgrades/downgrades, price-target changes, and consensus forecast signals, WallStreetZen scraped quantitative Zen Rating/component-grade/screener/ticker-analysis signals, FINRA fixed-income and corporate/agency bond credit-risk signals, SEC 13F/13D/13G institutional ownership and beneficial-owner signals, USAspending federal award/contract government-demand signals, DoD/War.gov daily major contract-announcement signals, GDACS global disaster alert risk, NASA EONET natural-event risk, ReliefWeb humanitarian impact risk, UNHCR forced-displacement origin/host country pressure, EM-DAT historical disaster impact modeling, USGS earthquake/seismic risk, NWS active weather alert risk, NRC nuclear event/status risk, NIFC/WFIGS wildfire perimeter and preparedness risk, U.S. Drought Monitor weekly drought classification and DSCI risk, quote momentum, company factors, SEC filing history, historical growth/value/split watch factors, investor playbook indicators, public JSON dataset signals, and WEIGHT.md event multipliers.`,
    newsItemCount: news.items.length,
    learnedSourceCount: learned.learnedSources.length,
    learnedObservationCount: learned.observations.length,
    investorPlaybook: investorPlaybookSummary,
    jsonDatasets,
    businessFormation,
    businessDynamics,
    energyFuel,
    vehicleSales,
    consumerGoodsContext,
    finvizContext,
    tradingViewContext,
    yahooFinanceContext,
    nasdaqContext,
    marketBeatContext,
    wallStreetZenContext,
    finraContext,
    ownershipContext,
    federalAwardsContext,
    dodContractsContext,
    disasterContext,
    naturalEventContext,
    humanitarianContext,
    refugeeContext,
    historicalDisasterContext,
    earthquakeContext,
    weatherAlertContext,
    nuclearEventContext,
    wildfireContext,
    droughtContext,
    macroIndicators: macro.indicators,
    consumerReports: consumer.reports,
    topCandidates: scored.slice(0, 5).map((s) => ({
      symbol: s.symbol,
      score: s.localAiScore,
      bias: s.actionBias,
      financialEventScore: s.financialEventScore,
      historicalWatchFactors: s.evidence.historicalWatchFactors,
      secFilingHistory: s.evidence.secFilingHistory,
      businessFormation: s.evidence.businessFormation,
      businessDynamics: s.evidence.businessDynamics,
      energyFuel: s.evidence.energyFuel,
      vehicleSales: s.evidence.vehicleSales,
      finvizScreener: s.evidence.finvizScreener,
      tradingViewScreener: s.evidence.tradingViewScreener,
      yahooFinanceScreener: s.evidence.yahooFinanceScreener,
      nasdaqMarketResearch: s.evidence.nasdaqMarketResearch,
      marketBeatAnalyst: s.evidence.marketBeatAnalyst,
      wallStreetZenQuant: s.evidence.wallStreetZenQuant,
      finraCreditRisk: s.evidence.finraCreditRisk,
      secOwnership: s.evidence.secOwnership,
      usaspendingAwards: s.evidence.usaspendingAwards,
      dodContracts: s.evidence.dodContracts,
      disasterRisk: s.evidence.disasterRisk,
      naturalEvents: s.evidence.naturalEvents,
      humanitarianRisk: s.evidence.humanitarianRisk,
      forcedDisplacement: s.evidence.forcedDisplacement,
      historicalDisasters: s.evidence.historicalDisasters,
      earthquakeRisk: s.evidence.earthquakeRisk,
      weatherAlerts: s.evidence.weatherAlerts,
      nuclearEvents: s.evidence.nuclearEvents,
      wildfires: s.evidence.wildfires,
      droughtRisk: s.evidence.droughtRisk,
      reasons: s.evidence.explanation,
    })),
  };
}

function sentimentFor(candidate, text) {
  const themeLabel = candidate.theme || '';
  const terms = [candidate.symbol.toLowerCase(), ...(THEMES.find((theme) => themeLabel.includes(theme.id))?.terms || [])];
  const relevantText = terms.some((term) => text.includes(term)) ? text : '';
  const scope = relevantText || text.slice(0, 2000);
  const positive = POSITIVE_TERMS.reduce((count, term) => count + occurrences(scope, term), 0);
  const negative = NEGATIVE_TERMS.reduce((count, term) => count + occurrences(scope, term), 0);
  return Math.max(-4, Math.min(4, positive - negative));
}

function selectValuableArticles(newsItems, { maxArticles = 6 } = {}) {
  return (newsItems || [])
    .filter((item) => item && item.link)
    .map((item) => {
      const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
      const themeHits = THEMES.reduce((count, theme) => count + theme.terms.reduce((c, term) => c + occurrences(text, term), 0), 0);
      const positive = POSITIVE_TERMS.reduce((count, term) => count + occurrences(text, term), 0);
      const negative = NEGATIVE_TERMS.reduce((count, term) => count + occurrences(text, term), 0);
      const score = themeHits * 2 + positive + negative;
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxArticles)
    .map(({ item }) => item);
}

function inferMacroRisk(indicators) {
  const inflation = indicators.find((item) => item.id === 'us-cpi-inflation')?.value;
  const worldGrowth = indicators.find((item) => item.id === 'world-gdp-growth')?.value;
  if (inflation > 4 || worldGrowth < 1.5) return 'risk-off';
  if (inflation < 3 && worldGrowth > 2.5) return 'risk-on';
  return 'mixed';
}

async function fetchJson(url, timeoutMs) {
  const res = await fetchWithTimeout(url, timeoutMs, { Accept: 'application/json,text/plain,*/*' });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.json();
}

async function fetchText(url, timeoutMs) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'application/rss+xml,application/xml,text/xml,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader autonomous research bot',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseRssItems(xml, feed) {
  const matches = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)];
  return matches.map((match) => {
    const item = match[0];
    return {
      source: feed.name,
      region: feed.region,
      title: decodeXml(pickTag(item, 'title')),
      link: decodeXml(pickTag(item, 'link')),
      publishedAt: decodeXml(pickTag(item, 'pubDate')),
      description: stripTags(decodeXml(pickTag(item, 'description'))).slice(0, 280),
    };
  });
}

function dedupeNewsItems(items) {
  const seen = new Set();
  const deduped = [];
  for (const item of items || []) {
    const key = item.link || item.url || item.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function pickTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return (match?.[1] || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function occurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  return haystack.split(needle.toLowerCase()).length - 1;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

function meshTell({ conversation, from, to, op, body, userId, researchRunId }) {
  try {
    brainMesh.tell({
      from,
      to,
      kind: 'event',
      op,
      body,
      ctx: { userId, researchRunId },
      conv: conversation.id,
      trace: conversation.metadata?.trace,
      qos: { durable: true, priority: 'normal' },
    });
  } catch (err) {
    logger.warn('BrainMesh event failed', { op, error: err.message });
  }
}

module.exports = {
  runAutonomousResearch,
  DEFAULT_UNIVERSE,
  buildPrePlan,
  scoreCandidates,
  collectQuotes,
  collectNews,
  NEWS_FEEDS,
  selectValuableArticles,
  listRecentWatcherSignals,
};
