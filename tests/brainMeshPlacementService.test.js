const placementService = require('../src/services/brainMeshPlacementService');

function candidate(overrides = {}) {
  return {
    id: 'node_1',
    status: 'online',
    currentLoad: 0,
    maxConcurrency: 2,
    capabilityUpdatedAt: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('brainMeshPlacementService.pickNodeForJob', () => {
  it('returns null when there are no candidates', () => {
    expect(placementService.pickNodeForJob([])).toBeNull();
  });

  it('excludes offline nodes', () => {
    const nodes = [candidate({ id: 'node_offline', status: 'offline' })];
    expect(placementService.pickNodeForJob(nodes)).toBeNull();
  });

  it('excludes nodes at full capacity', () => {
    const nodes = [candidate({ id: 'node_full', currentLoad: 2, maxConcurrency: 2 })];
    expect(placementService.pickNodeForJob(nodes)).toBeNull();
  });

  it('picks the node with the lowest load ratio', () => {
    const nodes = [
      candidate({ id: 'node_busy', currentLoad: 3, maxConcurrency: 4 }),
      candidate({ id: 'node_idle', currentLoad: 1, maxConcurrency: 4 }),
    ];
    expect(placementService.pickNodeForJob(nodes).id).toBe('node_idle');
  });

  it('breaks load-ratio ties by longest-idle', () => {
    const nodes = [
      candidate({ id: 'node_recent', currentLoad: 1, maxConcurrency: 2, capabilityUpdatedAt: '2026-01-01 12:00:00' }),
      candidate({ id: 'node_stale', currentLoad: 1, maxConcurrency: 2, capabilityUpdatedAt: '2026-01-01 00:00:00' }),
    ];
    expect(placementService.pickNodeForJob(nodes).id).toBe('node_stale');
  });
});
