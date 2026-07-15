const brainMesh = require('./brainMeshService');
const companyLocationAwareness = require('./companyLocationAwarenessService');
const companyLocationProfileRepo = require('../db/repositories/companyLocationProfileRepo');
const logger = require('../utils/logger');

const AGENT_ID = 'agent.location.coordinator';
const RESEARCH_TARGET_AGENT = 'agent.research.builder';
const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh a company's geo profile weekly

let registered = false;

function ensureRegistered() {
  if (registered) return;
  brainMesh.registerAgent({
    id: AGENT_ID,
    role: 'location-coordinator',
    capabilities: ['location.coordinate', 'location.mapping.share'],
    status: 'online',
    metadata: { purpose: 'Maps company manufacturing + top sales regions for geo event correlation.' },
  });
  brainMesh.registerHandler(AGENT_ID, 'location.coordinate', (envelope) =>
    coordinateLocations({ userId: envelope?.ctx?.userId, candidates: envelope?.body?.candidates || [] }));
  registered = true;
}

function isStale(profile) {
  if (!profile?.researchedAt) return true;
  return Date.now() - new Date(profile.researchedAt).getTime() > PROFILE_TTL_MS;
}

function compactMapping(profile) {
  const byType = (type) => (profile.exposures || [])
    .filter((exposure) => exposure.type === type)
    .map((exposure) => exposure.location)
    .slice(0, 6);
  return {
    primaryLocations: profile.primaryLocations || [],
    manufacturing: byType('supply_chain'),
    topSalesRegions: [...byType('customer_market'), ...byType('retail')].slice(0, 6),
    confidence: profile.confidence || 0,
  };
}

// Researches (or refreshes) each candidate company's geographic footprint in the
// background, caches the profile, and tells the research builder a compact
// symbol -> {manufacturing, topSalesRegions} mapping so downstream event scoring
// can correlate geo events (war/disaster/strike/gas) to exposed companies.
async function coordinateLocations({ userId, candidates = [], onEvent = () => {} } = {}) {
  ensureRegistered();
  if (!userId || !candidates.length) return { mapping: {}, researched: [] };

  const stale = [];
  const mapping = {};
  for (const candidate of candidates) {
    const cached = companyLocationProfileRepo.getBySymbol(userId, candidate.symbol);
    if (cached?.profile && !isStale(cached.profile)) {
      mapping[candidate.symbol] = compactMapping(cached.profile);
    } else {
      stale.push(candidate);
    }
  }

  if (stale.length) {
    try {
      const { profilesBySymbol } = await companyLocationAwareness.researchCompanyLocations({
        userId,
        candidates: stale,
        onEvent,
      });
      for (const candidate of stale) {
        const profile = profilesBySymbol.get(candidate.symbol);
        if (!profile) continue;
        companyLocationProfileRepo.save({
          userId,
          symbol: candidate.symbol,
          companyName: candidate.companyName || candidate.symbol,
          profile,
        });
        mapping[candidate.symbol] = compactMapping(profile);
      }
    } catch (error) {
      logger.warn('Location coordinator research failed', { userId, error: error.message });
    }
  }

  if (Object.keys(mapping).length) {
    brainMesh.tell({
      from: AGENT_ID,
      to: RESEARCH_TARGET_AGENT,
      kind: 'event',
      op: 'location.mapping.ready',
      ctx: { userId },
      body: { mapping, symbols: Object.keys(mapping) },
    });
  }

  return { mapping, researched: stale.map((candidate) => candidate.symbol) };
}

function getLocationProfile(userId, symbol) {
  const cached = companyLocationProfileRepo.getBySymbol(userId, symbol);
  return cached?.profile || null;
}

module.exports = {
  AGENT_ID,
  ensureRegistered,
  coordinateLocations,
  getLocationProfile,
  compactMapping,
};
