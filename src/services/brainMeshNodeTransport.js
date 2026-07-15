const crypto = require('crypto');
const WebSocket = require('ws');
const nodeRepo = require('../db/repositories/brainMeshNodeRepo');
const configRepo = require('../db/repositories/brainMeshNodeConfigRepo');
const brainMesh = require('./brainMeshService');
const placementService = require('./brainMeshPlacementService');
const ollamaBrain = require('./ollamaBrainMeshService');
const logger = require('../utils/logger');

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const JOB_TIMEOUT_MS = 60_000;

// Maps a remotely-dispatchable op to the local agent id that already fields
// that op today, so a node's capability plugs into the existing dispatch
// target instead of requiring callers to address nodes directly.
const AGENT_FOR_OP = {
  'crawler.crawl': 'brain.research.source',
  'llm.chat': ollamaBrain.OLLAMA_BRAIN_ID,
};

// nodeId -> { socket, userId, lastSeenAt, capabilities: Set<op>, pendingJobs: Map<jobId, {resolve,reject,timeout,op}> }
const connections = new Map();

// ops for which a shared placement-aware remote handler has been registered
const opsWithRemoteHandler = new Set();

function ensureRemoteHandlerForOp(op) {
  const agentId = AGENT_FOR_OP[op];
  if (!agentId || opsWithRemoteHandler.has(op)) return;
  const registered = brainMesh.registerRemoteHandler(agentId, op, (envelope) => dispatchJobForOp(op, envelope));
  if (registered) opsWithRemoteHandler.add(op);
}

