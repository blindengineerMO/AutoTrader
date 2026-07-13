const { EventEmitter } = require('events');
const crypto = require('crypto');
const brainMeshRepo = require('../db/repositories/brainMeshRepo');
const researchSourceRepo = require('../db/repositories/researchSourceRepo');
const companyDiscovery = require('./companyDiscoveryService');
const chatResearch = require('./chatResearchService');
const investorPlaybook = require('./investorPlaybookService');
const logger = require('../utils/logger');

const PROTOCOL = 'BMCL/1.0';
const DEFAULT_TTL = 16;
const bus = new EventEmitter();
bus.setMaxListeners(200);

const agents = new Map();
const handlers = new Map();
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
  return envelope;
}

async function ask(input, { timeoutMs = 8000 } = {}) {
  bootstrap();
  const request = tell({ ...input, kind: 'ask', qos: { ...(input.qos || {}), ack: true } });
  const replies = [];
  const targets = request.to;

  await Promise.allSettled(targets.map(async (target) => {
    const handler = handlers.get(`${target}:${request.op}`) || handlers.get(`${target}:*`);
    if (!handler) {
      replies.push(errorReply(request, target, `No handler registered for ${target}:${request.op}`));
      return;
    }
    try {
      const body = await withTimeout(Promise.resolve(handler(request)), timeoutMs);
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
    const handler = handlers.get(`${target}:${envelope.op}`) || handlers.get(`${target}:*`);
    if (!handler) continue;
    dispatched += 1;
    Promise.resolve(handler(envelope)).catch((err) => {
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
  if (envelope.proto !== PROTOCOL) throw new Error(`Unsupported BrainMesh protocol ${envelope.proto}`);
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

function registerDefaultAgents() {
  const definitions = [
    {
      id: 'brain.research.source',
      role: 'research-source-brain',
      capabilities: ['mesh.status', 'source.memory.summary', 'source.hint.persist'],
      metadata: { service: 'researchSourceLearningService' },
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
      id: 'brain.reporting',
      role: 'reporting-brain',
      capabilities: ['mesh.status'],
      metadata: { service: 'decisionReportService' },
    },
    {
      id: 'brain.evaluation',
      role: 'evaluation-brain',
      capabilities: ['mesh.status'],
      metadata: { service: 'evaluationService' },
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

  registerHandler('brain.playbook.investor', 'playbook.summary', () => investorPlaybook.getPlaybookSummary());

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
  listMessages,
};
