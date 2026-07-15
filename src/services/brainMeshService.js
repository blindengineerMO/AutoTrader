const { EventEmitter } = require('events');
const crypto = require('crypto');
const brainMeshRepo = require('../db/repositories/brainMeshRepo');
const researchSourceRepo = require('../db/repositories/researchSourceRepo');
const companyDiscovery = require('./companyDiscoveryService');
const chatResearch = require('./chatResearchService');
const investorPlaybook = require('./investorPlaybookService');
const ollamaBrain = require('./ollamaBrainMeshService');
const sourceCatalogBrain = require('./brainMeshSourceCatalogService');
const crawleeCrawler = require('./crawleeResearchCrawlerService');
const eiaEnergy = require('./eiaEnergyService');
const vehicleSales = require('./vehicleSalesService');
const blsPricing = require('./blsPricingService');
const censusRetailTrade = require('./censusRetailTradeService');
const amazonBestsellers = require('./amazonBestsellerService');
const walmartRetailDemand = require('./walmartRetailDemandService');
const consumerGoodsIndustry = require('./consumerGoodsIndustryService');
const alpacaAssetClient = require('./marketData/alpacaAssetClient');
const alpacaRules = require('./alpacaRulesService');
const settingsRepo = require('../db/repositories/settingsRepo');
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
const sipriMilitaryData = require('./sipriMilitaryDataService');
const analystDecisionGate = require('./analystDecisionGateService');
const gdacsDisasters = require('./gdacsDisasterService');
const eonetNaturalEvents = require('./eonetNaturalEventService');
const reliefWebHumanitarian = require('./reliefWebHumanitarianService');
const emdatHistoricalDisasters = require('./emdatHistoricalDisasterService');
const usgsEarthquakes = require('./usgsEarthquakeService');
const nwsWeatherAlerts = require('./nwsWeatherAlertService');
const nifcWildfires = require('./nifcWildfireService');
const usDroughtMonitor = require('./usDroughtMonitorService');
const unhcrRefugees = require('./unhcrRefugeeStatisticsService');
const nrcNuclearEvents = require('./nrcNuclearEventService');
const logger = require('../utils/logger');
const { normalizeLimitedStrings, isPublicHttpUrl, clampNumber } = require('../shared/crawlGuard');

const PROTOCOL = 'BMCL/1.0';
const SUPPORTED_PROTOCOLS = ['BMCL/1.0', 'BMCL/2.0'];
const DEFAULT_TTL = 16;
const bus = new EventEmitter();
bus.setMaxListeners(200);

const agents = new Map();
const handlers = new Map();
const remoteHandlers = new Map();

// Federated compute nodes may only ever serve research/compute ops. This is
// checked at both handler-registration time (registerRemoteHandler) and
// dispatch time (ask/dispatchFireAndForget) so a node lying about its
// capabilities in `hello` can never get an order-placement op wired in.
const NEVER_REMOTE_OPS = [/^order\./, /^trading\./, /^broker\./, /^rules\./, /^kill-switch\./];

function isRemoteDispatchAllowed(op) {
  const value = String(op || '');
  return !NEVER_REMOTE_OPS.some((pattern) => pattern.test(value));
}

function registerRemoteHandler(nodeId, op, dispatchFn) {
  if (!isRemoteDispatchAllowed(op)) {
    logger.warn('BMCL rejected remote handler registration for disallowed op', { nodeId, op });
    return false;
  }
  remoteHandlers.set(`${nodeId}:${op}`, dispatchFn);
  return true;
}

// Federated nodes exist to actually offload compute, so a connected node is
// preferred over the local in-process handler for the same op; the local
// handler is kept purely as a fallback for when no node is currently online.
async function resolveAndInvoke(target, op, request) {
  const local = handlers.get(`${target}:${op}`) || handlers.get(`${target}:*`);
  const remote = isRemoteDispatchAllowed(op) && remoteHandlers.get(`${target}:${op}`);
  if (remote) {
    try {
      return await remote(request);
    } catch (err) {
      if (err.code !== 'BMCL_NO_REMOTE_NODE' || !local) throw err;
    }
  }
  if (!local) throw new Error(`No handler registered for ${target}:${op}`);
  return local(request);
}

let bootstrapped = false;

function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  registerDefaultAgents();
}

function registerAgent(agent) {
  const normalized = {
    id: agent.id,
    userId: agent.userId || null,
    role: agent.role || 'brain',
    capabilities: agent.capabilities || [],
    status: agent.status || 'online',
    metadata: agent.metadata || {},
  };
  if (!normalized.id) throw new Error('BrainMesh agent id is required');
  agents.set(normalized.id, normalized);
  brainMeshRepo.upsertAgent(normalized);
  return normalized;
}

function removeAgent(agentId, userId = null) {
  bootstrap();
  const existing = agents.get(agentId);
  if (existing && existing.userId === userId) {
    agents.set(agentId, { ...existing, status: 'removed' });
  }
  brainMeshRepo.removeAgent(agentId, userId);
  return { ok: true, id: agentId, status: 'removed' };
}

function linkAgentToBoard({ userId, agentId, boardId, role = 'member', metadata = {} }) {
  bootstrap();
  if (!agentId || !boardId) throw new Error('agentId and boardId are required');
  const link = brainMeshRepo.linkAgentToBoard({ userId, agentId, boardId, role, metadata });
  tell({
    from: 'brain.mesh.registry',
    to: agentId,
    kind: 'event',
    op: 'mesh.agent.linked',
    ctx: { userId, boardId },
    body: { agentId, boardId, role, metadata },
  });
  return link;
}

