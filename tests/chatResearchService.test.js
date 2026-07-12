const chatResearch = require('../src/services/chatResearchService');
const autonomousResearch = require('../src/services/autonomousResearchService');
const duckAiWebClient = require('../src/services/duckAiWebClient');

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

  it('builds Duck.ai web prompts and extracts JSON from webapp text', () => {
    const prompt = duckAiWebClient.buildDuckAiPrompt({
      systemPrompt: 'Return market research JSON.',
      payload: { news: [{ title: 'AI infrastructure demand rises' }] },
    });
    const extracted = duckAiWebClient.extractJsonObject([
      'Duck.ai response',
      '```json',
      '{"summary":"ok","candidateHints":[],"sourceHints":[],"riskNotes":[]}',
      '```',
    ].join('\n'));

    expect(prompt).toContain('Return only the JSON object');
    expect(prompt).toContain('AI infrastructure demand rises');
    expect(JSON.parse(extracted)).toMatchObject({ summary: 'ok' });
    expect(duckAiWebClient.isResearchResultJson(extracted)).toBe(true);
    expect(duckAiWebClient.isResearchResultJson('{"task":"prompt echo","news":[]}')).toBe(false);
    expect(duckAiWebClient.DEFAULT_ALLOWED_HOSTS.has('duck.ai')).toBe(true);
    expect(duckAiWebClient.DEFAULT_ALLOWED_HOSTS.has('duckduckgo.com')).toBe(true);
  });
});
