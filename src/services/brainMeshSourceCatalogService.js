const {
  SPEC_DATA_SOURCE_CATALOG,
  SPEC_DISCOVERY_QUERIES,
  SPEC_RELEVANCE_TERMS,
} = require('./spec/specDataSourceCatalog');

const DEFAULT_LIMIT = 18;
const MAX_LIMIT = 60;

const SOURCE_PACKS = {
  housing: {
    title: 'Housing demand and construction',
    query: 'housing new residential sales construction permits starts completions months supply fred census realtor redfin listing market completed sales inventory hotness',
    tags: ['housing', 'new-residential-sales', 'new-residential-construction', 'listing-market', 'completed-sales', 'local-housing-market', 'fred', 'census', 'realtor-com', 'redfin'],
  },
  regulatory: {
    title: 'Regulatory, filings, enforcement, and official releases',
    query: 'sec edgar litigation trading suspension ftc doj cfpb fda openfda food enforcement usda fsis meat poultry egg cpsc nhtsa vehicle automotive recalls consumer product safety federal reserve nrc nuclear regulatory commission event notifications power reactor status shutdown safety incident regulatory notification',
    tags: ['sec', 'regulatory', 'filings', 'enforcement', 'ftc', 'doj', 'cfpb', 'fda', 'openfda', 'food-enforcement', 'usda', 'fsis', 'cpsc', 'nhtsa', 'vehicle', 'automotive', 'recalls', 'federal-reserve', 'nrc', 'nuclear-regulatory-commission', 'event-notifications', 'reactor-status'],
  },
  discovery: {
    title: 'Company and event discovery',
    query: 'gdelt google news businesswire globenewswire pr newswire amazon best sellers movers shakers walmart best sellers walmart trending bought since yesterday low stock availability unit price bestseller rank sales rank acceleration product rank finviz tradingview yahoo finance nasdaq marketbeat wallstreetzen screener market activity earnings calendar ipo calendar analyst research analyst recommendations institutional holdings insider activity broker actions price target changes consensus forecast zen ratings quant ratings component grades top gainers top losers unusual volume upgrades downgrades analyst ratings insider latest buys premarket all time highs sector leadership most active trending startup funding ipo acquisition product launch',
    tags: ['gdelt', 'google-news', 'issuer-paid', 'amazon', 'walmart', 'best-sellers', 'movers-and-shakers', 'walmart-best-sellers', 'walmart-trending', 'bought-since-yesterday', 'low-stock', 'availability', 'unit-price', 'bestseller-rank', 'sales-rank-acceleration', 'retail-product-rank', 'finviz', 'tradingview', 'yahoo-finance', 'nasdaq', 'marketbeat', 'wallstreetzen', 'stock-screener', 'screener', 'market-activity', 'earnings-calendar', 'ipo-calendar', 'analyst-research', 'analyst-recommendations', 'broker-actions', 'price-target-changes', 'consensus-forecast', 'zen-ratings', 'quant-ratings', 'component-grades', 'institutional-holdings', 'insider-activity', 'startup', 'funding', 'ipo', 'acquisition', 'press-release'],
  },
  'market-screener': {
    title: 'Market screener discovery, technical signals, analyst actions, and insider activity',
    query: 'finviz tradingview yahoo finance nasdaq marketbeat wallstreetzen stock screener valuation growth profitability analyst recommendations analyst ratings analyst research broker actions analyst firm previous rating new rating previous target new target price target changes consensus forecast zen ratings quant ratings component grades financial safety sentiment ai factor ratings institutional holdings insider activity short interest volume technical trends performance top gainers top losers new high new low all time highs most active unusual volume trending upgrades downgrades latest insider buys quality growth fundamental screen premarket gainers relative strength sector leadership market movers market activity earnings calendar ipo calendar quote analysis financials cash flow balance sheet',
    tags: ['finviz', 'tradingview', 'yahoo-finance', 'nasdaq', 'marketbeat', 'wallstreetzen', 'stock-screener', 'screener', 'valuation', 'growth', 'profitability', 'analyst-recommendations', 'analyst-ratings', 'analyst-research', 'broker-actions', 'analyst-upgrades', 'analyst-downgrades', 'price-target-changes', 'consensus-forecast', 'zen-ratings', 'quant-ratings', 'component-grades', 'factor-ratings', 'institutional-holdings', 'insider-activity', 'short-interest', 'technical-signals', 'market-performance', 'top-gainers', 'top-losers', 'new-high', 'new-low', 'all-time-highs', 'most-active', 'unusual-volume', 'trending', 'upgrades', 'downgrades', 'insider-buys', 'pre-market', 'relative-strength', 'sector-leadership', 'market-movers', 'market-activity', 'earnings-calendar', 'ipo-calendar', 'financial-statements', 'cash-flow', 'balance-sheet'],
  },
  'consumer-goods-industry': {
    title: 'Consumer-goods and household/personal-products industry discovery',
    query: 'stockanalysis household personal products industry yahoo finance household personal products sector companiesmarketcap consumer goods largest companies by revenue fortune 500 revenue ranking market capitalization revenue profits valuation dividend measures consumer defensive cpg home care personal care',
    tags: ['stockanalysis', 'yahoo-finance', 'companiesmarketcap', 'fortune-500', 'consumer-goods', 'consumer-defensive', 'household-personal-products', 'household-products', 'personal-products', 'cpg', 'home-care', 'personal-care', 'industry-ranking', 'revenue-ranking', 'market-cap', 'revenue', 'profits', 'valuation', 'dividend-yield', 'scraping', 'verify-before-trading'],
  },
  'credit-risk': {
    title: 'Credit markets, fixed income, and bond-risk signals',
    query: 'finra data fixed income corporate agency bonds trade activity market statistics bond prices yield spread widening falling bond prices distressed trading downgrade risk refinancing pressure equity credit divergence issuer ticker mapping',
    tags: ['finra', 'finra-data', 'fixed-income', 'corporate-bonds', 'agency-bonds', 'bond-details', 'trade-activity', 'market-statistics', 'yield-spread', 'falling-bond-prices', 'distressed-trading', 'downgrade-risk', 'refinancing-pressure', 'equity-credit-divergence', 'credit-risk', 'official-sro'],
  },
  ownership: {
    title: 'Institutional ownership, hedge funds, and beneficial-owner filings',
    query: 'sec 13f 13f-hr schedule 13d schedule 13g institutional holdings hedge funds investment managers beneficial ownership activist stakes passive owners large beneficial owners concentrated ownership new institutional positions position increases reductions delayed holdings',
    tags: ['sec', 'edgar', '13f', '13f-hr', '13d', '13g', 'institutional-holdings', 'hedge-funds', 'investment-managers', 'beneficial-ownership', 'activist-stake', 'passive-owner', 'large-beneficial-owner', 'concentrated-ownership', 'new-institutional-positions', 'position-increases', 'position-reductions', 'delayed-holdings'],
  },
  'government-contracts': {
    title: 'Federal contracts, awards, defense spending, and government-demand catalysts',
    query: 'usaspending federal contracts awards grants loans recipient contractor parent company department of defense dod contracts daily contract announcements contract announcements war gov military branch award amount award value contract type product service place of performance country psc product service code naics contracting office contracting activity funding agency funding source awarding agency contract description expected completion date infrastructure government demand revenue catalyst war conflict inferred threshold limited',
    tags: ['usaspending', 'federal-awards', 'government-contracts', 'contracts', 'grants', 'loans', 'defense', 'department-of-defense', 'dod-contracts', 'daily-contract-announcements', 'contract-announcements', 'war-gov', 'military-branch', 'contractor', 'recipient', 'parent-company', 'award-amount', 'award-value', 'contract-type', 'place-of-performance', 'psc', 'product-service-code', 'naics', 'awarding-office', 'contracting-activity', 'funding-agency', 'funding-source', 'awarding-agency', 'contract-description', 'expected-completion-date', 'threshold-limited', 'infrastructure', 'government-demand', 'revenue-catalyst', 'conflict-inference'],
  },
  'defense-geopolitics': {
    title: 'Defense spending, arms flows, and geopolitical military datasets',
    query: 'sipri military expenditure military spending arms transfers trend indicator value TIV major conventional weapons supplier recipient order delivery arms industry top 100 arms-producing military services companies arms company revenue financial value global arms trade arms exports licences agreements orders arms embargoes peace operations nuclear forces country defense budget geopolitical defense context not contract award value',
    tags: ['sipri', 'military-expenditure', 'military-spending', 'arms-transfers', 'trend-indicator-value', 'tiv', 'major-conventional-weapons', 'supplier', 'recipient', 'arms-industry', 'arms-company-revenue', 'arms-producing-companies', 'financial-value-arms-trade', 'arms-exports', 'arms-embargoes', 'peace-operations', 'nuclear-forces', 'defense-geopolitics', 'defense-spending', 'country-defense-budget', 'open-source', 'measure-specific'],
  },
  inflation: {
    title: 'Consumer prices, CPI inflation, and selected product average prices',
    query: 'bls cpi consumer price index inflation average price data product prices food at home apparel new vehicles used vehicles appliances furniture computers smartphones prescription drugs recreational goods gasoline electricity natural gas eggs milk bread meat seriesid',
    tags: ['bls', 'cpi', 'consumer-price-index', 'inflation', 'prices', 'average-price-data', 'actual-dollar-prices', 'food-at-home', 'apparel', 'new-vehicles', 'used-vehicles', 'appliances', 'furniture', 'computers', 'smartphones', 'prescription-drugs', 'recreational-goods', 'gasoline', 'electricity', 'natural-gas', 'seriesid'],
  },
  'producer-prices': {
    title: 'Producer prices, PPI, input costs, and price pass-through',
    query: 'bls ppi producer price index producer prices selling prices domestic producers final demand intermediate demand input price indexes manufacturer pricing input cost pressure wholesale price trends industry margins price pass-through product category inflation goods services construction transportation warehousing',
    tags: ['bls', 'ppi', 'producer-price-index', 'producer-prices', 'selling-prices', 'domestic-producers', 'final-demand', 'intermediate-demand', 'input-price-indexes', 'manufacturer-pricing', 'input-cost-pressure', 'wholesale-price-trends', 'industry-margins', 'price-pass-through', 'product-category-inflation'],
  },
  'energy-fuel': {
    title: 'Fuel sales, energy prices, inventories, and shipping-cost pressure',
    query: 'eia open data api v2 gasoline prices diesel prices petroleum product supplied retail fuel volumes refinery output inventories electricity sales prices natural gas sales prices gas diesel fuel update weekly fuel prices padd state city shipping logistics consumer fuel pressure nrc nuclear reactor status outage derate replacement power',
    tags: ['eia', 'api-v2', 'energy', 'fuel-prices', 'gasoline-prices', 'diesel-prices', 'retail-fuel-prices', 'petroleum-product-supplied', 'retail-fuel-volumes', 'refinery-output', 'inventories', 'electricity-sales', 'electricity-prices', 'natural-gas-sales', 'natural-gas-prices', 'shipping-costs', 'logistics-costs', 'consumer-fuel-pressure', 'nuclear-power', 'reactor-status', 'replacement-power'],
  },
  nuclear: {
    title: 'NRC nuclear facility event notifications and reactor status',
    query: 'nrc nuclear regulatory commission event notifications power reactor status shutdowns safety incidents regulatory notifications scram part 21 emergency class cfr current power outage derate nuclear utilities uranium grid replacement power',
    tags: ['nrc', 'nuclear-regulatory-commission', 'nuclear', 'event-notifications', 'event-status', 'reactor-status', 'power-reactor-status', 'shutdown', 'scram', 'part-21', 'emergency-class', 'cfr', 'current-power', 'outage', 'derate', 'nuclear-utilities', 'uranium', 'grid-risk'],
  },
  'vehicle-sales': {
    title: 'Vehicle sales, auto-demand momentum, and BEA/FRED aggregate volume',
    query: 'bea api itable fred totalsa altsales dautosaar vehicle sales light vehicle sales domestic auto sales motor vehicle output aggregate sales saar automakers suppliers dealers fleet rental auto finance',
    tags: ['bea', 'bea-api', 'itable', 'fred', 'vehicle-sales', 'auto-sales', 'total-vehicle-sales', 'light-vehicle-sales', 'domestic-auto-sales', 'motor-vehicle-output', 'aggregate-sales', 'saar'],
  },
  'global-disasters': {
    title: 'Global disaster alerts, location risk, and recovery exposure',
    query: 'gdacs nasa eonet reliefweb emdat cred hdx unhcr refugee data finder refugee statistics refugees asylum seekers internally displaced stateless populations host country origin country usgs earthquake catalog fdsn seismic risk pager shakemap cdi mmi magnitude depth tsunami nifc wfigs wildfire perimeters current incidents acres burned containment preparedness level imsr inciweb national incident map global disaster historical disaster natural event humanitarian report situation report alert coordination system rss georss api openapi earth observatory satellite imagery earthquake tropical cyclone severe storm flood wildfire drought volcano tsunami dust haze landslide extreme temperature alert level population exposure casualty displacement aid requirements economic losses economic damage conflict geometry location supply chain insurance humanitarian openfema',
    tags: ['gdacs', 'nasa', 'eonet', 'reliefweb', 'emdat', 'cred', 'hdx', 'unhcr', 'refugee-data-finder', 'refugee-statistics', 'refugees', 'asylum-seekers', 'idps', 'internally-displaced', 'stateless', 'host-country', 'origin-country', 'usgs', 'earthquake-catalog', 'fdsn', 'seismic-risk', 'pager', 'shakemap', 'cdi', 'mmi', 'magnitude', 'depth', 'nifc', 'wfigs', 'wildfire-perimeters', 'current-incidents', 'acres-burned', 'containment', 'preparedness-level', 'imsr', 'inciweb', 'disaster', 'historical-disasters', 'economic-losses', 'human-impact', 'natural-events', 'humanitarian', 'humanitarian-reports', 'situation-reports', 'global', 'alerts', 'rss', 'georss', 'openapi', 'satellite-imagery', 'earthquake', 'tropical-cyclone', 'severe-storms', 'flood', 'wildfire', 'drought', 'volcano', 'tsunami', 'dust-haze', 'landslides', 'extreme-temperatures', 'population-exposure', 'casualties', 'displacement', 'aid-requirements', 'conflict', 'location-aware', 'supply-chain', 'insurance', 'fema'],
  },
  humanitarian: {
    title: 'Humanitarian displacement, refugee, asylum, and stateless population data',
    query: 'unhcr refugee data finder api refugee statistics population refugees asylum seekers internally displaced people idps stateless populations country of origin host country trends demographics solutions reliefweb humanitarian reports displacement aid requirements conflict emergency',
    tags: ['unhcr', 'refugee-data-finder', 'refugee-statistics', 'population-api', 'refugees', 'asylum-seekers', 'idps', 'internally-displaced', 'stateless', 'country-of-origin', 'host-country', 'demographics', 'solutions', 'humanitarian', 'displacement', 'aid-requirements', 'reliefweb', 'conflict', 'location-aware'],
  },
  wildfires: {
    title: 'NIFC wildfire incidents, perimeters, containment, and preparedness',
    query: 'nifc national interagency fire center wfigs current interagency fire perimeters wildfire incidents fire perimeters acres burned containment incident status preparedness level imsr national incident map inciweb fire history arcgis open data geoservice geojson utility insurance timber agriculture logistics recovery spend',
    tags: ['nifc', 'wfigs', 'wildfire', 'wildland-fire', 'current-incidents', 'fire-perimeters', 'wildfire-perimeters', 'acres-burned', 'containment', 'incident-status', 'preparedness-level', 'imsr', 'inciweb', 'fire-history', 'arcgis', 'geoservice', 'geojson', 'utility-risk', 'insurance', 'timber', 'agriculture', 'logistics', 'smoke', 'recovery-spend', 'location-aware'],
  },
  drought: {
    title: 'U.S. drought classifications, DSCI, and drought geography',
    query: 'us drought monitor usdm ndmc drought severity coverage index dsci comprehensive statistics D0 D1 D2 D3 D4 weekly state county huc climate division gis geojson shapefile wms agriculture water utility wildfire crop livestock food inflation',
    tags: ['usdm', 'drought-monitor', 'drought', 'drought-classification', 'dsci', 'd0', 'd1', 'd2', 'd3', 'd4', 'weekly', 'state', 'county', 'huc', 'climate-division', 'gis', 'geojson', 'shapefile', 'wms', 'agriculture', 'water-utility', 'wildfire-risk', 'food-inflation', 'livestock', 'crop', 'location-aware'],
  },
  'weather-alerts': {
    title: 'NWS active weather alerts, watches, warnings, and advisories',
    query: 'national weather service nws api weather alerts active warnings watches advisories emergency products area point event tornado warning flood warning severe thunderstorm hurricane winter storm heat red flag user agent local risk supply chain retail footprint utility insurance logistics agriculture',
    tags: ['nws', 'noaa', 'weather', 'weather-alerts', 'active-alerts', 'warnings', 'watches', 'advisories', 'emergency-weather', 'tornado-warning', 'flood-warning', 'severe-thunderstorm', 'hurricane', 'winter-storm', 'heat', 'red-flag', 'area-filter', 'point-filter', 'event-filter', 'user-agent', 'location-aware', 'supply-chain', 'retail-footprint', 'utility-risk', 'insurance', 'logistics', 'agriculture'],
  },
  'food-retail': {
    title: 'Retail food sales, scanner demand, and grocery category trends',
    query: 'usda ers weekly retail food sales circana scanner data grocery demand food category sales unit sales price versus volume pandemic recession seasonal demand national subcategory state category proprietary upc transaction data documentation',
    tags: ['usda', 'ers', 'weekly-retail-food-sales', 'retail-food-sales', 'food-demand', 'grocery-demand', 'scanner-data', 'circana', 'food-category-sales', 'unit-sales', 'price-versus-volume', 'seasonal-food-demand', 'public-summary', 'proprietary-underlying-data'],
  },
  'food-prices': {
    title: 'Agricultural commodity prices, food prices, and food expenditures',
    query: 'usda ams market news mymarketnews agricultural commodity prices volume wholesale retail shipping data beef pork poultry dairy eggs grains fruits vegetables specialty crops livestock ers food prices expenditures establishments food price outlook food cpi ppi food-at-home monthly area prices f-map farm-to-retail price spreads',
    tags: ['usda', 'ams', 'market-news', 'mymarketnews', 'agricultural-market-news', 'agricultural-prices', 'commodity-prices', 'commodity-volume', 'wholesale', 'shipping-data', 'beef', 'pork', 'poultry', 'dairy', 'eggs', 'grains', 'fruits', 'vegetables', 'specialty-crops', 'livestock', 'ers', 'food-prices', 'food-expenditures', 'food-price-outlook', 'food-cpi', 'food-ppi', 'f-map', 'farm-to-retail-price-spreads'],
  },
  retail: {
    title: 'Retail demand, category sales, inventories, and ecommerce',
    query: 'census mrts marts mtis arts aies amazon best sellers movers shakers walmart best sellers top 100 home trending bought since yesterday low stock availability unit price bestseller rank sales rank acceleration product rank monthly retail trade advance monthly sales manufacturing trade inventories sales annual retail trade survey retail sales inventory inventory-to-sales ecommerce gross margins operating expenses merchandise line category code data type code motor vehicle furniture electronics building materials food beverage health personal care gasoline clothing sporting goods general merchandise nonstore wholesale manufacturing demand slowdown excess inventory supply shortage home kitchen household supplies kitchen dining laundry cleaning cleaners',
    tags: ['census', 'mrts', 'marts', 'mtis', 'arts', 'aies', 'amazon', 'walmart', 'best-sellers', 'movers-and-shakers', 'walmart-best-sellers', 'walmart-trending', 'bought-since-yesterday', 'low-stock', 'availability', 'unit-price', 'bestseller-rank', 'sales-rank-acceleration', 'retail-product-rank', 'monthly-retail-trade', 'advance-monthly-sales', 'manufacturing-trade-inventories-sales', 'annual-retail-trade-survey', 'annual-integrated-economic-survey', 'retail-sales', 'retail-inventories', 'inventory-to-sales', 'nonstore-ecommerce', 'gross-margins', 'operating-expenses', 'merchandise-line', 'category-code', 'data-type-code', 'consumer-demand', 'demand-slowdown', 'excess-inventory', 'supply-shortage'],
  },
  manufacturing: {
    title: 'Manufacturing shipments, inventories, orders, and upstream demand',
    query: 'census m3 advm3 manufacturers shipments inventories orders factory orders new orders unfilled orders durable goods computers electronics machinery transportation equipment appliances components upstream demand product sector activity',
    tags: ['census', 'm3', 'advm3', 'manufacturing', 'manufacturers-shipments', 'manufacturers-inventories', 'manufacturers-orders', 'factory-orders', 'new-orders', 'shipments', 'unfilled-orders', 'inventories', 'durable-goods', 'computers-electronics', 'machinery', 'transportation-equipment', 'upstream-demand'],
  },
  official: {
    title: 'Official public data sources',
    query: 'census fred sec bls bea treasury eia nrc nuclear regulatory commission event notifications power reactor status open data fuel prices gasoline diesel petroleum product supplied electricity natural gas vehicle sales totalsa altsales dautosaar nws noaa weather alerts active warnings watches advisories tornado flood area point event user agent nifc wfigs wildfire perimeters current incidents acres burned containment preparedness level gdacs nasa eonet reliefweb emdat cred hdx unhcr refugee statistics refugees asylum seekers idps stateless host origin usgs earthquake catalog fdsn seismic risk pager shakemap mmi cdi global disaster historical disaster natural events humanitarian reports satellite imagery alerts rss georss world bank fema weather usaspending federal awards contracts grants loans recipient contractor department of defense dod contracts daily contract announcements contract announcements war gov sipri military expenditure arms transfers trend indicator value arms industry arms company revenue arms embargoes peace operations nuclear forces contracting activity funding source psc naics place of performance clinicaltrials openfda food enforcement usda ams ers fsis nhtsa vehicle recalls cpsc cpi ppi average price data producer price index weekly retail food sales scanner data agricultural market news mymarketnews food price outlook mrts marts mtis arts aies retail sales annual retail trade survey manufacturing trade inventories sales m3 advm3 manufacturing shipments orders inventories',
    tags: ['census', 'fred', 'sec', 'bls', 'bea', 'treasury', 'eia', 'nrc', 'nuclear-regulatory-commission', 'event-notifications', 'reactor-status', 'fuel-prices', 'gasoline-prices', 'diesel-prices', 'petroleum-product-supplied', 'electricity-prices', 'natural-gas-prices', 'vehicle-sales', 'auto-sales', 'total-vehicle-sales', 'light-vehicle-sales', 'domestic-auto-sales', 'nws', 'noaa', 'weather-alerts', 'active-alerts', 'warnings', 'watches', 'advisories', 'tornado-warning', 'flood-warning', 'area-filter', 'point-filter', 'event-filter', 'user-agent', 'nifc', 'wfigs', 'wildfire-perimeters', 'current-incidents', 'acres-burned', 'containment', 'preparedness-level', 'gdacs', 'nasa', 'eonet', 'reliefweb', 'emdat', 'cred', 'hdx', 'unhcr', 'refugee-statistics', 'refugees', 'asylum-seekers', 'idps', 'stateless', 'usgs', 'earthquake-catalog', 'fdsn', 'seismic-risk', 'pager', 'shakemap', 'mmi', 'cdi', 'historical-disasters', 'economic-losses', 'natural-events', 'humanitarian-reports', 'satellite-imagery', 'global-disaster-alerts', 'usaspending', 'federal-awards', 'government-contracts', 'contracts', 'grants', 'loans', 'defense', 'department-of-defense', 'dod-contracts', 'daily-contract-announcements', 'contract-announcements', 'war-gov', 'sipri', 'military-expenditure', 'arms-transfers', 'trend-indicator-value', 'arms-industry', 'arms-company-revenue', 'arms-embargoes', 'peace-operations', 'nuclear-forces', 'contracting-activity', 'funding-source', 'psc', 'naics', 'place-of-performance', 'government-demand', 'openfda', 'food-enforcement', 'usda', 'ams', 'ers', 'fsis', 'nhtsa', 'vehicle', 'cpsc', 'cpi', 'ppi', 'average-price-data', 'producer-price-index', 'weekly-retail-food-sales', 'scanner-data', 'agricultural-market-news', 'mymarketnews', 'food-price-outlook', 'mrts', 'marts', 'mtis', 'arts', 'aies', 'annual-retail-trade-survey', 'manufacturing-trade-inventories-sales', 'retail-sales', 'm3', 'advm3', 'manufacturing'],
  },
  safety: {
    title: 'Product safety, recalls, injuries, and remedy costs',
    query: 'cpsc nhtsa vehicle automotive openfda food enforcement usda fsis meat poultry egg recalls consumer product safety hazards injuries remedies affected units manufacturer retailer recalling firm pounds recalled campaign number regulatory risk',
    tags: ['cpsc', 'nhtsa', 'vehicle', 'automotive', 'openfda', 'food-enforcement', 'usda', 'fsis', 'food-recall', 'recalls', 'consumer-product-safety', 'consumer-products', 'hazard', 'injury', 'remedy', 'pounds-recalled', 'campaign-number', 'regulatory-risk'],
  },
};