function unlinkAgentFromBoard({ userId, agentId, boardId }) {
  bootstrap();
  if (!agentId || !boardId) throw new Error('agentId and boardId are required');
  const result = brainMeshRepo.unlinkAgentFromBoard({ userId, agentId, boardId });
  tell({
    from: 'brain.mesh.registry',
    to: agentId,
    kind: 'event',
    op: 'mesh.agent.unlinked',
    ctx: { userId, boardId },
    body: { agentId, boardId },
  });
  return result;
}

function registerHandler(agentId, op, handler) {
  registerAgent(agents.get(agentId) || { id: agentId, role: 'brain', capabilities: [op] });
  handlers.set(`${agentId}:${op}`, handler);
}

function startConversation({ userId, topic, metadata = {} } = {}) {
  const conversation = {
    id: id('bc'),
    userId: userId || null,
    topic: topic || 'brain-mesh',
    status: 'open',
    metadata: { ...metadata, trace: metadata.trace || id('bt') },
  };
  brainMeshRepo.upsertConversation(conversation);
  return conversation;
}

function frame({ from, to, kind = 'tell', op, body = {}, ctx = {}, conv, trace, cause, ttl = DEFAULT_TTL, qos = {} }) {
  const now = new Date().toISOString();
  return {
    proto: PROTOCOL,
    id: id('bm'),
    ts: now,
    trace: trace || id('bt'),
    conv: conv || id('bc'),
    cause: cause || null,
    hop: 0,
    ttl,
    from,
    to: Array.isArray(to) ? to : [to],
    kind,
    op,
    qos: {
      ack: Boolean(qos.ack),
      durable: qos.durable !== false,
      priority: qos.priority || 'normal',
    },
    ctx,
    body,
  };
}

function tell(input) {
  bootstrap();
  const envelope = normalizeEnvelope(input);
  validateEnvelope(envelope);
  logMeshChat(envelope, 'started');
  brainMeshRepo.upsertConversation({
    id: envelope.conv,
    userId: envelope.ctx?.userId || null,
    topic: envelope.op,
    status: 'open',
    metadata: { trace: envelope.trace },
  });
  brainMeshRepo.recordMessage(envelope, 'accepted');
  emitEnvelope(envelope);
  const dispatched = dispatchFireAndForget(envelope);
  if (envelope.kind !== 'ask' && !dispatched) logMeshChat(envelope, 'stopped', { handlers: 0 });
  if (isCompletionEnvelope(envelope)) completeConversation(envelope.conv, envelope.ctx?.userId, {
    trace: envelope.trace,
    completedBy: envelope.from,
    completedOp: envelope.op,
    completedAt: envelope.ts,
  });
  return envelope;
}

async function ask(input, { timeoutMs = 8000 } = {}) {
  bootstrap();
  const request = tell({ ...input, kind: 'ask', qos: { ...(input.qos || {}), ack: true } });
  const replies = [];
  const targets = request.to;

  await Promise.allSettled(targets.map(async (target) => {
    try {
      const body = await withTimeout(resolveAndInvoke(target, request.op, request), timeoutMs);
      replies.push(reply(request, target, body));
    } catch (err) {
      replies.push(errorReply(request, target, err.message));
    }
  }));

  const result = {
    request,
    replies,
    ok: replies.every((item) => item.kind === 'reply'),
  };
  logMeshChat(request, 'stopped', { replies: replies.length, ok: result.ok });
  return result;
}

function reply(request, from, body) {
  return tell({
    from,
    to: request.from,
    kind: 'reply',
    op: `${request.op}.reply`,
    body,
    ctx: request.ctx,
    conv: request.conv,
    trace: request.trace,
    cause: request.id,
    ttl: Math.max(1, request.ttl - 1),
  });
}

function errorReply(request, from, message) {
  return tell({
    from,
    to: request.from,
    kind: 'error',
    op: `${request.op}.error`,
    body: { error: message },
    ctx: request.ctx,
    conv: request.conv,
    trace: request.trace,
    cause: request.id,
    ttl: Math.max(1, request.ttl - 1),
  });
}

function subscribe(listener, filter = {}) {
  bootstrap();
  const wrapped = (envelope) => {
    if (filter.userId && envelope.ctx?.userId !== filter.userId) return;
    if (filter.conversationId && envelope.conv !== filter.conversationId) return;
    if (filter.traceId && envelope.trace !== filter.traceId) return;
    listener(envelope);
  };
  bus.on('envelope', wrapped);
  return () => bus.off('envelope', wrapped);
}

function listAgents(userId) {
  bootstrap();
  return brainMeshRepo.listAgents(userId);
}

function listConversations(userId, limit) {
  bootstrap();
  return brainMeshRepo.listConversations(userId, limit);
}

function listCompletedConversationSummaries(userId, limit = 50) {
  bootstrap();
  const conversations = brainMeshRepo.listCompletedConversations(userId, limit);
  return conversations.map((conversation) => summarizeConversation(conversation, {
    userId,
    messages: brainMeshRepo.listMessages({ userId, conversationId: conversation.id, limit: 80 }),
  }));
}

function completeConversation(conversationId, userId, metadata = {}) {
  if (!conversationId) return false;
  const current = brainMeshRepo.listConversations(userId, 500).find((item) => item.id === conversationId);
  brainMeshRepo.completeConversation({
    id: conversationId,
    userId,
    metadata: {
      ...(current?.metadata || {}),
      ...metadata,
    },
  });
  return true;
}

function listMessages(params) {
  bootstrap();
  return brainMeshRepo.listMessages(params);
}

