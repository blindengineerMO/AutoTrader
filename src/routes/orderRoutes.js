const express = require('express');
const orderRepo = require('../db/repositories/orderRepo');
const pnlRepo = require('../db/repositories/pnlRepo');

const router = express.Router();

router.get('/', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(orderRepo.listByUser(req.user.id, limit));
});

router.get('/pnl-history', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  res.json(pnlRepo.listByUser(req.user.id, limit));
});

module.exports = router;
