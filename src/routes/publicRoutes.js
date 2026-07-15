const express = require('express');
const { getPublicHomeSignal } = require('../services/publicHomeSignalService');

const router = express.Router();

router.get('/home-signal', (req, res, next) => {
  try {
    res.json(getPublicHomeSignal());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