function listCatalog(body = {}) {
  const limit = normalizeLimit(body.limit);
  const sources = filterSources(body).slice(0, limit).map((source) => compactSource(source, body));
  return {
    total: SPEC_DATA_SOURCE_CATALOG.length,
    returned: sources.length,
    filters: summarizeFilters(body),
    categories: categorySummary(),
    sources,
  };
}

function searchCatalog(body = {}) {
  const query = cleanText(body.query || body.q);
  const limit = normalizeLimit(body.limit);
  const sources = scoreSources(query, filterSources(body))
    .filter((item) => item.score > 0 || !query)
    .slice(0, limit)
    .map((item) => ({
      ...compactSource(item.source, body),
      matchScore: Number(item.score.toFixed(3)),
      matchedTerms: item.matchedTerms.slice(0, 10),
    }));
  return {
    query,
    total: sources.length,
    sources,
    discoveryQueries: selectMatchingStrings(SPEC_DISCOVERY_QUERIES, query, 8),
    relevanceTerms: selectMatchingStrings(SPEC_RELEVANCE_TERMS, query, 16),
  };
}

function getSourcePack(body = {}) {
  const packKey = cleanText(body.pack || body.name || 'discovery').toLowerCase();
  const pack = SOURCE_PACKS[packKey] || {
    title: packKey ? `Ad hoc source pack: ${packKey}` : 'Ad hoc source pack',
    query: cleanText(body.query || packKey),
    tags: normalizeStringArray(body.tags),
  };
  const query = cleanText(body.query || pack.query);
  const sourceBody = {
    ...body,
    query,
    tags: [...new Set([...(pack.tags || []), ...normalizeStringArray(body.tags)])],
    limit: body.limit || 24,
    includeRequiredFields: body.includeRequiredFields !== false,
  };
  const search = searchCatalog(sourceBody);
  return {
    pack: SOURCE_PACKS[packKey] ? packKey : 'ad-hoc',
    title: pack.title,
    query,
    sourceCount: search.sources.length,
    sources: search.sources,
    conversationHints: [
      'Use issuer-paid press releases as lead generation, not independent evidence.',
      'Prefer official primary data and preserve observation/release dates for point-in-time reasoning.',
      'Treat Realtor.com listing prices and inventory as current listing-market conditions, not completed sale prices.',
      'Treat Redfin as local completed-sales and transaction-market context; compare it with Census/FRED official series and Realtor.com listing conditions.',
      'Treat CPSC recall records as official product-safety risk evidence; map manufacturers, retailers, importers, and distributors to tickers before scoring.',
      'Treat FDA food enforcement records as official recall severity and distribution evidence; map recalling firms and affected food products to public companies before scoring.',
      'Treat USDA FSIS meat, poultry, and egg recall records as official operational and brand-risk evidence; compare pounds recalled, establishment numbers, health risk, and retail distribution before scoring.',
      'Treat NHTSA vehicle and automotive-equipment recall records as official auto safety evidence; compare campaign counts, affected vehicles, components, consequences, remedies, and completion signals before scoring.',
      'Treat NWS active alerts as official current U.S. watches, warnings, advisories, and emergency weather evidence; send an identifying User-Agent and compare affected areas/geometry with company locations, logistics lanes, and customer markets before scoring.',
      'Treat NRC event notifications and power reactor status as official nuclear-facility safety/outage evidence; compare event descriptions, emergency class, CFR codes, scrams, current power, shutdown/derate signals, and plant/operator/vendor exposure before scoring.',
      'Treat U.S. Drought Monitor data as official weekly drought-classification and DSCI evidence; compare D0-D4, DSCI, AOI, geography, and release/valid dates with company facilities, customer markets, agriculture, food costs, water utilities, wildfire amplification, livestock, and logistics before scoring.',
      'Treat BLS CPI and average price data as official price/inflation evidence; compare category indexes, selected product dollar prices, energy/food sensitivity, and footnotes before scoring margin or demand pressure.',
      'Treat BLS PPI as official producer selling-price evidence; compare final/intermediate demand, input costs, wholesale trends, industry margins, and price pass-through separately from CPI.',
      'Treat EIA Open Data and Gasoline/Diesel Fuel Update as official energy fuel price/volume evidence; use the EIA key for API pulls when configured, otherwise cite public pages/downloads.',
      'Treat BEA/FRED vehicle-sales records as official aggregate auto-demand evidence; do not confuse them with manufacturer/model registration data.',
      'Treat FINVIZ, TradingView, Yahoo Finance, Nasdaq, MarketBeat, and WallStreetZen public market research/screener/analyst/quant-rating pages as scraped, delayed or unsupported consumer market-discovery evidence; use them to identify candidates and debate signals, then corroborate with broker quotes, Finnhub/company research, original broker notes where available, SEC filings, Nasdaq Trader/security-master data, GDELT/Google News, and official sources before scoring live trades.',
      'Treat Stock Analysis, Yahoo Finance industry pages, CompaniesMarketCap, and Fortune 500 consumer-goods/revenue-ranking rows as scraped consumer-goods industry discovery evidence; use them to identify CPG, household/personal-products, home-care, and personal-care candidates, then corroborate market cap, revenue, profit, valuation, dividend, and ticker mappings with SEC filings, company reports, broker/Finnhub quotes, BLS/Census/Amazon/Walmart demand proxies, and independent news before scoring.',
      'Never convert "analyst says Buy" directly into a buy decision. For analyst upgrades or ratings, ask brain.evaluation decision.analyst.gate.evaluate and require new issuance, material estimate/price-target change, analyst credibility, SEC support, attractive valuation, liquidity, and portfolio-risk checks before the idea becomes a candidate for further evaluation.',
      'Treat FINRA fixed-income and corporate/agency bond trade-activity pages as official credit-market risk evidence; debate yield-spread widening, falling bond prices, distressed trading, downgrade risk, refinancing pressure, and equity-credit divergence, then verify issuer-to-ticker mappings before applying signals to equities.',
      'Treat SEC 13F/13D/13G ownership feeds as official filing-discovery evidence; debate institutional accumulation/reduction, activist stakes, passive large owners, and concentration risk, then verify filing documents and remember 13F holdings are delayed.',
      'Treat USAspending.gov as official federal award/contract evidence; debate contractor revenue catalysts, government-demand trends, agency budget signals, PSC/NAICS exposure, and place-of-performance geography, but label any war/conflict relationship as inferred unless verified by contract documents, contracting command, appropriation, task order, or budget records.',
      'Treat DoD/War.gov daily contract announcements as official major-contract evidence; they are threshold-limited ($7.5M+) and should be paired with USAspending for broader coverage.',
      'Treat SIPRI as measure-specific defense/geopolitical context: military expenditure, arms-transfer TIV, arms-company revenue, financial arms-trade value, embargoes, peace operations, nuclear forces, and contract award values are separate measures. TIV is transfer volume, not financial price. Use USAspending or DoD/War.gov for contract award values.',
      'Treat GDACS as official near-real-time global disaster alert evidence; compare alert levels, exposed population, geometry/location, severity, and company location overlap before scoring.',
      'Treat USGS Earthquake Catalog and real-time GeoJSON feeds as official seismic risk evidence; compare magnitude, depth, PAGER alert, intensity, tsunami flag, geometry, and company location/supply-chain overlap before scoring.',
      'Treat NIFC/WFIGS as official U.S. wildfire incident, perimeter, acres-burned, containment, and preparedness-level evidence; compare incident geometry/status with company facilities, customer markets, utilities, insurers, timber/agriculture, logistics, and recovery demand before scoring.',
      'Treat NASA EONET as official natural-event and satellite-imagery metadata evidence; compare category, geometry, magnitude, source URLs, and company location/customer/supply-chain overlap before scoring.',
      'Treat ReliefWeb as curated humanitarian disaster/report evidence; compare country, disaster type, report themes, source organizations, casualty/displacement/aid signals, and company location/supply-chain overlap before scoring.',
      'Treat UNHCR Refugee Statistics as official annual forced-displacement population evidence; compare refugees, asylum seekers, IDPs, stateless populations, origin/host country trends, and latest reporting year with company country exposure before scoring.',
      'Treat EM-DAT/CRED as historical disaster-impact and economic-loss modeling evidence, not a live alert feed; respect registration, non-commercial, and usage-term constraints for detailed downloads.',
      'Treat USDA ERS Weekly Retail Food Sales as public category-level scanner-demand evidence; do not assume public UPC-level access, and ignore removed volume-sales fields.',
      'Treat USDA AMS Market News and MyMarketNews as official agricultural commodity price/volume evidence; API-scale pulls require a configured USDA AMS/MyMarketNews key.',
      'Treat USDA ERS food-price products as official food price, expenditure, CPI/PPI forecast, and regional food-at-home price evidence; preserve methodology and coverage windows.',
      'Treat Census MRTS/MARTS/MTIS and ARTS/AIES as official category-level or aggregate retail/trade evidence; use variables metadata for category/data-type codes, compare advance-vs-final revisions and inventory-to-sales signals, and never treat it as UPC-level, store-level, or company-specific sales.',
      'Treat Amazon Best Sellers/Movers & Shakers and Walmart best-seller/trending/category pages as scraped storefront product-rank, acceleration, availability, and low-stock discovery evidence; never treat them as sales volume, revenue, market share, UPC scanner data, or company financial performance.',
      'Treat Census M3/ADVM3 as official upstream manufacturing activity evidence; compare shipments, new orders, unfilled orders, inventories, sectors, and advance-vs-full revisions before scoring producers or suppliers.',
      'Ask brain.llm.ollama to summarize only compact source packs or cited excerpts, not full archives.',
      'Persist newly discovered high-value URLs through source.hint.persist after verification.',
    ],
    discoveryQueries: search.discoveryQueries,
    relevanceTerms: search.relevanceTerms,
  };
}

