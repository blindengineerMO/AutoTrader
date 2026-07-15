const { config } = require('../config');
const logger = require('../utils/logger');
const migrate = require('../db/migrate');

// Must run before any repository module is required — repositories prepare
// their statements at require-time, which fails if tables don't exist yet.
migrate();

const userAdminService = require('../services/userAdminService');
const researchRunRepo = require('../db/repositories/researchRunRepo');
const searchProviderHealthPersistence = require('../services/searchProviderHealthPersistenceService');
const db = require('../db/connection');

async function start() {
  await userAdminService.ensureDefaultAdmin();

  // Reconcile any research runs left mid-flight by an unexpected restart so they
  // don't linger as zombies. Brain-model writes are atomic single upserts under
  // WAL, so the datasets themselves are never corrupted — only the run row needs
  // to be closed out. The next scheduled cron re-runs the work fresh.
  const staleRuns = researchRunRepo.markStaleRunning({ olderThanMinutes: 0 });
  if (staleRuns.length) {
    logger.warn('Reconciled interrupted research runs on startup', { count: staleRuns.length });
  }

  // Restore search-provider health (success/failure/rate-limit counters) saved
  // before the last shutdown, so a provider that was cooling down isn't
  // immediately re-hammered right after a restart. updatedAt is preserved, so
  // the normal time-decay curve resumes as if the process never stopped.
  const restoredProviders = searchProviderHealthPersistence.restore();
  if (restoredProviders) {
    logger.info('Restored search provider health from last run', { providers: restoredProviders });
  }

  const createApp = require('./app');
  const app = createApp();
  const scheduler = require('../jobs/scheduler');

  scheduler.scheduleAllUsers();

  const server = app.listen(config.port, () => {
    logger.info(`AutoTrader server listening on port ${config.port}`, { env: config.env });
  });

  const brainMeshNodeTransport = require('../services/brainMeshNodeTransport');
  const nodeTransport = brainMeshNodeTransport.attach(server);

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down gracefully`, {});
    try {
      scheduler.stopAll();
    } catch (err) {
      logger.warn('Error stopping scheduler during shutdown', { error: err.message });
    }
    try {
      nodeTransport.close();
    } catch (err) {
      logger.warn('Error closing BrainMesh node transport during shutdown', { error: err.message });
    }
    searchProviderHealthPersistence.persist();
    server.close(() => {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
      } catch (err) {
        logger.warn('Error closing database during shutdown', { error: err.message });
      }
      logger.info('Shutdown complete', {});
      process.exit(0);
    });
    // Failsafe: force-exit if connections don't drain promptly.
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('AutoTrader server failed to start', { error: err.message, stack: err.stack });
  process.exit(1);
});
