const express = require('express');
const nodeRepo = require('../db/repositories/brainMeshNodeRepo');
const nodeTransport = require('../services/brainMeshNodeTransport');

const router = express.Router();

router.post('/join-tokens', (req, res) => {
  try {
    const token = nodeRepo.createJoinToken({
      userId: req.user.id,
      label: req.body?.label || null,
      ttlMs: Number(req.body?.ttlMs) || undefined,
    });
    res.status(201).json(token);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/join-tokens', (req, res) => {
  res.json(nodeRepo.listJoinTokens(req.user.id));
});

router.delete('/join-tokens/:id', (req, res) => {
  const revoked = nodeRepo.revokeJoinToken(req.params.id, req.user.id);
  if (!revoked) return res.status(404).json({ error: 'join token not found or already used' });
  res.json({ ok: true });
});

router.get('/nodes', (req, res) => {
  res.json(nodeRepo.listNodes(req.user.id));
});

router.delete('/nodes/:nodeId', (req, res) => {
  const revoked = nodeRepo.revokeNode(req.params.nodeId, req.user.id);
  if (!revoked) return res.status(404).json({ error: 'node not found' });
  nodeTransport.forceDisconnect(req.params.nodeId);
  res.json({ ok: true });
});

module.exports = router;