function listAgentLinks(params) {
  bootstrap();
  return brainMeshRepo.listAgentLinks(params);
}

function dispatchFireAndForget(envelope) {
  if (!['tell', 'event'].includes(envelope.kind)) return;
  let dispatched = 0;
  for (const target of envelope.to) {
    const hasLocal = handlers.has(`${target}:${envelope.op}`) || handlers.has(`${target}:*`);
    const hasRemote = isRemoteDispatchAllowed(envelope.op) && remoteHandlers.has(`${target}:${envelope.op}`);
    if (!hasLocal && !hasRemote) continue;
    dispatched += 1;
    resolveAndInvoke(target, envelope.op, envelope).catch((err) => {
      errorReply(envelope, target, err.message);
    }).finally(() => logMeshChat(envelope, 'stopped', { target }));
  }
  return dispatched;
}

function normalizeEnvelope(input) {
  return input.proto === PROTOCOL ? input : frame(input);
}

function validateEnvelope(envelope) {
  const required = ['proto', 'id', 'ts', 'trace', 'conv', 'from', 'to', 'kind', 'op', 'ctx', 'body'];
  for (const key of required) {
    if (envelope[key] === undefined || envelope[key] === null) throw new Error(`BrainMesh envelope missing ${key}`);
  }
  if (!SUPPORTED_PROTOCOLS.includes(envelope.proto)) throw new Error(`Unsupported BrainMesh protocol ${envelope.proto}`);
  if (!Array.isArray(envelope.to) || !envelope.to.length) throw new Error('BrainMesh envelope requires at least one recipient');
  if (!['tell', 'ask', 'reply', 'event', 'error'].includes(envelope.kind)) throw new Error(`Unsupported BrainMesh kind ${envelope.kind}`);
  if (envelope.ttl <= 0) throw new Error('BrainMesh envelope TTL expired');
}

function emitEnvelope(envelope) {
  bus.emit('envelope', envelope);
  bus.emit(`conversation:${envelope.conv}`, envelope);
  bus.emit(`trace:${envelope.trace}`, envelope);
}

function logMeshChat(envelope, state, extra = {}) {
  if (!isBrainOrAgentChat(envelope)) return;
  logger.info(`BMCL chat ${state}`, {
    frameId: envelope.id,
    kind: envelope.kind,
    op: envelope.op,
    from: envelope.from,
    to: envelope.to,
    trace: envelope.trace,
    conversation: envelope.conv,
    ...extra,
  });
}

function isBrainOrAgentChat(envelope) {
  const ids = [envelope.from, ...(Array.isArray(envelope.to) ? envelope.to : [envelope.to])].filter(Boolean);
  const hasBrainOrAgent = ids.some((id) => /^(brain|agent)\./.test(String(id)));
  const hasTwoInternalParties = ids.filter((id) => /^(brain|agent)\./.test(String(id))).length >= 2;
  return hasBrainOrAgent && (hasTwoInternalParties || /^(brain|agent)\./.test(String(envelope.from)));
}

function isCompletionEnvelope(envelope) {
  const op = String(envelope.op || '').toLowerCase();
  return envelope.kind === 'event' && (
    /(^|[._-])(complete|completed|ready)$/.test(op)
    || op.endsWith('consensus.ready')
    || op.endsWith('snapshot.persisted')
  );
}

function summarizeConversation(conversation, { userId, messages = [] } = {}) {
  const chronological = [...messages].reverse();
  const participants = new Set();
  const ops = new Set();
  for (const message of chronological) {
    participants.add(message.sender);
    for (const recipient of String(message.recipient || '').split(',')) {
      if (recipient.trim()) participants.add(recipient.trim());
    }
    if (message.op) ops.add(message.op);
  }
  const recent = chronological.slice(-6);
  const last = chronological[chronological.length - 1];
  return {
    id: conversation.id,
    user_id: conversation.user_id ?? userId ?? null,
    topic: conversation.topic,
    status: conversation.status,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    metadata: conversation.metadata || {},
    messageCount: chronological.length,
    participants: [...participants].filter(Boolean).slice(0, 8),
    operations: [...ops].filter(Boolean).slice(-8),
    lastOperation: last?.op || conversation.metadata?.completedOp || conversation.topic,
    summary: buildConversationDigest(conversation, recent),
  };
}

function buildConversationDigest(conversation, messages) {
  const snippets = messages
    .map((message) => {
      const body = message.envelope?.body || {};
      return [
        message.op,
        body.summary,
        body.name,
        body.agentId,
        body.snapshotId ? `snapshot ${body.snapshotId}` : '',
        body.signalCount !== undefined ? `${body.signalCount} signals` : '',
        body.portfolioTargets !== undefined ? `${body.portfolioTargets} portfolio targets` : '',
        body.rejectedTrades !== undefined ? `${body.rejectedTrades} rejected trades` : '',
      ].filter(Boolean).join(' ');
    })
    .filter(Boolean);
  const digest = snippets.join(' | ').replace(/\s+/g, ' ').trim();
  return clipText(digest || `Completed BMCL conversation for ${conversation.topic}.`, 260);
}

