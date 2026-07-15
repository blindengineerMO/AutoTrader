function loadRatio(candidate) {
  const max = Math.max(1, candidate.maxConcurrency);
  return candidate.currentLoad / max;
}

function pickNodeForJob(candidates = []) {
  const eligible = candidates.filter(
    (c) => c.status === 'online' && c.currentLoad < c.maxConcurrency
  );
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const ratioDiff = loadRatio(a) - loadRatio(b);
    if (ratioDiff !== 0) return ratioDiff;
    return new Date(a.capabilityUpdatedAt) - new Date(b.capabilityUpdatedAt);
  });

  return eligible[0];
}

module.exports = { pickNodeForJob };
