const express = require('express');
const dashboardSummary = require('../services/dashboardSummaryService');
const simulationFundingRoutes = require('./simulationFundingRoutes');

const router = express.Router();

router.use('/simulation-funding', simulationFundingRoutes);

router.get('/summary', async (req, res, next) => {
  try {
    res.json(await dashboardSummary.buildDashboardSummary(req.user.id));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
