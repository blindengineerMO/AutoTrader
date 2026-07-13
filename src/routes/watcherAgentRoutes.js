const express = require('express');
const watcherAgentRepo = require('../db/repositories/watcherAgentRepo');
const brainMesh = require('../services/brainMeshService');

const router = express.Router();

function toSummary(agent) {
  const scorecard = watcherAgentRepo.getScorecard(agent.id);
  return {
    id: agent.id,
    symbol: agent.symbol,
    companyName: agent.company_name,
    priceTier: agent.price_tier,
    status: agent.status,
    lastResearchedAt: agent.last_researched_at,
    scorecard,
  };
}

router.get('/', (req, res) => {
  const agents = watcherAgentRepo.listActiveByUser(req.user.id);
  res.json(agents.map(toSummary));
});

router.get('/:symbol', (req, res) => {
  const agent = watcherAgentRepo.getBySymbol(req.user.id, req.params.symbol.toUpperCase());
  if (!agent) return res.status(404).json({ error: 'Watcher agent not found' });

  const limit = Number(req.query.limit) || 20;
  const researchRuns = watcherAgentRepo.listResearchRuns(agent.id, limit);
  const grades = watcherAgentRepo.listGrades(agent.id, limit);
  const scorecard = watcherAgentRepo.getScorecard(agent.id);
  const messages = brainMesh
    .listMessages({ userId: req.user.id, limit: 200 })
    .filter((m) => m.sender === agent.brain_id || String(m.recipient).split(',').includes(agent.brain_id));

  res.json({
    id: agent.id,
    symbol: agent.symbol,
    companyName: agent.company_name,
    priceTier: agent.price_tier,
    status: agent.status,
    lastResearchedAt: agent.last_researched_at,
    brainId: agent.brain_id,
    scorecard,
    researchRuns,
    grades,
    conversation: messages,
  });
});

module.exports = router;
