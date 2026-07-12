const express = require('express');
const brainMesh = require('../services/brainMeshService');

const router = express.Router();

router.get('/agents', (req, res) => {
  res.json(brainMesh.listAgents(req.user.id));
});

router.post('/agents', (req, res) => {
  try {
    const agent = brainMesh.registerAgent({
      id: req.body?.id,
      userId: req.user.id,
      role: req.body?.role,
      capabilities: req.body?.capabilities || [],
      status: req.body?.status || 'online',
      metadata: req.body?.metadata || {},
    });
    res.status(201).json(agent);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/agents/:id', (req, res) => {
  try {
    res.json(brainMesh.removeAgent(req.params.id, req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/agent-links', (req, res) => {
  res.json(brainMesh.listAgentLinks({ userId: req.user.id, boardId: req.query.boardId || null }));
});

router.post('/agent-links', (req, res) => {
  try {
    res.status(201).json(brainMesh.linkAgentToBoard({
      userId: req.user.id,
      agentId: req.body?.agentId,
      boardId: req.body?.boardId,
      role: req.body?.role || 'member',
      metadata: req.body?.metadata || {},
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/agent-links/:boardId/:agentId', (req, res) => {
  try {
    res.json(brainMesh.unlinkAgentFromBoard({
      userId: req.user.id,
      boardId: req.params.boardId,
      agentId: req.params.agentId,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/conversations', (req, res) => {
  res.json(brainMesh.listConversations(req.user.id, Number(req.query.limit) || 50));
});

router.get('/messages', (req, res) => {
  res.json(brainMesh.listMessages({
    userId: req.user.id,
    conversationId: req.query.conversationId || null,
    traceId: req.query.traceId || null,
    limit: Number(req.query.limit) || 100,
  }));
});

router.post('/tell', (req, res) => {
  try {
    const envelope = brainMesh.tell({
      from: req.body?.from || 'operator.ui',
      to: req.body?.to || 'brain.reporting',
      kind: req.body?.kind || 'tell',
      op: req.body?.op || 'operator.note',
      body: req.body?.body || {},
      ctx: { ...(req.body?.ctx || {}), userId: req.user.id },
      conv: req.body?.conv,
      trace: req.body?.trace,
      cause: req.body?.cause,
      ttl: req.body?.ttl,
      qos: req.body?.qos,
    });
    res.status(202).json(envelope);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/ask', async (req, res) => {
  try {
    const result = await brainMesh.ask({
      from: req.body?.from || 'operator.ui',
      to: req.body?.to || 'brain.reporting',
      op: req.body?.op || 'mesh.status',
      body: req.body?.body || {},
      ctx: { ...(req.body?.ctx || {}), userId: req.user.id },
      conv: req.body?.conv,
      trace: req.body?.trace,
      ttl: req.body?.ttl,
      qos: req.body?.qos,
    }, { timeoutMs: Number(req.body?.timeoutMs) || 8000 });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('ready', { ok: true, protocol: brainMesh.PROTOCOL, userId: req.user.id });
  const unsubscribe = brainMesh.subscribe((envelope) => send('brain-frame', envelope), {
    userId: req.user.id,
    conversationId: req.query.conversationId || null,
    traceId: req.query.traceId || null,
  });
  const heartbeat = setInterval(() => send('heartbeat', { ts: new Date().toISOString() }), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

module.exports = router;
