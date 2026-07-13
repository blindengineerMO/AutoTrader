const express = require('express');
const dashboardSummary = require('../services/dashboardSummaryService');

const router = express.Router();

router.get('/summary', async (req, res, next) => {
  try {
    res.json(await dashboardSummary.buildDashboardSummary(req.user.id));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