function shareCatalog(body = {}, envelope = {}) {
  const pack = getSourcePack(body);
  return {
    shared: true,
    from: envelope.from,
    ctx: envelope.ctx,
    pack,
    suggestedOp: 'source.catalog.pack',
  };
}

function compactSource(source, body = {}) {
  const compact = {
    id: source.id,
    title: source.title,
    url: source.url,
    category: source.category,
    tags: source.tags || [],
    credibilityScore: source.credibilityScore,
    relevanceScore: source.relevanceScore,
    evidenceMode: evidenceMode(source),
    bmclUse: bmclUse(source),
  };
  if (body.includeRequiredFields) compact.requiredFields = (source.requiredFields || []).slice(0, 16);
  if (body.includeNotes) compact.implementationNotes = cleanText(source.implementationNotes).slice(0, 700);
  return compact;
}

function filterSources(body = {}) {
  const ids = new Set(normalizeStringArray(body.ids));
  const categories = new Set(normalizeStringArray(body.categories || body.category).map((item) => item.toLowerCase()));
  const tags = normalizeStringArray(body.tags || body.tag).map((item) => item.toLowerCase());
  return SPEC_DATA_SOURCE_CATALOG.filter((source) => {
    if (ids.size && !ids.has(source.id)) return false;
    if (categories.size && !categories.has(String(source.category).toLowerCase())) return false;
    if (tags.length) {
      const sourceTags = (source.tags || []).map((tag) => String(tag).toLowerCase());
      if (!tags.some((tag) => sourceTags.includes(tag))) return false;
    }
    return true;
  });
}

