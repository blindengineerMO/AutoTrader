const db = require('../connection');

// Council personas are shared brain identities across users (same slug
// everywhere), so affinity is tracked globally per (unordered) slug pair +
// topic rather than per-user — it reflects what the personas themselves are,
// not any one user's council runs.
const MIN_SAMPLES_FOR_CONFIDENCE = 5;
const AFFINITY_STEP = 0.08;

function orderedPair(slugA, slugB) {
  return slugA <= slugB ? [slugA, slugB] : [slugB, slugA];
}

const getPairStmt = db.prepare(
  'SELECT * FROM agent_affinity WHERE agent_slug_a = ? AND agent_slug_b = ? AND topic = ?'
);
const insertPairStmt = db.prepare(`
  INSERT INTO agent_affinity (agent_slug_a, agent_slug_b, topic, interactions, challenges_upheld, challenges_overruled, affinity_score, last_interaction_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`);
const updatePairStmt = db.prepare(`
  UPDATE agent_affinity
  SET interactions = ?, challenges_upheld = ?, challenges_overruled = ?, affinity_score = ?, last_interaction_at = datetime('now'), updated_at = datetime('now')
  WHERE id = ?
`);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// An upheld challenge means the pairing surfaced a real risk worth
// consulting again on this topic; an overruled one means the challenger had
// little to add here. Moves affinity_score toward +1/-1 with diminishing
// steps as it approaches the bound, same shape as the watcher peer-signal nudge.
function recordChallengeOutcome({ slugA, slugB, topic = 'general', upheld }) {
  if (!slugA || !slugB || slugA === slugB) return null;
  const [a, b] = orderedPair(slugA, slugB);
  const normalizedTopic = String(topic || 'general').toLowerCase();
  const existing = getPairStmt.get(a, b, normalizedTopic);
  const direction = upheld ? 1 : -1;
  if (!existing) {
    const score = clamp(direction * AFFINITY_STEP, -1, 1);
    insertPairStmt.run(a, b, normalizedTopic, 1, upheld ? 1 : 0, upheld ? 0 : 1, score);
    return { agentSlugA: a, agentSlugB: b, topic: normalizedTopic, interactions: 1, affinityScore: score };
  }
  const score = clamp(existing.affinity_score + direction * AFFINITY_STEP * (1 - Math.abs(existing.affinity_score)), -1, 1);
  updatePairStmt.run(
    existing.interactions + 1,
    existing.challenges_upheld + (upheld ? 1 : 0),
    existing.challenges_overruled + (upheld ? 0 : 1),
    score,
    existing.id
  );
  return { agentSlugA: a, agentSlugB: b, topic: normalizedTopic, interactions: existing.interactions + 1, affinityScore: score };
}

// Cold-start (no/insufficient history) returns neutral so unproven pairs still
// get a fair chance instead of being starved from the first interaction.
function getAffinity(slugA, slugB, topic = 'general') {
  if (!slugA || !slugB || slugA === slugB) return { affinityScore: 0, interactions: 0, confident: false };
  const [a, b] = orderedPair(slugA, slugB);
  const row = getPairStmt.get(a, b, String(topic || 'general').toLowerCase());
  if (!row) return { affinityScore: 0, interactions: 0, confident: false };
  return {
    affinityScore: row.affinity_score,
    interactions: row.interactions,
    confident: row.interactions >= MIN_SAMPLES_FOR_CONFIDENCE,
  };
}

module.exports = {
  MIN_SAMPLES_FOR_CONFIDENCE,
  recordChallengeOutcome,
  getAffinity,
};
