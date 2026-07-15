const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const requestLogger = require('../middleware/requestLogger');
const requireAuth = require('../middleware/auth');
const { getTradingReadiness } = require('../config');

const authRoutes = require('../routes/authRoutes');
const publicRoutes = require('../routes/publicRoutes');
const dashboardRoutes = require('../routes/dashboardRoutes');
const researchRoutes = require('../routes/researchRoutes');
const orderRoutes = require('../routes/orderRoutes');
const settingsRoutes = require('../routes/settingsRoutes');
const companyRoutes = require('../routes/companyRoutes');
const brainMeshRoutes = require('../routes/brainMeshRoutes');
const brainMeshNodeRoutes = require('../routes/brainMeshNodeRoutes');
const agentRoutes = require('../routes/agentRoutes');
const watcherAgentRoutes = require('../routes/watcherAgentRoutes');
const adminRoutes = require('../routes/adminRoutes');
const simulationFundingRoutes = require('../routes/simulationFundingRoutes');

function createApp() {
  const app = express();
  const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
  const frontendIndex = path.join(frontendDist, 'index.html');

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(requestLogger);

  app.get('/api/health', (req, res) => {
    const readiness = getTradingReadiness();
    res.json({ status: 'ok', tradingReady: readiness.ready, missingForTrading: readiness.missing });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/dashboard', requireAuth, dashboardRoutes);
  app.use('/api/research', requireAuth, researchRoutes);
  app.use('/api/orders', requireAuth, orderRoutes);
  app.use('/api/simulation-funding', requireAuth, simulationFundingRoutes);
  app.use('/api/settings', requireAuth, settingsRoutes);
  app.use('/api/companies', requireAuth, companyRoutes);
  app.use('/api/brain-mesh', requireAuth, brainMeshRoutes);
app.use('/api/brain-mesh/nodes', requireAuth, brainMeshNodeRoutes);
  app.use('/api/agents', requireAuth, agentRoutes);
  app.use('/api/watcher-agents', requireAuth, watcherAgentRoutes);
  app.use('/api/admin', requireAuth, adminRoutes);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(frontendDist));
  app.get('*', (req, res) => {
    res.sendFile(frontendIndex, (err) => {
      if (err) res.status(503).json({ error: 'Frontend build not found. Run npm run build:frontend.' });
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    req.app.get('logger')?.error(err.message, { stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = createApp;
