const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-ollama-client.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const { config } = require('../src/config');
const ollamaClient = require('../src/services/ollamaClient');

describe('ollamaClient context-budget guards', () => {
  const originalMaxPromptTokens = config.ollamaMaxPromptTokens;
  const originalNumPredict = config.ollamaNumPredict;

  afterEach(() => {
    config.ollamaMaxPromptTokens = originalMaxPromptTokens;
    config.ollamaNumPredict = originalNumPredict;
  });

  it('always sets num_ctx from config.ollamaMaxPromptTokens so Ollama does not silently fall back to a smaller default', () => {
    config.ollamaMaxPromptTokens = 4096;
    const options = ollamaClient.buildOllamaOptions(0.2);
    expect(options.num_ctx).toBe(4096);
  });

  it('floors num_ctx at 512 even if ollamaMaxPromptTokens is misconfigured to something tiny', () => {
    config.ollamaMaxPromptTokens = 100;
    expect(ollamaClient.buildOllamaOptions(0.2).num_ctx).toBe(512);
  });

  it('leaves a tool-call conversation untouched when it already fits the budget', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'calling a tool', tool_calls: [] },
      { role: 'tool', tool_name: 'search', content: 'short result' },
    ];
    const before = JSON.stringify(messages);
    ollamaClient.trimOllamaMessagesToBudget(messages, 10000);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('shrinks the oldest tool-result message first when the conversation exceeds the token budget', () => {
    const bigResult = 'x'.repeat(4000);
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'tool', tool_name: 'search', content: bigResult },
      { role: 'tool', tool_name: 'fetch', content: 'small' },
    ];
    ollamaClient.trimOllamaMessagesToBudget(messages, 50);
    const totalChars = messages.reduce((sum, m) => sum + String(m.content || '').length, 0);
    expect(totalChars).toBeLessThan(bigResult.length + 5);
    expect(messages[0].content).toBe('sys');
    expect(messages[1].content).toBe('task');
  });

  it('drops an oldest tool message entirely once it has been shrunk below the useful floor', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'tool', tool_name: 'search', content: 'tiny' },
      { role: 'tool', tool_name: 'fetch', content: 'y'.repeat(2000) },
    ];
    ollamaClient.trimOllamaMessagesToBudget(messages, 1);
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages.find((m) => m.tool_name === 'search')).toBeUndefined();
  });

  it('never removes the system/user messages while trimming tool history', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'tool', tool_name: 'a', content: 'a'.repeat(3000) },
      { role: 'tool', tool_name: 'b', content: 'b'.repeat(3000) },
      { role: 'tool', tool_name: 'c', content: 'c'.repeat(3000) },
    ];
    ollamaClient.trimOllamaMessagesToBudget(messages, 1);
    expect(messages.some((m) => m.role === 'system')).toBe(true);
    expect(messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('computes a tool-prompt budget that reserves room for num_predict and a safety margin', () => {
    config.ollamaMaxPromptTokens = 4096;
    config.ollamaNumPredict = 1400;
    const budget = ollamaClient.ollamaToolPromptBudgetTokens();
    expect(budget).toBe(4096 - 1400 - 300);
  });

  it('leaves a small payload untouched when it already fits the budget', () => {
    config.ollamaMaxPromptTokens = 4096;
    config.ollamaNumPredict = 0;
    const payload = { task: 'short', headlines: ['a', 'b'] };
    const text = ollamaClient.truncatePayloadToBudget('sys prompt', payload);
    expect(text).toBe(JSON.stringify(payload));
  });

  it('truncates a large multi-source research payload so it stays within the local context budget', () => {
    config.ollamaMaxPromptTokens = 1000;
    config.ollamaNumPredict = 0;
    const bigSource = 'x'.repeat(1200);
    const payload = {
      task: 'reason about follow-up questions',
      headlines: Array.from({ length: 12 }, (_, i) => `headline ${i}`),
      sources: {
        news: bigSource, macro: bigSource, energy: bigSource, disasters: bigSource,
        weather: bigSource, humanitarian: bigSource, businessFormation: bigSource, screeners: bigSource,
      },
    };
    const systemPrompt = 'You are the reasoning brain for an autonomous market-research system.';
    const text = ollamaClient.truncatePayloadToBudget(systemPrompt, payload);

    expect(text.length).toBeLessThan(JSON.stringify(payload).length);
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(1000);
    expect(text).toMatch(/\.\.\.\[truncated for local context budget\]$/);
  });
});
