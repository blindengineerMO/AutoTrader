const express = require('express');
const brokerAccountRepo = require('../db/repositories/brokerAccountRepo');
const positionRepo = require('../db/repositories/positionRepo');
const pnlRepo = require('../db/repositories/pnlRepo');
const orderRepo = require('../db/repositories/orderRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const decisionReportRepo = require('../db/repositories/decisionReportRepo');
const { startOfTodayUtc } = require('../utils/time');

const router = express.Router();

router.get('/summary', (req, res) => {
  const userId = req.user.id;
  const brokerAccount = brokerAccountRepo.getDefault(userId);
  const positions = positionRepo.listByUser(userId);
  const settings = settingsRepo.get(userId);

  const todaysPnl = pnlRepo.sumSince(userId, startOfTodayUtc());
  const recentOrders = orderRepo.listByUser(userId, 10);
  const latestReports = decisionReportRepo.listByUser(userId, 3);

  res.json({
    brokerAccount,
    positions,
    todaysPnl,
    recentOrders,
    latestReports,
    settings,
  });
});

module.exports = router;
