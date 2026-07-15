const ollamaClient = require('../src/services/ollamaClient');
const { config } = require('../src/config');
const reasoning = require('../src/services/researchQuestionReasoningService');

describe('researchQuestionReasoningService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    config.ollamaResearchReasoningEnabled = true;
  });

  it('asks Ollama for follow-up questions and normalizes/dedupes them', async () => {
    vi.spyOn(ollamaClient, 'askOllamaJson').mockResolvedValue({
      reasoning: 'Conflict raises defense demand.',
      questions: [
        'which companies manufacture military drones',
        'which companies manufacture military drones',
        'defense contractor backlog growth 2026',
      ],
    });

    const result = await reasoning.reasonFollowUpQuestions({
      sources: { disasterContext: { compact: { active: true } } },
      news: { items: [{ title: 'Conflict escalates in the region' }] },
    });

    expect(result.questions).toEqual([
      'which companies manufacture military drones',
      'defense contractor backlog growth 2026',
    ]);
    expect(result.reasoning).toContain('defense demand');
  });

  it('returns no questions and does not call Ollama when disabled', async () => {
    config.ollamaResearchReasoningEnabled = false;
    const spy = vi.spyOn(ollamaClient, 'askOllamaJson').mockResolvedValue({ questions: ['x'] });

    const result = await reasoning.reasonFollowUpQuestions({ news: { items: [] } });

    expect(spy).not.toHaveBeenCalled();
    expect(result.questions).toEqual([]);
  });

  it('degrades gracefully when Ollama is unreachable', async () => {
    vi.spyOn(ollamaClient, 'askOllamaJson').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await reasoning.reasonFollowUpQuestions({ news: { items: [{ title: 'x' }] } });

    expect(result.questions).toEqual([]);
  });
});