function dispatchJobForOp(op, envelope) {
  const userId = envelope.ctx?.userId || null;
  const candidates = nodeRepo.listNodesByCapability(op, userId);
  const chosen = placementService.pickNodeForJob(candidates);
  if (!chosen) {
    const err = new Error(`no online node available for ${op}`);
    err.code = 'BMCL_NO_REMOTE_NODE';
    return Promise.reject(err);
  }
  return dispatchJobToNode(chosen.id, userId, op, envelope);
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function verifySignature(publicKeyPem, nonce, signatureBase64) {
  try {
    // Ed25519 hashes internally, so Node's one-shot crypto.verify must be
    // called with a null algorithm rather than createVerify('SHA256').
    return crypto.verify(null, Buffer.from(nonce), publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

function closeWithReason(socket, reason) {
  send(socket, { kind: 'node.hello.ack', body: { ok: false, reason } });
  socket.close();
}

function handleHello(socket, nonce, body) {
  const { publicKey, joinToken, nodeId, signature, capabilities = [], clientVersion } = body || {};
  if (!publicKey) return closeWithReason(socket, 'missing publicKey');

  let node;
  if (joinToken) {
    const consumed = nodeRepo.consumeJoinToken(joinToken, nodeId || `node_${crypto.randomBytes(8).toString('hex')}`);
    if (!consumed) return closeWithReason(socket, 'invalid or expired join token');
    const assignedNodeId = nodeId || `node_${crypto.randomBytes(8).toString('hex')}`;
    node = nodeRepo.upsertNode({
      id: assignedNodeId,
      userId: consumed.userId,
      publicKey,
      clientVersion,
      status: 'online',
    });
  } else {
    const existing = nodeRepo.getNodeByPublicKey(publicKey);
    if (!existing || existing.status === 'revoked') return closeWithReason(socket, 'unknown or revoked node');
    if (!signature || !verifySignature(publicKey, nonce, signature)) {
      return closeWithReason(socket, 'signature verification failed');
    }
    node = nodeRepo.upsertNode({
      id: existing.id,
      userId: existing.user_id,
      publicKey,
      label: existing.label,
      clientVersion,
      status: 'online',
    });
  }

  const allowedCapabilities = capabilities.filter((cap) => brainMesh.isRemoteDispatchAllowed(cap.op));
  const rejectedCapabilities = capabilities.filter((cap) => !brainMesh.isRemoteDispatchAllowed(cap.op));
  if (rejectedCapabilities.length) {
    logger.warn('BMCL node advertised disallowed capabilities, ignoring them', {
      nodeId: node.id,
      rejected: rejectedCapabilities.map((c) => c.op),
    });
  }
  nodeRepo.upsertNodeCapabilities(node.id, allowedCapabilities);

  const capabilitySet = new Set(allowedCapabilities.map((c) => c.op));
  const connection = {
    socket,
    userId: node.user_id,
    lastSeenAt: Date.now(),
    capabilities: capabilitySet,
    pendingJobs: new Map(),
  };
  connections.set(node.id, connection);

  for (const cap of allowedCapabilities) {
    ensureRemoteHandlerForOp(cap.op);
  }

  send(socket, {
    kind: 'node.hello.ack',
    body: { ok: true, nodeId: node.id, sessionId: crypto.randomBytes(8).toString('hex'), heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS },
  });

  socket.nodeId = node.id;
}

function handleHeartbeat(nodeId, body) {
  const connection = connections.get(nodeId);
  if (!connection) return;
  connection.lastSeenAt = Date.now();
  nodeRepo.setNodeStatus(nodeId, 'online');
  if (Array.isArray(body?.capabilities)) {
    const allowed = body.capabilities.filter((cap) => brainMesh.isRemoteDispatchAllowed(cap.op));
    nodeRepo.upsertNodeCapabilities(nodeId, allowed);
    connection.capabilities = new Set(allowed.map((c) => c.op));
    for (const cap of allowed) {
      ensureRemoteHandlerForOp(cap.op);
    }
  }
}

function handleJobResult(nodeId, body) {
  const connection = connections.get(nodeId);
  if (!connection) return;
  const { jobId, ok, result, error } = body || {};
  const pending = connection.pendingJobs.get(jobId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  connection.pendingJobs.delete(jobId);
  nodeRepo.decrementNodeLoad(nodeId, pending.op);
  nodeRepo.recordJobResult({ id: jobId, status: ok ? 'completed' : 'failed', result, error });
  if (ok) pending.resolve(result);
  else pending.reject(new Error(error || 'remote job failed'));
}

function dispatchJobToNode(nodeId, userId, op, envelope) {
  const connection = connections.get(nodeId);
  if (!connection) return Promise.reject(new Error(`node ${nodeId} not connected`));

  const jobId = envelope.id || `job_${crypto.randomBytes(8).toString('hex')}`;
  nodeRepo.incrementNodeLoad(nodeId, op);
  nodeRepo.recordJobAssigned({ id: jobId, nodeId, userId, op, request: envelope.body });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      connection.pendingJobs.delete(jobId);
      nodeRepo.decrementNodeLoad(nodeId, op);
      nodeRepo.recordJobResult({ id: jobId, status: 'timeout', error: 'job timed out' });
      reject(new Error('remote job timed out'));
    }, JOB_TIMEOUT_MS);

    connection.pendingJobs.set(jobId, { resolve, reject, timeout, op });
    send(connection.socket, { kind: 'node.job.assign', body: { jobId, op, request: envelope.body } });
  });
}

function disconnectNode(nodeId) {
  const connection = connections.get(nodeId);
  if (!connection) return;
  for (const pending of connection.pendingJobs.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('node disconnected'));
  }
  connections.delete(nodeId);
  nodeRepo.setNodeStatus(nodeId, 'offline');
}

function attach(server) {
  const wss = new WebSocket.Server({ server, path: '/api/brain-mesh/nodes/socket' });

  wss.on('connection', (socket) => {
    const nonce = crypto.randomBytes(24).toString('base64url');
    send(socket, { kind: 'node.challenge', body: { nonce } });

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { kind, body } = message || {};
      if (kind === 'node.hello') return handleHello(socket, nonce, body);
      if (!socket.nodeId) return;
      if (kind === 'node.heartbeat') return handleHeartbeat(socket.nodeId, body);
      if (kind === 'node.job.result') return handleJobResult(socket.nodeId, body);
      if (kind === 'node.bye') return disconnectNode(socket.nodeId);
    });

    socket.on('close', () => {
      if (socket.nodeId) disconnectNode(socket.nodeId);
    });
  });

  const staleCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [nodeId, connection] of connections.entries()) {
      if (now - connection.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
        connection.socket.terminate();
        disconnectNode(nodeId);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  staleCheckInterval.unref();

  return {
    close: () => {
      clearInterval(staleCheckInterval);
      for (const nodeId of Array.from(connections.keys())) disconnectNode(nodeId);
      wss.close();
    },
  };
}

function forceDisconnect(nodeId) {
  const connection = connections.get(nodeId);
  if (!connection) return false;
  connection.socket.close();
  disconnectNode(nodeId);
  return true;
}

module.exports = { attach, forceDisconnect };