function clipText(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function registerDefaultAgents() {
  const definitions = [
    {
      id: 'brain.research.source',
      role: 'research-source-brain',
      capabilities: [
        'mesh.status',
        'source.memory.summary',
        'source.hint.persist',
        'source.catalog.list',
        'source.catalog.search',
        'source.catalog.pack',
        'source.catalog.share',
        'energy.eia.snapshot',
        'vehicle.sales.snapshot',
        'pricing.bls.snapshot',
        'commerce.census.retail.snapshot',
        'commerce.amazon.bestsellers.snapshot',
        'commerce.walmart.retail.snapshot',
        'market.alpaca.symbol.eligibility',
        'market.consumer-goods.industry.snapshot',
        'market.finviz.screener.snapshot',
        'market.tradingview.screener.snapshot',
        'market.yahoo.screener.snapshot',
        'market.nasdaq.research.snapshot',
        'market.marketbeat.analyst.snapshot',
        'market.wallstreetzen.snapshot',
        'market.finra.fixed-income.snapshot',
        'market.sec.ownership.snapshot',
        'government.usaspending.awards.snapshot',
        'government.dod.contracts.snapshot',
        'defense.sipri.snapshot',
        'disaster.gdacs.snapshot',
        'disaster.eonet.snapshot',
        'disaster.reliefweb.snapshot',
        'disaster.emdat.snapshot',
        'disaster.usgs.earthquake.snapshot',
        'weather.nws.alerts.snapshot',
        'nuclear.nrc.events.snapshot',
        'wildfire.nifc.snapshot',
        'drought.usdm.snapshot',
        'humanitarian.unhcr.refugees.snapshot',
        'crawler.search',
        'crawler.crawl',
      ],
      metadata: {
        service: 'researchSourceLearningService',
        catalogService: 'brainMeshSourceCatalogService',
        crawlerService: 'crawleeResearchCrawlerService',
        energyService: 'eiaEnergyService',
        vehicleSalesService: 'vehicleSalesService',
        blsPricingService: 'blsPricingService',
        censusRetailTradeService: 'censusRetailTradeService',
        amazonBestsellerService: 'amazonBestsellerService',
        walmartRetailDemandService: 'walmartRetailDemandService',
        alpacaAssetService: 'alpacaAssetClient',
        consumerGoodsIndustryService: 'consumerGoodsIndustryService',
        finvizScreenerService: 'finvizScreenerService',
        tradingViewScreenerService: 'tradingViewScreenerService',
        yahooFinanceScreenerService: 'yahooFinanceScreenerService',
        nasdaqMarketResearchService: 'nasdaqMarketResearchService',
        marketBeatAnalystService: 'marketBeatAnalystService',
        wallStreetZenService: 'wallStreetZenService',
        finraMarketDataService: 'finraMarketDataService',
        secInstitutionalOwnershipService: 'secInstitutionalOwnershipService',
        usaspendingAwardsService: 'usaspendingAwardsService',
        dodContractsService: 'dodContractsService',
        sipriMilitaryDataService: 'sipriMilitaryDataService',
        disasterService: 'gdacsDisasterService',
        naturalEventService: 'eonetNaturalEventService',
        humanitarianService: 'reliefWebHumanitarianService',
        historicalDisasterService: 'emdatHistoricalDisasterService',
        earthquakeService: 'usgsEarthquakeService',
        weatherAlertService: 'nwsWeatherAlertService',
        nuclearEventService: 'nrcNuclearEventService',
        wildfireService: 'nifcWildfireService',
        droughtService: 'usDroughtMonitorService',
        refugeeStatisticsService: 'unhcrRefugeeStatisticsService',
        catalogPacks: Object.keys(sourceCatalogBrain.SOURCE_PACKS),
        crawlerProviders: ['google', 'google-news', 'bing', 'mojeek', 'dogpile', 'duckduckgo-html-fallback', 'duckduckgo-preflight'],
      },
    },
    {
      id: 'brain.discovery.company',
      role: 'company-discovery-brain',
      capabilities: ['mesh.status', 'candidate.extract'],
      metadata: { service: 'companyDiscoveryService' },
    },
    {
      id: 'brain.research.chat',
      role: 'chat-research-brain',
      capabilities: ['mesh.status', 'chat.hints.normalize'],
      metadata: { service: 'chatResearchService' },
    },
    {
      id: ollamaBrain.OLLAMA_BRAIN_ID,
      role: 'local-llm-brain',
      capabilities: ['mesh.status', 'llm.assist', 'llm.reason', 'llm.research.assist', 'llm.training.suggest', 'llm.analysis.assist'],
      metadata: {
        service: 'ollamaBrainMeshService',
        provider: 'ollama',
        localOnly: true,
        toolCalling: true,
      },
    },
    {
      id: 'brain.intelligence.company',
      role: 'company-intelligence-brain',
      capabilities: ['mesh.status'],
      metadata: { service: 'companyIntelligenceService' },
    },
    {
      id: 'brain.model.neural',
      role: 'neural-scoring-brain',
      capabilities: ['mesh.status'],
      metadata: { service: 'brainModelService' },
    },
    {
      id: 'brain.playbook.investor',
      role: 'investor-playbook-brain',
      capabilities: ['mesh.status', 'playbook.summary'],
      metadata: { service: 'investorPlaybookService' },
    },
    {
      id: 'brain.broker.alpaca.rules',
      role: 'alpaca-rules-teacher-brain',
      capabilities: ['mesh.status', 'alpaca.rules.summary', 'alpaca.rules.evaluate_order'],
      metadata: {
        service: 'alpacaRulesService',
        provider: 'alpaca',
        docUrl: alpacaRules.DOC_URL,
        teaches: ['fractional-orders', 'max-buy-notional', 'asset-fractionable-checks', 'quantity-precision'],
      },
    },
    {
      id: 'brain.reporting',
      role: 'reporting-brain',
      capabilities: ['mesh.status'],
      metadata: { service: 'decisionReportService' },
    },
    {
      id: 'brain.evaluation',
      role: 'evaluation-brain',
      capabilities: ['mesh.status', 'decision.analyst.gate.evaluate'],
      metadata: {
        service: 'evaluationService',
        analystGateService: 'analystDecisionGateService',
      },
    },
    {
      id: 'agent.research.builder',
      role: 'agent-profile-research-brain',
      capabilities: ['mesh.status', 'agent.research.started', 'agent.profile.ready'],
      metadata: { service: 'agentResearchService' },
    },
    {
      id: 'brain.mesh.registry',
      role: 'brain-mesh-registry',
      capabilities: ['mesh.status', 'mesh.agent.linked', 'mesh.agent.unlinked'],
      metadata: { service: 'brainMeshService' },
    },
    {
      id: 'agent.research.top-level',
      role: 'top-level-research-agent',
      capabilities: ['mesh.status', 'watcher.research.reported'],
      metadata: { service: 'autonomousResearchService' },
    },
    {
      id: 'agent.behavior.supervisor',
      role: 'upstream-behavior-agent',
      capabilities: ['mesh.status', 'watcher.grade.issued'],
      metadata: { service: 'watcherBehaviorService' },
    },
  ];
  definitions.forEach(registerAgent);

  for (const agent of definitions) {
    registerHandler(agent.id, 'mesh.status', () => ({
      id: agent.id,
      role: agent.role,
      status: 'online',
      capabilities: agent.capabilities,
      metadata: agent.metadata,
    }));
  }

  registerHandler('brain.discovery.company', 'candidate.extract', (envelope) =>
    companyDiscovery.discoverCompanies({
      news: envelope.body?.news || { items: [] },
      learned: envelope.body?.learned || { observations: [] },
      maxCandidates: envelope.body?.maxCandidates || 18,
    })
  );

  registerHandler('brain.research.chat', 'chat.hints.normalize', (envelope) => ({
    candidateHints: chatResearch.normalizeCandidateHints(envelope.body?.candidateHints || []),
    sourceHints: chatResearch.normalizeSourceHints(envelope.body?.sourceHints || []),
  }));

  registerHandler(ollamaBrain.OLLAMA_BRAIN_ID, 'llm.assist', ollamaBrain.handleMeshAssist);
  registerHandler(ollamaBrain.OLLAMA_BRAIN_ID, 'llm.reason', ollamaBrain.handleMeshReason);
  registerHandler(ollamaBrain.OLLAMA_BRAIN_ID, 'llm.research.assist', ollamaBrain.handleMeshResearch);
  registerHandler(ollamaBrain.OLLAMA_BRAIN_ID, 'llm.training.suggest', ollamaBrain.handleMeshTraining);
  registerHandler(ollamaBrain.OLLAMA_BRAIN_ID, 'llm.analysis.assist', ollamaBrain.handleMeshAnalysis);

  registerHandler('brain.playbook.investor', 'playbook.summary', () => investorPlaybook.getPlaybookSummary());

  registerHandler('brain.broker.alpaca.rules', 'alpaca.rules.summary', (envelope) =>
    alpacaRules.getRulesSummary({ userId: envelope.ctx?.userId })
  );

  registerHandler('brain.broker.alpaca.rules', 'alpaca.rules.evaluate_order', (envelope) =>
    alpacaRules.evaluateOrder({
      userId: envelope.ctx?.userId,
      symbol: envelope.body?.symbol,
      side: envelope.body?.side,
      quantity: envelope.body?.quantity,
      price: envelope.body?.price,
      asset: envelope.body?.asset || null,
    })
  );

  registerHandler('brain.evaluation', 'decision.analyst.gate.evaluate', (envelope) =>
    analystDecisionGate.compactForBmcl(analystDecisionGate.evaluateAnalystDecisionGate(envelope.body || {}))
  );

  registerHandler('brain.research.source', 'source.memory.summary', (envelope) => {
    const userId = envelope.ctx?.userId;
    const sources = userId ? researchSourceRepo.listByUser(userId, 25) : [];
    return {
      total: sources.length,
      active: sources.filter((source) => source.status === 'active').length,
      failed: sources.filter((source) => source.status === 'failed').length,
      top: sources.slice(0, 8).map((source) => ({
        id: source.id,
        url: source.url,
        status: source.status,
        relevanceScore: source.relevance_score,
        credibilityScore: source.credibility_score,
        failureCount: source.failure_count,
      })),
    };
  });

  registerHandler('brain.research.source', 'source.catalog.list', (envelope) =>
    sourceCatalogBrain.listCatalog(envelope.body || {})
  );

  registerHandler('brain.research.source', 'source.catalog.search', (envelope) =>
    sourceCatalogBrain.searchCatalog(envelope.body || {})
  );

  registerHandler('brain.research.source', 'source.catalog.pack', (envelope) =>
    sourceCatalogBrain.getSourcePack(envelope.body || {})
  );

  registerHandler('brain.research.source', 'source.catalog.share', (envelope) =>
    sourceCatalogBrain.shareCatalog(envelope.body || {}, envelope)
  );

  registerHandler('brain.research.source', 'energy.eia.snapshot', async (envelope) =>
    eiaEnergy.compactForBmcl(await eiaEnergy.collectEnergyFuelContext({
      userId: envelope.ctx?.userId,
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
    }))
  );

  registerHandler('brain.research.source', 'vehicle.sales.snapshot', async (envelope) =>
    vehicleSales.compactForBmcl(await vehicleSales.collectVehicleSalesContext({
      userId: envelope.ctx?.userId,
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
    }))
  );

  registerHandler('brain.research.source', 'pricing.bls.snapshot', async (envelope) =>
    blsPricing.compactForBmcl(await blsPricing.collectBlsPricingContext({
      userId: envelope.ctx?.userId,
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 20000),
      startYear: envelope.body?.startYear,
      endYear: envelope.body?.endYear,
      seriesIds: envelope.body?.seriesIds,
    }))
  );

  registerHandler('brain.research.source', 'commerce.census.retail.snapshot', async (envelope) =>
    censusRetailTrade.compactForBmcl(await censusRetailTrade.collectRetailTradeContext({
      userId: envelope.ctx?.userId,
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 20000),
      startTime: envelope.body?.startTime,
      geography: envelope.body?.geography || 'us',
      datasets: envelope.body?.datasets,
      includeData: envelope.body?.includeData !== false,
    }))
  );

  registerHandler('brain.research.source', 'commerce.amazon.bestsellers.snapshot', async (envelope) =>
    amazonBestsellers.compactForBmcl(await amazonBestsellers.collectAmazonBestsellerContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 9000, 1500), 20000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 20, 1), 100),
      sourceIds: envelope.body?.sourceIds || envelope.body?.categories,
      includeMovers: envelope.body?.includeMovers !== false,
    }))
  );

  registerHandler('brain.research.source', 'commerce.walmart.retail.snapshot', async (envelope) =>
    walmartRetailDemand.compactForBmcl(await walmartRetailDemand.collectWalmartRetailDemandContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 9000, 1500), 20000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 24, 1), 100),
      sourceIds: envelope.body?.sourceIds || envelope.body?.categories,
      includeTrending: envelope.body?.includeTrending !== false,
    }))
  );

  registerHandler('brain.research.source', 'market.alpaca.symbol.eligibility', async (envelope) => {
    const userId = envelope.ctx?.userId;
    const symbol = envelope.body?.symbol;
    const companyName = envelope.body?.companyName || envelope.body?.name;
    const eligibility = symbol
      ? await alpacaAssetClient.evaluateSymbol(symbol, { userId, companyName, source: 'bmcl-symbol-eligibility' })
      : await alpacaAssetClient.evaluateCompanyLead({ name: companyName }, { userId, source: 'bmcl-symbol-eligibility' });
    return {
      provider: 'alpaca',
      version: 'alpaca-asset-eligibility-v1',
      eligibility,
      excludedSymbols: settingsRepo.getExcludedSymbols(userId).slice(0, 100),
      bmclUse: 'Use before Finnhub enrichment, watcher creation, and trade planning. If eligible is false because Alpaca reports missing/not tradable, skip research/trading and retain the symbol in Settings exclusions until manually removed or re-learned through an explicit operator review.',
    };
  });

  registerHandler('brain.research.source', 'market.consumer-goods.industry.snapshot', async (envelope) =>
    consumerGoodsIndustry.compactForBmcl(await consumerGoodsIndustry.collectConsumerGoodsIndustryContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 9000, 1500), 20000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 30, 1), 100),
      sourceIds: envelope.body?.sourceIds || envelope.body?.providers || envelope.body?.categories,
    }))
  );

  registerHandler('brain.research.source', 'market.finviz.screener.snapshot', async (envelope) =>
    finvizScreener.compactForBmcl(await finvizScreener.collectFinvizScreenerContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 12, 1), 50),
      presetIds: envelope.body?.presetIds,
      includeFundamental: envelope.body?.includeFundamental !== false,
    }))
  );

  registerHandler('brain.research.source', 'market.tradingview.screener.snapshot', async (envelope) =>
    tradingViewScreener.compactForBmcl(await tradingViewScreener.collectTradingViewScreenerContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 12, 1), 50),
      screenIds: envelope.body?.screenIds,
      includeSectors: envelope.body?.includeSectors !== false,
    }))
  );

  registerHandler('brain.research.source', 'market.yahoo.screener.snapshot', async (envelope) =>
    yahooFinanceScreener.compactForBmcl(await yahooFinanceScreener.collectYahooFinanceScreenerContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 12, 1), 50),
      screenIds: envelope.body?.screenIds,
      includeCompanyPages: Boolean(envelope.body?.includeCompanyPages),
      companySymbols: envelope.body?.companySymbols || envelope.body?.symbols || [],
    }))
  );

  registerHandler('brain.research.source', 'market.nasdaq.research.snapshot', async (envelope) =>
    nasdaqMarketResearch.compactForBmcl(await nasdaqMarketResearch.collectNasdaqMarketResearchContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 12, 1), 50),
      screenIds: envelope.body?.screenIds,
      includeCompanyPages: Boolean(envelope.body?.includeCompanyPages),
      companySymbols: envelope.body?.companySymbols || envelope.body?.symbols || [],
    }))
  );

  registerHandler('brain.research.source', 'market.marketbeat.analyst.snapshot', async (envelope) =>
    marketBeatAnalyst.compactForBmcl(await marketBeatAnalyst.collectMarketBeatAnalystContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 12, 1), 50),
      screenIds: envelope.body?.screenIds,
      includeConsensusPages: Boolean(envelope.body?.includeConsensusPages),
      companySymbols: envelope.body?.companySymbols || envelope.body?.symbols || [],
    }))
  );

  registerHandler('brain.research.source', 'market.wallstreetzen.snapshot', async (envelope) =>
    wallStreetZen.compactForBmcl(await wallStreetZen.collectWallStreetZenContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 12, 1), 50),
      screenIds: envelope.body?.screenIds,
      includeTickerPages: Boolean(envelope.body?.includeTickerPages),
      companySymbols: envelope.body?.companySymbols || envelope.body?.symbols || [],
    }))
  );

  registerHandler('brain.research.source', 'market.finra.fixed-income.snapshot', async (envelope) =>
    finraMarketData.compactForBmcl(await finraMarketData.collectFinraMarketContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 20, 1), 80),
      sourceIds: envelope.body?.sourceIds,
    }))
  );

  registerHandler('brain.research.source', 'market.sec.ownership.snapshot', async (envelope) =>
    secInstitutionalOwnership.compactForBmcl(await secInstitutionalOwnership.collectInstitutionalOwnershipContext({
      userId: envelope.ctx?.userId,
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 60, 1), 160),
      feedTypes: envelope.body?.feedTypes || envelope.body?.formTypes,
      includeDetails: Boolean(envelope.body?.includeDetails),
    }))
  );

  registerHandler('brain.research.source', 'government.usaspending.awards.snapshot', async (envelope) =>
    usaspendingAwards.compactForBmcl(await usaspendingAwards.collectFederalAwardsContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 10000, 1500), 20000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 25, 1), 100),
      page: Math.min(Math.max(Number(envelope.body?.page) || 1, 1), 10000),
      dateRange: envelope.body?.dateRange,
      recipientNames: envelope.body?.recipientNames || envelope.body?.recipientName || envelope.body?.contractor,
      awardingAgency: envelope.body?.awardingAgency,
      fundingAgency: envelope.body?.fundingAgency,
      awardType: envelope.body?.awardType || 'contracts',
      placeOfPerformanceCountry: envelope.body?.placeOfPerformanceCountry || envelope.body?.country,
      pscCodes: envelope.body?.pscCodes || envelope.body?.psc,
      naicsCodes: envelope.body?.naicsCodes || envelope.body?.naics,
      keywords: envelope.body?.keywords || envelope.body?.query,
      includeCounts: envelope.body?.includeCounts !== false,
    }))
  );

  registerHandler('brain.research.source', 'government.dod.contracts.snapshot', async (envelope) =>
    dodContracts.compactForBmcl(await dodContracts.collectDodContractsContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 10000, 1500), 20000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 20, 1), 80),
      searchTerms: envelope.body?.searchTerms || envelope.body?.search || envelope.body?.contractor || envelope.body?.query,
      includeDetails: envelope.body?.includeDetails !== false,
    }))
  );

  registerHandler('brain.research.source', 'defense.sipri.snapshot', async (envelope) =>
    sipriMilitaryData.compactForBmcl(await sipriMilitaryData.collectSipriMilitaryContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 10000, 1500), 20000),
      includePages: envelope.body?.includePages !== false,
    }))
  );

  registerHandler('brain.research.source', 'disaster.gdacs.snapshot', async (envelope) =>
    gdacsDisasters.compactForBmcl(await gdacsDisasters.collectDisasterContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      feedUrl: envelope.body?.feedUrl,
    }))
  );

  registerHandler('brain.research.source', 'disaster.eonet.snapshot', async (envelope) =>
    eonetNaturalEvents.compactForBmcl(await eonetNaturalEvents.collectNaturalEventContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      days: Math.min(Math.max(Number(envelope.body?.days) || 30, 1), 365),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 100, 1), 250),
    }))
  );

  registerHandler('brain.research.source', 'disaster.reliefweb.snapshot', async (envelope) =>
    reliefWebHumanitarian.compactForBmcl(await reliefWebHumanitarian.collectHumanitarianContext({
      userId: envelope.ctx?.userId,
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 25, 1), 100),
    }))
  );

  registerHandler('brain.research.source', 'disaster.emdat.snapshot', async (envelope) =>
    emdatHistoricalDisasters.compactForBmcl(await emdatHistoricalDisasters.collectHistoricalDisasterContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 25, 1), 100),
    }))
  );

  registerHandler('brain.research.source', 'disaster.usgs.earthquake.snapshot', async (envelope) =>
    usgsEarthquakes.compactForBmcl(await usgsEarthquakes.collectEarthquakeContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      days: Math.min(Math.max(Number(envelope.body?.days) || 30, 1), 365),
      minMagnitude: Math.min(Math.max(Number(envelope.body?.minMagnitude) || 4.5, 0), 10),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 200, 1), 2000),
      bbox: envelope.body?.bbox,
    }))
  );

  registerHandler('brain.research.source', 'weather.nws.alerts.snapshot', async (envelope) =>
    nwsWeatherAlerts.compactForBmcl(await nwsWeatherAlerts.collectWeatherAlertContext({
      userId: envelope.ctx?.userId,
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      area: envelope.body?.area,
      point: envelope.body?.point,
      event: envelope.body?.event,
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 300, 1), 500),
    }))
  );

  registerHandler('brain.research.source', 'nuclear.nrc.events.snapshot', async (envelope) =>
    nrcNuclearEvents.compactForBmcl(await nrcNuclearEvents.collectNuclearEventContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      eventLimit: Math.min(Math.max(Number(envelope.body?.eventLimit) || 150, 1), 500),
      reactorLimit: Math.min(Math.max(Number(envelope.body?.reactorLimit) || 500, 1), 5000),
    }))
  );

  registerHandler('brain.research.source', 'wildfire.nifc.snapshot', async (envelope) =>
    nifcWildfires.compactForBmcl(await nifcWildfires.collectWildfireContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 100, 1), 1000),
    }))
  );

  registerHandler('brain.research.source', 'drought.usdm.snapshot', async (envelope) =>
    usDroughtMonitor.compactForBmcl(await usDroughtMonitor.collectDroughtContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      area: envelope.body?.area,
      aoi: envelope.body?.aoi,
      startDate: envelope.body?.startDate,
      endDate: envelope.body?.endDate,
      statisticsType: Math.min(Math.max(Number(envelope.body?.statisticsType) || 1, 1), 2),
    }))
  );

  registerHandler('brain.research.source', 'humanitarian.unhcr.refugees.snapshot', async (envelope) =>
    unhcrRefugees.compactForBmcl(await unhcrRefugees.collectRefugeeStatisticsContext({
      timeoutMs: Math.min(Math.max(Number(envelope.body?.timeoutMs) || 8000, 1500), 15000),
      year: envelope.body?.year,
      limit: Math.min(Math.max(Number(envelope.body?.limit) || 500, 25), 1000),
    }))
  );

  registerHandler('brain.research.source', 'crawler.search', async (envelope) =>
    handleCrawlerSearch(envelope)
  );

  registerHandler('brain.research.source', 'crawler.crawl', async (envelope) =>
    handleCrawlerCrawl(envelope)
  );

  registerHandler('brain.research.source', 'source.hint.persist', (envelope) => {
    const userId = envelope.ctx?.userId;
    const hints = chatResearch.normalizeSourceHints(envelope.body?.sourceHints || []);
    if (!userId) return { persisted: 0, reason: 'No userId in context.' };
    for (const hint of hints) {
      researchSourceRepo.upsert({
        userId,
        url: hint.url,
        title: hint.title || hint.url,
        sourceType: 'learned',
        discoveryMethod: envelope.body?.discoveryMethod || 'brain-mesh',
        tags: ['brain-mesh', ...(hint.tags || [])].slice(0, 8),
        relevanceScore: 62,
        credibilityScore: 50,
        notes: hint.reason,
      });
    }
    return { persisted: hints.length };
  });
}

