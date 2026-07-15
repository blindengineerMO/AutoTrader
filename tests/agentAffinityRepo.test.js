const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-agent-affinity.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const agentAffinityRepo = require('../src/db/repositories/agentAffinityRepo');

describe('agentAffinityRepo', () => {
  it('returns a neutral, unconfident affinity for an unseen pair', () => {
    const affinity = agentAffinityRepo.getAffinity('bill-gates', 'elon-musk', 'ai');
    expect(affinity).toMatchObject({ affinityScore: 0, interactions: 0, confident: false });
  });

  it('is symmetric regardless of slug order', () => {
    agentAffinityRepo.recordChallengeOutcome({ slugA: 'bill-gates', slugB: 'elon-musk', topic: 'ai', upheld: true });
    const forward = agentAffinityRepo.getAffinity('bill-gates', 'elon-musk', 'ai');
    const reverse = agentAffinityRepo.getAffinity('elon-musk', 'bill-gates', 'ai');
    expect(reverse).toEqual(forward);
    expect(forward.affinityScore).toBeGreaterThan(0);
  });

  it('increases affinity toward +1 on repeated upheld challenges, with diminishing steps', () => {
    for (let i = 0; i < 10; i += 1) {
      agentAffinityRepo.recordChallengeOutcome({ slugA: 'nancy-pelosi', slugB: 'jeff-bezos', topic: 'software', upheld: true });
    }
    const affinity = agentAffinityRepo.getAffinity('nancy-pelosi', 'jeff-bezos', 'software');
    expect(affinity.interactions).toBe(10);
    expect(affinity.confident).toBe(true);
    expect(affinity.affinityScore).toBeGreaterThan(0.3);
    expect(affinity.affinityScore).toBeLessThan(1);
  });

  it('decreases affinity toward -1 on repeated overruled challenges and becomes confident after enough samples', () => {
    for (let i = 0; i < 6; i += 1) {
      agentAffinityRepo.recordChallengeOutcome({ slugA: 'donald-trump', slugB: 'elon-musk', topic: 'energy', upheld: false });
    }
    const affinity = agentAffinityRepo.getAffinity('donald-trump', 'elon-musk', 'energy');
    expect(affinity.interactions).toBe(6);
    expect(affinity.confident).toBe(true);
    expect(affinity.affinityScore).toBeLessThan(0);
  });

  it('keeps topics independent for the same pair', () => {
    agentAffinityRepo.recordChallengeOutcome({ slugA: 'bill-gates', slugB: 'nancy-pelosi', topic: 'healthcare', upheld: true });
    agentAffinityRepo.recordChallengeOutcome({ slugA: 'bill-gates', slugB: 'nancy-pelosi', topic: 'defense', upheld: false });
    const healthcare = agentAffinityRepo.getAffinity('bill-gates', 'nancy-pelosi', 'healthcare');
    const defense = agentAffinityRepo.getAffinity('bill-gates', 'nancy-pelosi', 'defense');
    expect(healthcare.affinityScore).toBeGreaterThan(0);
    expect(defense.affinityScore).toBeLessThan(0);
  });

  it('ignores self-pairs and missing slugs', () => {
    expect(agentAffinityRepo.recordChallengeOutcome({ slugA: 'bill-gates', slugB: 'bill-gates', upheld: true })).toBeNull();
    expect(agentAffinityRepo.recordChallengeOutcome({ slugA: null, slugB: 'bill-gates', upheld: true })).toBeNull();
    expect(agentAffinityRepo.getAffinity(null, 'bill-gates')).toMatchObject({ affinityScore: 0, interactions: 0, confident: false });
  });
});
