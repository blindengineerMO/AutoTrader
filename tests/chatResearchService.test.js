const chatResearch = require('../src/services/chatResearchService');
const autonomousResearch = require('../src/services/autonomousResearchService');

describe('chatResearchService', () => {
  it('normalizes candidate and source hints from chat provider JSON', () => {
    const candidates = chatResearch.normalizeCandidateHints([
      {
        symbol: '$NVDA',
        companyName: 'NVIDIA',
        reason: 'AI chip launch deserves follow-up',
        confidence: 0.91,
        sourceUrls: ['https://example.com/markets/ai-chip-launch#section'],
      },
      { symbol: 'TOO-LONG-SYMBOL', reason: 'invalid' },
    ]);
    const sources = chatResearch.normalizeSourceHints([
      {
        url: 'https://example.com/news?x=1#frag',
        title: 'Market news',
        reason: 'Contains primary market context',
        tags: ['Markets', 'AI'],
      },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ symbol: 'NVDA', confidence: 0.91 });
    expect(sources[0].url).toBe('https://example.com/news?x=1');
    expect(sources[0].tags).toEqual(['markets', 'ai']);
  });

  it('lets chat research hints add new candidates to the autonomous pre-plan', () => {
    const prePlan = autonomousResearch.buildPrePlan({
      watchlist: ['SPY'],
      news: { items: [] },
      macro: { riskBias: 'mixed' },
      consumer: { consumerBias: 'neutral' },
      learned: { learnedSources: [], observations: [] },
      jsonDatasets: { compositeRiskScore: 50, opportunityScore: 50 },
      chatResearch: {
        candidateHints: [
          {
            symbol: 'PLTR',
            companyName: 'Palantir',
            confidence: 0.85,
            reasons: ['Defense AI platform news deserves follow-up.'],
            sourceUrls: ['https://example.com/defense-ai'],
            providers: ['xai-grok'],
          },
        ],
        sourceHints: [],
      },
      discoveredCompanies: [],
    });

    const palantir = prePlan.candidates.find((candidate) => candidate.symbol === 'PLTR');
    expect(palantir).toBeTruthy();
    expect(palantir.theme).toBe('chat-research');
    expect(palantir.chatResearch.providers).toEqual(['xai-grok']);
  });
});