async function handleCrawlerSearch(envelope) {
  const body = envelope.body || {};
  const queries = normalizeLimitedStrings(body.queries || body.query, 4);
  if (!queries.length) return { ok: false, reason: 'No search query provided.', pages: [], failures: [] };
  const events = [];
  const result = await crawleeCrawler.crawlAutonomousResearch({
    queries,
    seedSources: [],
    maxRequests: clampNumber(body.maxRequests, 4, 36, 16),
    maxWaves: clampNumber(body.maxWaves, 1, 4, 2),
    maxFollowUps: clampNumber(body.maxFollowUps, 0, 10, 4),
    maxSearchExpansions: clampNumber(body.maxSearchExpansions, 0, 16, 8),
    maxRuntimeMs: clampNumber(body.maxRuntimeMs, 10_000, 120_000, 45_000),
    onEvent: (event) => events.push(event),
  });
  return compactCrawlerResult({ result, events, queries, mode: 'search' });
}

async function handleCrawlerCrawl(envelope) {
  const body = envelope.body || {};
  const urls = normalizeLimitedStrings(body.urls || body.url, 6).filter(isPublicHttpUrl);
  const seedSources = urls.map((url) => ({ url, title: url, tags: ['bmcl-crawl'] }));
  if (!seedSources.length) return { ok: false, reason: 'No public HTTP(S) crawl URL provided.', pages: [], failures: [] };
  const events = [];
  const result = await crawleeCrawler.crawlAutonomousResearch({
    queries: normalizeLimitedStrings(body.queries || body.query, 2),
    seedSources,
    maxRequests: clampNumber(body.maxRequests, seedSources.length, 36, Math.max(seedSources.length, 12)),
    maxWaves: clampNumber(body.maxWaves, 1, 4, 2),
    maxFollowUps: clampNumber(body.maxFollowUps, 0, 10, 4),
    maxSearchExpansions: clampNumber(body.maxSearchExpansions, 0, 12, 4),
    maxRuntimeMs: clampNumber(body.maxRuntimeMs, 10_000, 120_000, 45_000),
    onEvent: (event) => events.push(event),
  });
  return compactCrawlerResult({ result, events, queries: seedSources.map((source) => source.url), mode: 'crawl' });
}

