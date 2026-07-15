const express = require('express');
const simulationCashFunding = require('../services/simulationCashFundingService');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(simulationCashFunding.getDashboardFunding(req.user.id));
});

router.post('/now', (req, res) => {
  try {
    res.status(201).json(simulationCashFunding.addCashNow(req.user.id, {
      amountUsd: req.body?.amountUsd,
      memo: req.body?.memo,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/rules', (req, res) => {
  try {
    res.status(201).json(simulationCashFunding.createFundingRule(req.user.id, {
      amountUsd: req.body?.amountUsd,
      cadence: req.body?.cadence,
      weekday: req.body?.weekday,
      monthDay: req.body?.monthDay,
      timeOfDay: req.body?.timeOfDay,
      memo: req.body?.memo,
      runNow: req.body?.runNow,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/apply-due', (req, res) => {
  try {
    res.json(simulationCashFunding.applyDueFunding(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/rules/:id', (req, res) => {
  res.json(simulationCashFunding.cancelRule(req.user.id, Number(req.params.id)));
});

module.exports = router;
