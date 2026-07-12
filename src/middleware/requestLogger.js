const logger = require('../utils/logger');

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  const requestId = Math.random().toString(36).slice(2, 10);
  req.requestId = requestId;

  logger.info(`--> ${req.method} ${req.originalUrl}`, {
    requestId,
    ip: req.ip,
    userId: req.user?.id,
  });

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info(`<-- ${req.method} ${req.originalUrl} ${res.statusCode}`, {
      requestId,
      durationMs: Math.round(durationMs),
      userId: req.user?.id,
    });
  });

  next();
}

module.exports = requestLogger;