function scoreSources(query, sources) {
  const terms = tokenize(query);
  return sources
    .map((source) => {
      const haystack = [
        source.id,
        source.title,
        source.url,
        source.category,
        ...(source.tags || []),
        ...(source.requiredFields || []),
        source.implementationNotes,
      ].join(' ').toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      const tagHits = (source.tags || []).filter((tag) => terms.includes(String(tag).toLowerCase())).length;
      const score = matchedTerms.length + tagHits * 1.5 + (source.relevanceScore || 0) / 100;
      return { source, score, matchedTerms };
    })
    .sort((a, b) => b.score - a.score || (b.source.credibilityScore || 0) - (a.source.credibilityScore || 0));
}

function selectMatchingStrings(items, query, limit) {
  const terms = tokenize(query);
  const scored = items.map((item) => {
    const normalized = item.toLowerCase();
    const score = terms.filter((term) => normalized.includes(term)).length;
    return { item, score };
  });
  return scored
    .filter((entry) => entry.score > 0 || !terms.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

function categorySummary() {
  const counts = new Map();
  for (const source of SPEC_DATA_SOURCE_CATALOG) {
    counts.set(source.category, (counts.get(source.category) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([category, count]) => ({ category, count }));
}

function evidenceMode(source) {
  const tags = (source.tags || []).map((tag) => String(tag).toLowerCase());
  if (tags.includes('issuer-paid') || tags.includes('company-provided')) return 'issuer-paid-verify-before-scoring';
  if (tags.includes('undocumented')) return 'discovery-only-verify-with-primary-sources';
  if (tags.includes('finra') || tags.includes('fixed-income') || tags.includes('corporate-bonds') || tags.includes('agency-bonds') || tags.includes('yield-spread') || tags.includes('distressed-trading') || tags.includes('refinancing-pressure') || tags.includes('equity-credit-divergence')) return 'official-fixed-income-credit-market-risk';
  if (tags.includes('13f') || tags.includes('13f-hr') || tags.includes('13d') || tags.includes('13g') || tags.includes('institutional-holdings') || tags.includes('hedge-funds') || tags.includes('beneficial-ownership') || tags.includes('activist-stake') || tags.includes('passive-owner') || tags.includes('concentrated-ownership')) return 'official-sec-ownership-filing-signal';
  if (tags.includes('sipri') || tags.includes('military-expenditure') || tags.includes('arms-transfers') || tags.includes('trend-indicator-value') || tags.includes('tiv') || tags.includes('arms-industry') || tags.includes('arms-company-revenue') || tags.includes('arms-embargoes') || tags.includes('peace-operations') || tags.includes('nuclear-forces')) return 'sipri-defense-geopolitics-measure-specific';
  if (tags.includes('usaspending') || tags.includes('federal-awards') || tags.includes('government-contracts') || tags.includes('government-demand') || tags.includes('department-of-defense') || tags.includes('dod-contracts') || tags.includes('defense-contracts') || tags.includes('daily-contract-announcements') || tags.includes('contract-announcements') || tags.includes('contracting-activity') || tags.includes('place-of-performance') || tags.includes('product-service-code')) return 'official-federal-awards-contracts-signal';
  if (tags.includes('amazon') || tags.includes('walmart') || tags.includes('best-sellers') || tags.includes('movers-and-shakers') || tags.includes('walmart-best-sellers') || tags.includes('walmart-trending') || tags.includes('bestseller-rank') || tags.includes('sales-rank-acceleration') || tags.includes('bought-since-yesterday') || tags.includes('retail-product-rank') || tags.includes('storefront-rank')) return 'scraped-retail-product-rank-signal';
  if (tags.includes('consumer-goods') || tags.includes('household-personal-products') || tags.includes('companiesmarketcap') || tags.includes('stockanalysis') || tags.includes('fortune-500') || tags.includes('industry-ranking') || tags.includes('revenue-ranking')) return 'scraped-consumer-goods-industry-discovery';
  if (tags.includes('finviz') || tags.includes('tradingview') || tags.includes('yahoo-finance') || tags.includes('nasdaq') || tags.includes('marketbeat') || tags.includes('wallstreetzen') || tags.includes('stock-screener') || tags.includes('top-gainers') || tags.includes('unusual-volume') || tags.includes('insider-buys') || tags.includes('pre-market') || tags.includes('all-time-highs') || tags.includes('sector-leadership') || tags.includes('relative-strength') || tags.includes('market-movers') || tags.includes('analyst-ratings') || tags.includes('analyst-research') || tags.includes('analyst-recommendations') || tags.includes('broker-actions') || tags.includes('analyst-upgrades') || tags.includes('analyst-downgrades') || tags.includes('price-target-changes') || tags.includes('consensus-forecast') || tags.includes('zen-ratings') || tags.includes('quant-ratings') || tags.includes('component-grades') || tags.includes('factor-ratings') || tags.includes('institutional-holdings') || tags.includes('insider-activity') || tags.includes('earnings-calendar') || tags.includes('ipo-calendar') || tags.includes('most-active') || tags.includes('trending')) return 'scraped-market-screener-verify-before-trading';
  if (tags.includes('nhtsa') || tags.includes('recalls-by-vehicle') || tags.includes('campaign-number')) return 'official-vehicle-recall-risk';
  if (tags.includes('fsis') || tags.includes('pounds-recalled') || tags.includes('egg-products')) return 'official-meat-poultry-egg-recall-risk';
  if (tags.includes('food-enforcement') || tags.includes('food-recall')) return 'official-food-recall-enforcement-risk';
  if (tags.includes('cpsc') || tags.includes('consumer-product-safety')) return 'official-consumer-product-recall-risk';
  if (tags.includes('eia') || tags.includes('fuel-prices') || tags.includes('gasoline-prices') || tags.includes('diesel-prices') || tags.includes('petroleum-product-supplied')) return 'official-energy-fuel-price-volume-series';
  if (tags.includes('vehicle-sales') || tags.includes('total-vehicle-sales') || tags.includes('light-vehicle-sales') || tags.includes('domestic-auto-sales') || tags.includes('motor-vehicle-output')) return 'official-vehicle-sales-aggregate-series';
  if (tags.includes('nws') || tags.includes('weather-alerts') || tags.includes('active-alerts') || tags.includes('tornado-warning') || tags.includes('flood-warning')) return 'official-nws-weather-alert-risk';
  if (tags.includes('nrc') || tags.includes('nuclear-regulatory-commission') || tags.includes('reactor-status') || tags.includes('power-reactor-status') || tags.includes('event-notifications')) return 'official-nuclear-facility-event-status-series';
  if (tags.includes('nifc') || tags.includes('wfigs') || tags.includes('wildfire-perimeters') || tags.includes('preparedness-level') || tags.includes('acres-burned')) return 'official-wildfire-incident-perimeter-preparedness-series';
  if (tags.includes('usdm') || tags.includes('drought-monitor') || tags.includes('dsci') || tags.includes('drought-classification')) return 'official-weekly-drought-classification-series';
  if (tags.includes('usgs') || tags.includes('earthquake-catalog') || tags.includes('fdsn') || tags.includes('seismic-risk') || tags.includes('shakemap')) return 'official-earthquake-catalog-seismic-risk-series';
  if (tags.includes('emdat') || tags.includes('historical-disasters') || tags.includes('economic-losses')) return 'historical-disaster-impact-loss-series';
  if (tags.includes('unhcr') || tags.includes('refugee-statistics') || tags.includes('refugee-data-finder') || tags.includes('asylum-seekers') || tags.includes('internally-displaced') || tags.includes('stateless')) return 'official-forced-displacement-population-series';
  if (tags.includes('reliefweb') || tags.includes('humanitarian-reports') || tags.includes('aid-requirements')) return 'curated-humanitarian-disaster-report-series';
  if (tags.includes('eonet') || tags.includes('natural-events') || tags.includes('satellite-imagery')) return 'official-natural-event-satellite-metadata-series';
  if (tags.includes('gdacs') || tags.includes('global-disaster-alerts') || tags.includes('population-exposure') || tags.includes('georss')) return 'official-global-disaster-alert-series';
  if (tags.includes('mymarketnews') || tags.includes('agricultural-market-news') || tags.includes('commodity-prices')) return 'official-agricultural-market-price-volume-series';
  if (tags.includes('food-price-outlook') || tags.includes('f-map') || tags.includes('food-expenditures') || tags.includes('farm-to-retail-price-spreads')) return 'official-food-price-expenditure-series';
  if (tags.includes('weekly-retail-food-sales') || tags.includes('food-category-sales')) return 'official-food-retail-scanner-demand-series';
  if (tags.includes('ppi') || tags.includes('producer-price-index') || tags.includes('producer-prices')) return 'official-producer-price-inflation-series';
  if (tags.includes('cpi') || tags.includes('average-price-data') || tags.includes('consumer-price-index')) return 'official-consumer-price-inflation-series';
  if (tags.includes('m3') || tags.includes('advm3') || tags.includes('manufacturers-shipments')) return 'official-manufacturing-demand-supply-series';
  if (tags.includes('mrts') || tags.includes('marts') || tags.includes('mtis') || tags.includes('arts') || tags.includes('aies') || tags.includes('monthly-retail-trade') || tags.includes('manufacturing-trade-inventories-sales') || tags.includes('annual-retail-trade-survey')) return 'official-retail-demand-category-series';
  if (tags.includes('completed-sales') || tags.includes('redfin')) return 'completed-sales-local-market';
  if (tags.includes('listing-market') || tags.includes('realtor-com')) return 'listing-market-not-completed-sales';
  if (tags.includes('fred') || tags.includes('census') || tags.includes('sec') || tags.includes('official')) return 'official-primary-or-official-derivative';
  if (tags.includes('gdelt') || tags.includes('news')) return 'text-evidence-citation-required';
  return 'research-source-citation-required';
}

function bmclUse(source) {
  const mode = evidenceMode(source);
  if (mode === 'issuer-paid-verify-before-scoring') {
    return 'Share as discovery lead; ask other agents to corroborate against SEC, GDELT, Google News, USAspending, state registries, or independent reporting.';
  }
  if (mode === 'official-primary-or-official-derivative') {
    return 'Share compact fields and observation/release dates for point-in-time reasoning; avoid sending full archives through BMCL.';
  }
  if (mode === 'listing-market-not-completed-sales') {
    return 'Share as current listing-market context; cross-check against completed-sale, construction, and company-geography evidence before scoring.';
  }
  if (mode === 'completed-sales-local-market') {
    return 'Share as local completed-sales and transaction-market evidence; compare with Census/FRED macro series and Realtor.com listing-market data before scoring.';
  }
  if (mode === 'official-consumer-product-recall-risk') {
    return 'Share as official consumer-product recall risk evidence; compare hazards, injuries, remedies, affected units, and repeat recalls before scoring manufacturers or retailers.';
  }
  if (mode === 'official-food-recall-enforcement-risk') {
    return 'Share as official FDA food recall enforcement evidence; compare classification, reason, distribution pattern, product quantity, and recalling firm exposure before scoring food, grocery, CPG, restaurant, logistics, or ingredient suppliers.';
  }
  if (mode === 'official-meat-poultry-egg-recall-risk') {
    return 'Share as official USDA FSIS meat, poultry, and egg recall evidence; compare establishment numbers, pounds recalled, classification, health risk, geography, and retail distribution before scoring producers, processors, grocers, restaurants, or distributors.';
  }
  if (mode === 'official-vehicle-recall-risk') {
    return 'Share as official NHTSA vehicle and automotive-equipment recall evidence; compare campaign counts, affected vehicles, components, defect summaries, crash/fire consequences, remedies, completion reports, and brand-quality trends before scoring automakers, suppliers, dealers, fleets, rental firms, insurers, or logistics operators.';
  }
  if (mode === 'official-consumer-price-inflation-series') {
    return 'Share as official consumer price and selected-product average-dollar-price evidence; compare category CPI indexes, actual dollar prices, energy/food sensitivity, footnotes, and API key/limit context before scoring margin pressure, affordability, pricing power, or demand risk. Do not treat CPI as unit-sales volume.';
  }
  if (mode === 'official-producer-price-inflation-series') {
    return 'Share as official producer selling-price evidence; compare final demand, intermediate demand, input costs, wholesale trends, industry margins, price pass-through, seasonality, footnotes, and API key/limit context before scoring manufacturers, distributors, suppliers, or pricing power. Use CPI for consumer-paid prices and PPI for producer-received prices.';
  }
  if (mode === 'official-energy-fuel-price-volume-series') {
    return 'Share as official EIA fuel and energy price/volume evidence; compare gasoline and diesel prices, petroleum product supplied, retail/supplier fuel volumes, refinery output, inventories/stocks, electricity sales/prices, natural-gas sales/prices, geography, frequency, units, and release dates before scoring logistics, airlines, trucking, utilities, refiners, chemicals, retailers, restaurants, EVs, or consumer fuel-pressure exposure. Use the eia provider key for API pulls when configured; otherwise cite public EIA pages, XLS/CSV downloads, or bulk files.';
  }
  if (mode === 'official-vehicle-sales-aggregate-series') {
    return 'Share as official BEA/FRED aggregate vehicle-sales evidence; compare total, light-vehicle, and domestic-auto sales momentum, YoY changes, SAAR units, revision assumptions, and BEA/FRED source lineage before scoring automakers, suppliers, dealers, fleet/rental firms, auto finance, insurers, logistics, energy, or consumer-discretionary exposure. Do not treat it as manufacturer/model registration data.';
  }
  if (mode === 'official-fixed-income-credit-market-risk') {
    return 'Share as official FINRA fixed-income and corporate/agency bond credit-market risk evidence; compare yield spreads, bond prices, distressed trading volume, downgrade/watch language, refinancing pressure, and equity-credit divergence before scoring leveraged, capital-intensive, financial, utility, telecom, real estate, auto, airline, energy, or industrial issuers. Verify issuer-to-ticker mapping before applying to equity candidates.';
  }
  if (mode === 'official-sec-ownership-filing-signal') {
    return 'Share as official SEC 13F/13D/13G filing-discovery evidence; compare institutional accumulation/reduction, activist/control stakes, passive large beneficial ownership, ownership concentration, filer quality, accession dates, and reporting lag before scoring. Verify filing documents and issuer-to-ticker mapping; 13F holdings are delayed and do not reveal real-time positions.';
  }
  if (mode === 'official-federal-awards-contracts-signal') {
    return 'Share as official federal awards/contracts evidence. For USAspending, compare recipient/parent-company mapping, agency/funding office, award amount, place of performance, PSC/NAICS, award dates, and description. For DoD/War.gov daily announcements, compare contractor, location, award value, contract type, product/service, funding source, expected completion date, and contracting activity. Daily announcements are threshold-limited, so pair them with USAspending for broader coverage. Label war/conflict links as inferred unless corroborated by contract documents, contracting command, appropriation, task order, budget records, or independent reporting.';
  }
  if (mode === 'sipri-defense-geopolitics-measure-specific') {
    return 'Share as SIPRI measure-specific defense and geopolitical context. Keep military expenditure, arms-transfer TIV, arms-company revenue, financial arms-trade value, embargoes, peace operations, nuclear forces, and contract award values separate. TIV is transfer volume, not financial price, and should not be compared directly with GDP, military expenditure, company sales, or government contract awards. Use USAspending or DoD/War.gov for contract award values.';
  }
  if (mode === 'scraped-market-screener-verify-before-trading') {
    return 'Share as scraped/delayed market-screener and public market-research discovery evidence. Use compact ticker, signal, screen, price/change/volume, earnings/IPO, analyst-research, broker-action, upgrade/downgrade, price-target-change, consensus-forecast, Zen Rating/component-grade, institutional-holdings, and insider-activity rows for candidate generation, self-improvement, and council debate; corroborate against original broker notes where available, broker quotes, Finnhub, SEC filings, Nasdaq Trader/security-master data, GDELT/Google News, and official data before live scoring or orders.';
  }
  if (mode === 'scraped-consumer-goods-industry-discovery') {
    return 'Share as scraped consumer-goods and household/personal-products industry discovery evidence. Use compact ticker, company, rank, revenue, market-cap, profit, valuation, and dividend rows to identify CPG, home-care, personal-care, consumer-defensive, and large revenue-ranked companies for deeper research; corroborate against SEC filings, company reports, broker/Finnhub quotes, BLS/Census/Amazon/Walmart demand proxies, and independent news before scoring or trading.';
  }
  if (mode === 'scraped-retail-product-rank-signal') {
    return 'Share as scraped Amazon/Walmart storefront rank, trending, acceleration, availability, and low-stock discovery evidence. Use compact product/category/rank snippets to identify consumer-demand themes and possible brand/product leads, then corroborate with official retail series, scanner summaries, company filings, independent reporting, broker/Finnhub data, and verified brand-to-company mappings before scoring.';
  }
  if (mode === 'official-nws-weather-alert-risk') {
    return 'Share as official NWS active weather alert evidence; compare event, severity, urgency, certainty, area description, geometry, affected zones, expiration/onset, and company facility/customer/logistics overlap before scoring utilities, insurers, logistics, travel, retail, agriculture, energy, construction, or recovery-spend exposure. Send an identifying User-Agent on API calls.';
  }
  if (mode === 'official-nuclear-facility-event-status-series') {
    return 'Share as official NRC nuclear event/status evidence; compare event notification type, CFR basis, emergency class, scram/shutdown/derate, current power, plant/operator/vendor exposure before scoring utilities, uranium, nuclear services, grid, industrial suppliers, insurers, or regional power prices.';
  }
  if (mode === 'official-wildfire-incident-perimeter-preparedness-series') {
    return 'Share as official NIFC/WFIGS U.S. wildfire incident, perimeter, acres-burned, containment, and preparedness-level evidence; compare incident geometry, status, containment, acres, state/county, preparedness level, and company facility/customer/supply-chain overlap before scoring utilities, insurers, timber/agriculture, logistics, travel, retail, construction, infrastructure, or recovery-spend exposure.';
  }
  if (mode === 'official-weekly-drought-classification-series') {
    return 'Share as official U.S. Drought Monitor weekly drought-classification and DSCI evidence; compare D0-D4, DSCI, AOI, geography, release/valid dates, and company facility/customer/supply-chain overlap before scoring agriculture, food producers, grocers/restaurants, water utilities, wildfire amplification, livestock, logistics, or irrigation/water-infrastructure demand.';
  }
  if (mode === 'official-earthquake-catalog-seismic-risk-series') {
    return 'Share as official USGS earthquake catalog and real-time GeoJSON feed evidence; compare magnitude, depth, PAGER alert, felt/CDI/MMI intensity, significance, tsunami flag, location geometry, and company facility/customer/supply-chain overlap before scoring utilities, insurers, logistics, ports, semiconductors, energy, real estate, construction, infrastructure, or recovery-spend exposure.';
  }
  if (mode === 'historical-disaster-impact-loss-series') {
    return 'Share as EM-DAT/CRED historical disaster impact, human-impact, and economic-loss evidence for long-run location exposure and backtesting. Do not treat it as a live alert feed; respect registration, non-commercial, and usage-term constraints for detailed downloads.';
  }
  if (mode === 'official-forced-displacement-population-series') {
    return 'Share as official UNHCR annual refugee/asylum/IDP/stateless population evidence; compare latest year, origin/host country trends, demographics/solutions endpoints, and company country exposure before scoring defense/security, healthcare, shelter, food, logistics, insurers, banks, or border-policy risk.';
  }
  if (mode === 'official-global-disaster-alert-series') {
    return 'Share as official GDACS near-real-time global disaster alert evidence; compare event type, alert level, alert score, severity, estimated population exposure, ISO3/country, GeoRSS geometry, CAP/report URL, and company location/customer/supply-chain overlap before scoring utilities, insurers, logistics, travel, retail, energy, infrastructure, construction, or recovery-spend exposure.';
  }
  if (mode === 'official-natural-event-satellite-metadata-series') {
    return 'Share as official NASA EONET natural-event and satellite-imagery metadata evidence; compare category, open/closed status, latest geometry, magnitude, source URLs, and company facility/customer/supply-chain overlap before scoring utilities, insurers, logistics, aviation, agriculture, food, energy, infrastructure, construction, retail, or recovery-spend exposure.';
  }
  if (mode === 'curated-humanitarian-disaster-report-series') {
    return 'Share as ReliefWeb curated humanitarian disaster/report evidence; compare country/region, disaster type, source organization, report theme, casualty/displacement/aid signals, conflict context, dates, and company facility/customer/supply-chain overlap before scoring logistics, insurers, defense, healthcare, food, utilities, infrastructure, construction, or recovery-spend exposure. Requires a configured approved ReliefWeb appName for API pulls.';
  }
  if (mode === 'official-food-retail-scanner-demand-series') {
    return 'Share as official USDA ERS public retail-food scanner-demand evidence; compare dollars, unit sales, shares, year-over-year changes, category/subcategory trends, geography limits, revision notes, and pandemic/recession/seasonal context before scoring grocers, food brands, CPG, restaurants, logistics, or agriculture exposure. Do not treat public files as UPC-level access, and do not use removed volume-sales fields.';
  }
  if (mode === 'official-agricultural-market-price-volume-series') {
    return 'Share as official USDA AMS agricultural market price and volume evidence; compare commodity, grade, unit, market location, wholesale/retail/shipping context, movement, report date, and corrections before scoring food producers, processors, grocers, restaurants, distributors, agriculture, logistics, or consumer-staples margin pressure. Use the usda-ams provider key for API-scale MyMarketNews pulls when configured; otherwise cite public report pages.';
  }
  if (mode === 'official-food-price-expenditure-series') {
    return 'Share as official USDA ERS food price, expenditure, CPI/PPI forecast, food-at-home regional price, and farm-to-retail spread evidence; preserve release dates, methodology/revision notes, geography, food category, coverage years, and forecast-history comparability before scoring affordability, input-cost, demand, or margin effects.';
  }
  if (mode === 'official-retail-demand-category-series') {
    return 'Share as official Census category-level retail, advance retail, combined trade inventory/sales, and annual retail-structure evidence; compare sales, inventory, inventory-to-sales, MTIS wholesale/manufacturing context, seasonality, ARTS/AIES annual structure, and advance-vs-final revisions before scoring retailers, CPG, ecommerce, autos, home improvement, apparel, gasoline, restaurants, logistics, and discretionary exposure. Never treat it as UPC, store-level, or company-specific sales.';
  }
  if (mode === 'official-manufacturing-demand-supply-series') {
    return 'Share as official upstream manufacturing activity evidence; compare shipments, new orders, unfilled orders, inventories, sector/category codes, seasonality, and advance-vs-full revisions before scoring industrials, technology hardware, machinery, transportation equipment, appliances, components, logistics, or materials exposure.';
  }
  return 'Share URL, title, tags, and cited excerpts; persist high-value follow-up URLs through source.hint.persist.';
}

function summarizeFilters(body = {}) {
  return {
    ids: normalizeStringArray(body.ids),
    categories: normalizeStringArray(body.categories || body.category),
    tags: normalizeStringArray(body.tags || body.tag),
    limit: normalizeLimit(body.limit),
  };
}

function normalizeLimit(value) {
  const parsed = Number(value || DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
}

function tokenize(query) {
  return cleanText(query)
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .filter((term) => term.length > 1)
    .slice(0, 24);
}

function normalizeStringArray(value) {
  const values = Array.isArray(value) ? value : [value].filter(Boolean);
  return values.map(cleanText).filter(Boolean);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

module.exports = {
  SOURCE_PACKS,
  listCatalog,
  searchCatalog,
  getSourcePack,
  shareCatalog,
};
