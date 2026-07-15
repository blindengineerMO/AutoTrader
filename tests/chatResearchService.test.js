const chatResearch = require('../src/services/chatResearchService');
const autonomousResearch = require('../src/services/autonomousResearchService');
const duckAiWebClient = require('../src/services/duckAiWebClient');
const ollamaClient = require('../src/services/ollamaClient');
const { config } = require('../src/config');

describe('chatResearchService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ollamaClient.clearOllamaModelCache();
    config.chatResearchPreferOllama = true;
    config.chatResearchExternalFallbackEnabled = false;
    config.ollamaTimeoutMs = 300000;
    config.ollamaMaxPromptTokens = 4096;
    config.ollamaNumPredict = 1400;
    config.ollamaThink = false;
    config.duckAiResearch.enabled = false;
    config.duckAiResearch.browserEnabled = true;
  });

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

  it('normalizes an article comprehension provider result', () => {
    const normalized = chatResearch.normalizeArticleComprehensionResult(
      { provider: 'xai-grok' },
      {
        reasoning: 'War raises demand for military hardware manufacturers.',
        inferredCompanies: [
          { name: 'Lockheed Martin', symbol: 'lmt', reason: 'Defense contractor benefiting from conflict.' },
          { name: '', symbol: 'BAD', reason: 'dropped because no name' },
        ],
        followUpQueries: ['"Lockheed Martin" defense contract award', '  ', ''],
      }
    );

    expect(normalized.provider).toBe('xai-grok');
    expect(normalized.inferredCompanies).toHaveLength(1);
    expect(normalized.inferredCompanies[0]).toMatchObject({ name: 'Lockheed Martin', symbol: 'LMT' });
    expect(normalized.followUpQueries).toEqual(['"Lockheed Martin" defense contract award']);
  });

  it('repairs malformed Ollama JSON during article comprehension', async () => {
    config.duckAiResearch.enabled = false;
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const target = String(url);
      if (target.endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'llama3.1', model: 'llama3.1', capabilities: ['completion'] }] });
      }
      if (target.endsWith('/api/chat')) {
        return jsonResponse({
          message: {
            content: `{
              "reasoning": "CNBC says "India inflation" moved lower and oil remains the key watch item.",
              "inferredCompanies": [
                { "name": "Exxon Mobil", "symbol": "XOM", "reason": "Large energy exposure may be sensitive to oil availability and price changes." }
              ],
              "followUpQueries": ["Exxon Mobil India oil inflation earnings exposure"]
            }

            Local note: verify against crawled evidence.`,
          },
        });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const result = await chatResearch.runArticleComprehension({
      article: {
        title: 'India inflation cools as oil risk remains',
        url: 'https://www.cnbc.com/2026/07/13/india-june-inflation-oil-food-iran-war.html',
        excerpt: 'India inflation cooled, while oil and food prices remain important risks.',
      },
      onEvent: () => {},
    });

    expect(result.provider).toBe('ollama');
    expect(result.reasoning).toContain('India inflation');
    expect(result.inferredCompanies[0]).toMatchObject({ name: 'Exxon Mobil', symbol: 'XOM' });
    expect(result.followUpQueries).toEqual(['Exxon Mobil India oil inflation earnings exposure']);
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

  it('adds Ollama as a local interpretation chat provider', () => {
    config.duckAiResearch.browserEnabled = false;
    const providers = chatResearch.buildProviders(null);
    const ollama = providers.find((provider) => provider.provider === 'ollama');

    expect(ollama).toBeTruthy();
    expect(ollama.role).toBe('local-interpretation');
    expect(providers[0].provider).toBe('ollama');
  });

  it('uses Ollama to interpret crawled research into structured hints', async () => {
    config.duckAiResearch.browserEnabled = false;
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'llama3.1', model: 'llama3.1' }] });
      if (target.endsWith('/api/chat')) {
        const body = JSON.parse(options.body);
        expect(body.format).toBe('json');
        expect(body.think).toBe(false);
        expect(body.options.num_predict).toBe(1400);
        return jsonResponse({
          message: {
            content: JSON.stringify({
              summary: 'Local model connected defense news to contractors.',
              candidateHints: [
                {
                  symbol: 'LMT',
                  companyName: 'Lockheed Martin',
                  reason: 'Defense budget article implies contractor demand.',
                  confidence: 0.72,
                  sourceUrls: ['https://example.com/defense-budget'],
                },
              ],
              sourceHints: [],
              riskNotes: ['Local models depend on supplied crawl evidence for freshness.'],
            }),
          },
        });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const result = await chatResearch.runChatResearch({
      news: { items: [{ title: 'Defense spending rises', description: 'Contracts may expand.', source: 'test' }] },
      learned: { observations: [], learnedSources: [] },
      macro: { riskBias: 'mixed', indicators: [] },
      consumer: { consumerBias: 'neutral', reports: [] },
      jsonDatasets: { compositeRiskScore: 50, opportunityScore: 50 },
      discoveredCompanies: [],
      onEvent: () => {},
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"format":"json"'),
      })
    );
    expect(result.providers.some((provider) => provider.provider === 'ollama' && provider.available)).toBe(true);
    expect(result.candidateHints[0]).toMatchObject({ symbol: 'LMT', companyName: 'Lockheed Martin' });
    expect(result.riskNotes).toContain('local models depend on supplied crawl evidence for freshness.');
  });

  it('uses Ollama first and does not call Duck.ai when local research succeeds', async () => {
    config.duckAiResearch.enabled = true;
    config.duckAiResearch.browserEnabled = true;
    const duckSpy = vi.spyOn(duckAiWebClient, 'askDuckAiWeb').mockRejectedValue(new Error('Duck.ai should not be called'));
    const events = [];
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'deepseek-r1:latest', model: 'deepseek-r1:latest' }] });
      }
      if (target.endsWith('/api/chat')) {
        const body = JSON.parse(options.body);
        if (body.tools?.length) {
          return jsonResponse({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'read_research_url',
                    arguments: { url: 'https://example.com/article', reason: 'Need deeper product-launch evidence.' },
                  },
                },
              ],
            },
          });
        }
        return jsonResponse({
          message: {
            content: JSON.stringify({
              summary: 'Local Ollama read the article and found a public company lead.',
              candidateHints: [
                {
                  symbol: 'NVDA',
                  companyName: 'NVIDIA',
                  reason: 'Article evidence connected AI infrastructure demand to GPUs.',
                  confidence: 0.8,
                  sourceUrls: ['https://example.com/article'],
                },
              ],
              sourceHints: [
                {
                  url: 'https://example.com/article',
                  title: 'AI infrastructure product launch',
                  reason: 'Ollama requested this page to verify the research implication.',
                  tags: ['ai', 'product'],
                },
              ],
              riskNotes: ['Local Ollama relied on tool-fetched page evidence.'],
            }),
          },
        });
      }
      if (target === 'https://example.com/article') {
        return {
          ok: true,
          text: async () => '<html><head><title>AI infrastructure product launch</title></head><body>NVIDIA GPUs support new AI clusters.</body></html>',
        };
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const result = await chatResearch.runChatResearch({
      news: { items: [{ title: 'AI infrastructure demand rises', description: 'Cloud capex is expanding.', source: 'test' }] },
      learned: { observations: [{ title: 'AI launch', url: 'https://example.com/article', excerpt: 'GPU demand may rise.' }], learnedSources: [] },
      macro: { riskBias: 'mixed', indicators: [] },
      consumer: { consumerBias: 'neutral', reports: [] },
      jsonDatasets: { compositeRiskScore: 50, opportunityScore: 50 },
      discoveredCompanies: [],
      onEvent: (event) => events.push(event),
    });

    expect(duckSpy).not.toHaveBeenCalled();
    expect(result.providers.find((provider) => provider.provider === 'duck-ai')).toBeUndefined();
    expect(result.providers.find((provider) => provider.provider === 'ollama')).toMatchObject({ available: true });
    expect(result.candidateHints[0]).toMatchObject({ symbol: 'NVDA', companyName: 'NVIDIA' });
    expect(events.some((event) => event.message.includes('Using local Ollama research agent'))).toBe(true);
    expect(events.some((event) => event.message.includes('skipping external chat providers'))).toBe(true);
    expect(events.some((event) => event.phase === 'ollama-tool' && event.data?.tool === 'read_research_url')).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/article', expect.objectContaining({ headers: expect.any(Object) }));
  });

  it('keeps local Ollama research active when the installed model does not support tools', async () => {
    config.duckAiResearch.enabled = true;
    config.duckAiResearch.browserEnabled = true;
    const duckSpy = vi.spyOn(duckAiWebClient, 'askDuckAiWeb').mockRejectedValue(new Error('Duck.ai should not be called'));
    const chatBodies = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              name: 'deepseek-r1:latest',
              model: 'deepseek-r1:latest',
              capabilities: ['completion', 'thinking'],
            },
          ],
        });
      }
      if (target.endsWith('/api/chat')) {
        const body = JSON.parse(options.body);
        chatBodies.push(body);
        return jsonResponse({
          message: {
            content: JSON.stringify({
              summary: 'Local model synthesized supplied evidence without tools.',
              candidateHints: [
                {
                  symbol: 'MSFT',
                  companyName: 'Microsoft',
                  reason: 'Cloud demand evidence supports follow-up research.',
                  confidence: 0.7,
                  sourceUrls: ['https://example.com/cloud'],
                },
              ],
              sourceHints: [],
              riskNotes: ['Tool calling was unavailable for this installed model.'],
            }),
          },
        });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const result = await chatResearch.runChatResearch({
      news: { items: [{ title: 'Cloud spending rises', description: 'Enterprise demand expands.', source: 'test' }] },
      learned: { observations: [{ title: 'Cloud demand', url: 'https://example.com/cloud', excerpt: 'Demand expanding.' }], learnedSources: [] },
      macro: { riskBias: 'mixed', indicators: [] },
      consumer: { consumerBias: 'neutral', reports: [] },
      jsonDatasets: { compositeRiskScore: 50, opportunityScore: 50 },
      discoveredCompanies: [],
      onEvent: () => {},
    });

    expect(duckSpy).not.toHaveBeenCalled();
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0].model).toBe('deepseek-r1:latest');
    expect(chatBodies[0].tools).toBeUndefined();
    expect(chatBodies[0].think).toBe(false);
    expect(chatBodies[0].options.num_predict).toBe(1400);
    expect(result.providers.find((provider) => provider.provider === 'ollama')).toMatchObject({ available: true });
    expect(result.candidateHints[0]).toMatchObject({ symbol: 'MSFT', companyName: 'Microsoft' });
  });

  it('splits oversized crawler evidence into sub-4096-token local Ollama questions for no-tool models', async () => {
    config.ollamaMaxPromptTokens = 1400;
    config.duckAiResearch.enabled = true;
    config.duckAiResearch.browserEnabled = true;
    const duckSpy = vi.spyOn(duckAiWebClient, 'askDuckAiWeb').mockRejectedValue(new Error('Duck.ai should not be called'));
    const events = [];
    const chatBodies = [];
    const longExcerpt = [
      'Acme Robotics announced a new warehouse automation platform that may increase semiconductor and cloud infrastructure demand.',
      'The crawled page mentions Microsoft Azure integrations, NVIDIA GPU acceleration, and public-company supply chain opportunities.',
    ].join(' ').repeat(90);

    vi.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith('/api/tags')) {
        return jsonResponse({
          models: [{ name: 'deepseek-r1:latest', model: 'deepseek-r1:latest', capabilities: ['completion', 'thinking'] }],
        });
      }
      if (target.endsWith('/api/chat')) {
        const body = JSON.parse(options.body);
        chatBodies.push(body);
        const chunkIndex = body.messages
          .map((message) => message.content || '')
          .join(' ')
          .match(/"chunkIndex":(\d+)/)?.[1] || String(chatBodies.length);
        return jsonResponse({
          message: {
            content: JSON.stringify({
              summary: `Chunk ${chunkIndex} found local evidence.`,
              candidateHints: [
                {
                  symbol: chunkIndex === '1' ? 'MSFT' : 'NVDA',
                  companyName: chunkIndex === '1' ? 'Microsoft' : 'NVIDIA',
                  reason: `Crawler chunk ${chunkIndex} included product and infrastructure evidence.`,
                  confidence: 0.65,
                  sourceUrls: [`https://example.com/research#chunk-${chunkIndex}`],
                },
              ],
              sourceHints: [],
              riskNotes: [`Chunk ${chunkIndex} was analyzed without model tool support.`],
            }),
          },
        });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const result = await chatResearch.runChatResearch({
      news: { items: [] },
      learned: {
        observations: [
          {
            title: 'Warehouse automation launch',
            url: 'https://example.com/research',
            excerpt: longExcerpt,
            links: [{ text: 'Investor relations', url: 'https://example.com/ir' }],
          },
        ],
        learnedSources: [],
      },
      macro: { riskBias: 'mixed', indicators: [] },
      consumer: { consumerBias: 'neutral', reports: [] },
      jsonDatasets: { compositeRiskScore: 50, opportunityScore: 50 },
      discoveredCompanies: [],
      onEvent: (event) => events.push(event),
    });

    expect(duckSpy).not.toHaveBeenCalled();
    expect(chatBodies.length).toBeGreaterThan(1);
    for (const body of chatBodies) {
      const promptText = body.messages.map((message) => message.content || '').join('\n');
      expect(Math.ceil(promptText.length / 4)).toBeLessThanOrEqual(1400);
      expect(body.tools).toBeUndefined();
      expect(promptText).toContain('crawled-page');
      expect(promptText).toContain('Warehouse automation launch');
    }
    expect(events.some((event) => event.phase === 'ollama-chunking')).toBe(true);
    expect(result.candidateHints.map((hint) => hint.symbol)).toEqual(expect.arrayContaining(['MSFT', 'NVDA']));
    expect(result.riskNotes.length).toBeGreaterThan(1);
  });

  it('does not fall through to Duck.ai when local-first Ollama research fails', async () => {
    config.duckAiResearch.enabled = true;
    config.duckAiResearch.browserEnabled = true;
    config.ollamaTimeoutMs = 1;
    const duckSpy = vi.spyOn(duckAiWebClient, 'askDuckAiWeb').mockRejectedValue(new Error('Duck.ai should not be called'));
    const events = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const target = String(url);
      if (target.endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'deepseek-r1:latest', model: 'deepseek-r1:latest', capabilities: ['completion'] }] });
      }
      if (target.endsWith('/api/chat')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse({ message: { content: '{}' } });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const result = await chatResearch.runChatResearch({
      news: { items: [{ title: 'Local model timeout test', description: 'Should not fall through.', source: 'test' }] },
      learned: { observations: [], learnedSources: [] },
      macro: { riskBias: 'mixed', indicators: [] },
      consumer: { consumerBias: 'neutral', reports: [] },
      jsonDatasets: { compositeRiskScore: 50, opportunityScore: 50 },
      discoveredCompanies: [],
      onEvent: (event) => events.push(event),
    });

    expect(duckSpy).not.toHaveBeenCalled();
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({ provider: 'ollama', available: false });
    expect(events.some((event) => event.message.includes('external chat fallback is disabled'))).toBe(true);
  });

  it('normalizes Ollama base URLs for native and OpenAI-compatible APIs', () => {
    expect(ollamaClient.buildOllamaApiUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/api/chat');
    expect(ollamaClient.buildOllamaHost('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(ollamaClient.buildOllamaOpenAiBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
  });

  it('falls back to the first installed Ollama model when the configured one is missing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({
      models: [{ name: 'deepseek-r1:latest', model: 'deepseek-r1:latest' }],
    }));

    await expect(
      ollamaClient.resolveOllamaModel({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' })
    ).resolves.toBe('deepseek-r1:latest');
  });
});

function jsonResponse(data) {
  return {
    ok: true,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}
