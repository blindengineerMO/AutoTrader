const { config } = require('../config');
const logger = require('../utils/logger');
const migrate = require('../db/migrate');

// Must run before any repository module is required — repositories prepare
// their statements at require-time, which fails if tables don't exist yet.
migrate();

const createApp = require('./app');
const app = createApp();
const scheduler = require('../jobs/scheduler');

scheduler.scheduleAllUsers();

app.listen(config.port, () => {
  logger.info(`AutoTrader server listening on port ${config.port}`, { env: config.env });
});
