const express = require('express');
const orderRepo = require('../db/repositories/orderRepo');
const pnlRepo = require('../db/repositories/pnlRepo');
const glLedgerRepo = require('../db/repositories/glLedgerRepo');
const simulationFundingRoutes = require('./simulationFundingRoutes');

const router = express.Router();

router.use('/simulation-funding', simulationFundingRoutes);

router.get('/', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(orderRepo.listByUser(req.user.id, limit));
});

router.get('/pnl-history', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  res.json(pnlRepo.listByUser(req.user.id, limit));
});

router.get('/gl-ledger', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  res.json(glLedgerRepo.listByUser(req.user.id, limit));
});

router.get('/gl-ledger/companies', (req, res) => {
  res.json(glLedgerRepo.listCompanySymbols(req.user.id));
});

router.get('/gl-ledger/:symbol', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  res.json(glLedgerRepo.listByCompany(req.user.id, req.params.symbol, limit));
});

module.exports = router;
