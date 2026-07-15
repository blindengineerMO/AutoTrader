const financialWeights = require('../src/services/financialEventWeightingService');

describe('financialEventWeightingService', () => {
  it('loads the WEIGHT.md event lexicon', () => {
    const lexicon = financialWeights.loadWeightLexicon();
    const terms = lexicon.map((entry) => entry.term);

    expect(terms).toContain('raised guidance');
    expect(terms).toContain('liquidity concern');
    expect(lexicon.length).toBeGreaterThan(150);
  });

  it('scores confirmed company-specific positive financial events above zero', () => {
    const result = financialWeights.scoreCandidateEvidence({
      candidate: { symbol: 'NVDA', companyName: 'NVIDIA' },
      news: {
        items: [{
          title: 'NVIDIA raised guidance above consensus',
          description: 'NVDA reported a revenue beat and margin expansion after demand exceeded expectations.',
          link: 'https://www.sec.gov/Archives/example',
        }],
      },
      learned: { observations: [] },
    });

    expect(result.aggregateScore).toBeGreaterThan(0);
    expect(result.normalized).toBeGreaterThan(0.5);
    expect(result.topEvents.some((event) => event.event.type.includes('raised_guidance'))).toBe(true);
  });

  it('scores confirmed company-specific negative financial events below zero', () => {
    const result = financialWeights.scoreCandidateEvidence({
      candidate: { symbol: 'ACME', companyName: 'Acme Robotics' },
      news: {
        items: [{
          title: 'Acme Robotics warns on liquidity',
          description: 'ACME reported a liquidity concern after guidance reduced below expectations.',
          link: 'https://www.sec.gov/Archives/acme',
        }],
      },
      learned: { observations: [] },
    });

    expect(result.aggregateScore).toBeLessThan(0);
    expect(result.normalized).toBeLessThan(0.5);
    expect(result.topEvents.some((event) => event.event.direction === 'negative')).toBe(true);
  });

  it('does not over-penalize negated negative facts', () => {
    const result = financialWeights.scoreCandidateEvidence({
      candidate: { symbol: 'MSFT', companyName: 'Microsoft' },
      news: {
        items: [{
          title: 'Microsoft filed clean controls update',
          description: 'MSFT reported no internal control weakness and no material weakness was identified.',
          link: 'https://www.sec.gov/Archives/msft',
        }],
      },
      learned: { observations: [] },
    });

    expect(result.aggregateScore).toBeGreaterThanOrEqual(0);
  });

  it('applies learned per-category multipliers to event scores', () => {
    const input = {
      candidate: { symbol: 'NVDA', companyName: 'NVIDIA' },
      news: {
        items: [{
          title: 'NVIDIA raised guidance above consensus',
          description: 'NVDA reported a revenue beat and margin expansion after demand exceeded expectations.',
          link: 'https://www.sec.gov/Archives/example',
        }],
      },
      learned: { observations: [] },
    };

    const baseline = financialWeights.scoreCandidateEvidence(input);
    const guidanceEvent = baseline.topEvents.find((event) => event.event.type.includes('raised_guidance'));
    const halved = financialWeights.scoreCandidateEvidence({
      ...input,
      learnedCategoryMultipliers: { [guidanceEvent.event.category]: 0.5 },
    });
    const halvedEvent = halved.topEvents.find((event) => event.event.type.includes('raised_guidance'));

    expect(halvedEvent.adjustments.learned_category_multiplier).toBe(0.5);
    expect(Math.abs(halvedEvent.final_event_score)).toBeLessThan(Math.abs(guidanceEvent.final_event_score));
    expect(guidanceEvent.adjustments.learned_category_multiplier).toBe(1);
  });
});