function compactCrawlerResult({ result, events, queries, mode }) {
  return {
    ok: true,
    mode,
    queries,
    pageCount: result.pages.length,
    failureCount: result.failures.length,
    discoveredCount: result.discovered.length,
    entityLeadCount: result.entityLeads.length,
    pages: result.pages.slice(0, 8).map((page) => ({
      url: page.url,
      title: page.title,
      excerpt: page.excerpt,
      relevance: page.score?.relevance,
      tags: page.score?.tags || [],
      sourceType: page.userData?.type,
      searchProvider: page.userData?.searchProvider,
    })),
    failures: result.failures.slice(0, 8).map((failure) => ({
      url: failure.url,
      error: failure.error,
      searchProvider: failure.userData?.searchProvider,
      query: failure.userData?.query,
    })),
    providerFallbacks: events
      .filter((event) => event.phase === 'crawlee-search-fallback')
      .flatMap((event) => event.data?.fallbackRequests || [])
      .slice(0, 12),
    entityLeads: result.entityLeads.slice(0, 12),
    events: events.slice(-16),
  };
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function withTimeout(promise, timeoutMs) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`BrainMesh RPC timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

module.exports = {
  PROTOCOL,
  SUPPORTED_PROTOCOLS,
  isRemoteDispatchAllowed,
  registerRemoteHandler,
  bootstrap,
  registerAgent,
  removeAgent,
  registerHandler,
  linkAgentToBoard,
  unlinkAgentFromBoard,
  startConversation,
  frame,
  tell,
  ask,
  subscribe,
  listAgents,
  listAgentLinks,
  listConversations,
  listCompletedConversationSummaries,
  completeConversation,
  listMessages,
};
