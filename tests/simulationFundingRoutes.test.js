const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-simulation-funding-routes.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const authService = require('../src/services/authService');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const simulationModeService = require('../src/services/simulationModeService');
const createApp = require('../src/server/app');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function jsonRequest(server, pathName, token, options = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${pathName}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json();
  return { response, body };
}

describe('simulation funding routes', () => {
  it('adds one-time simulation funds from dashboard and orders API aliases', async () => {
    const { token, user } = await authService.register({
      email: `sim-route-${Date.now()}@example.com`,
      password: 'correct-horse',
    });
    settingsRepo.update(user.id, {
      simulationModeEnabled: 1,
      simulationStartingCashUsd: 100,
    });
    simulationModeService.startSimulation(user.id);

    const server = await listen(createApp());
    try {
      const canonicalAdd = await jsonRequest(server, '/api/simulation-funding/now', token, {
        method: 'POST',
        body: { amountUsd: 5, memo: 'canonical route add' },
      });
      const dashboardAdd = await jsonRequest(server, '/api/dashboard/simulation-funding/now', token, {
        method: 'POST',
        body: { amountUsd: 15, memo: 'dashboard route add' },
      });
      const ordersAdd = await jsonRequest(server, '/api/orders/simulation-funding/now', token, {
        method: 'POST',
        body: { amountUsd: 10, memo: 'orders route add' },
      });
      const summary = await jsonRequest(server, '/api/dashboard/simulation-funding', token);

      expect(canonicalAdd.response.status).toBe(201);
      expect(canonicalAdd.body.amount_usd).toBe(5);
      expect(dashboardAdd.response.status).toBe(201);
      expect(dashboardAdd.body.amount_usd).toBe(15);
      expect(ordersAdd.response.status).toBe(201);
      expect(ordersAdd.body.amount_usd).toBe(10);
      expect(summary.response.status).toBe(200);
      expect(summary.body.totalAddedUsd).toBe(30);
    } finally {
      server.close();
    }
  });
});
