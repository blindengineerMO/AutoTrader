const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-brain-mesh-trust-boundary.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const brainMesh = require('../src/services/brainMeshService');

describe('brainMeshService.isRemoteDispatchAllowed', () => {
  it.each([
    'order.place',
    'order.cancel',
    'trading.execute',
    'broker.submitOrder',
    'rules.override',
    'kill-switch.release',
  ])('denies %s regardless of any allow-pattern overlap', (op) => {
    expect(brainMesh.isRemoteDispatchAllowed(op)).toBe(false);
  });

  it.each(['crawler.crawl', 'market.quote', 'agent.research.summarize'])(
    'allows known research/compute op %s',
    (op) => {
      expect(brainMesh.isRemoteDispatchAllowed(op)).toBe(true);
    }
  );
});

describe('brainMeshService.registerRemoteHandler', () => {
  it('refuses to register a handler for a disallowed op at registration time', () => {
    const registered = brainMesh.registerRemoteHandler('brain.trading', 'order.place', async () => ({}));
    expect(registered).toBe(false);
  });

  it('registers a handler for an allowed compute op', () => {
    const registered = brainMesh.registerRemoteHandler('brain.research.source', 'crawler.crawl.test-registration', async () => ({ ok: true }));
    expect(registered).toBe(true);
  });
});
