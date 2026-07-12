const express = require('express');
const companyIntelligenceRepo = require('../db/repositories/companyIntelligenceRepo');
const brainModelRepo = require('../db/repositories/brainModelRepo');

const router = express.Router();

router.get('/', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  res.json(companyIntelligenceRepo.listByUser(req.user.id, limit));
});

router.get('/brain/models', (req, res) => {
  res.json(brainModelRepo.list(req.user.id).map((model) => ({
    id: model.id,
    model_key: model.model_key,
    metadata: model.metadata,
    updated_at: model.updated_at,
  })));
});

router.get('/:symbol', (req, res) => {
  const company = companyIntelligenceRepo.getBySymbol(req.user.id, req.params.symbol.toUpperCase());
  if (!company) return res.status(404).json({ error: 'Company intelligence not found' });
  res.json(company);
});

module.exports = router;
