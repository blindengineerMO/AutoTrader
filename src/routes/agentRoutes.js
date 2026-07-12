const express = require('express');
const personalityAgents = require('../services/personalityAgentService');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(personalityAgents.listAgents(req.user.id));
});

router.post('/', (req, res) => {
  try {
    const agent = personalityAgents.createAgent(req.user.id, req.body?.name);
    res.status(201).json(agent);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/seed', (req, res) => {
  res.json(personalityAgents.ensureDefaultAgents(req.user.id));
});

router.post('/research-create', (req, res) => {
  try {
    const run = personalityAgents.startResearchCreateAgent(req.user.id, req.body?.name);
    res.status(202).json(run);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/research-runs/:runId', (req, res) => {
  const run = personalityAgents.getResearchCreateRun(req.user.id, req.params.runId);
  if (!run) return res.status(404).json({ error: 'Agent research run not found' });
  res.json(run);
});

router.post('/import', (req, res) => {
  try {
    res.status(201).json(personalityAgents.importAgent(req.user.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/council/runs', (req, res) => {
  res.json(personalityAgents.listCouncilRuns(req.user.id, Number(req.query.limit) || 20));
});

router.post('/council/run', async (req, res) => {
  try {
    const run = await personalityAgents.runCouncil({
      userId: req.user.id,
      snapshotId: req.body?.snapshotId || null,
    });
    res.status(201).json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    res.json(personalityAgents.updateAgent(req.user.id, Number(req.params.id), req.body || {}));
  } catch (err) {
    res.status(err.message === 'Agent not found' ? 404 : 400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    res.json(personalityAgents.deleteAgent(req.user.id, Number(req.params.id)));
  } catch (err) {
    res.status(err.message === 'Agent not found' ? 404 : 400).json({ error: err.message });
  }
});

router.get('/:id/export', (req, res) => {
  try {
    res.json(personalityAgents.exportAgent(req.user.id, Number(req.params.id)));
  } catch (err) {
    res.status(err.message === 'Agent not found' ? 404 : 400).json({ error: err.message });
  }
});

module.exports = router;
