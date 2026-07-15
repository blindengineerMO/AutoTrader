const ollamaClient = require('./ollamaClient');
const { config } = require('../config');
const logger = require('../utils/logger');

const SYSTEM_PROMPT = `You are the reasoning brain for an autonomous market-research system.
You are given compact snapshots of the data sources the system just pulled (news, macro, energy,
disasters, weather, humanitarian, business-formation, screeners, etc.) plus recent headlines.

Read across ALL of it and reason about second-order investment implications, then propose the most
valuable follow-up web-search questions the crawler should run next to enrich the investment database.
Prefer questions that connect a real-world signal to specific companies or sectors (e.g. a conflict to
defense/energy suppliers, a drought to agricultural producers, a rate move to housing lenders).

Return only JSON of this shape:
{
  "reasoning": "short synthesis of the strongest cross-source signals",
  "questions": ["concrete google-style search question", "..."]
}`;

function compact(value, max = 1200) {
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return '';
  }
}

// Uses the local Ollama LLM to read the just-collected data-source snapshots and
// reason out the highest-signal follow-up crawl questions. Local + free, so it
// runs by default; skips gracefully (returns []) whenever Ollama is unreachable
// or disabled, mirroring chatResearchService's provider short-circuit.
async function reasonFollowUpQuestions({ sources = {}, news = { items: [] }, maxQuestions = 8, onEvent = () => {} } = {}) {
  if (!config.ollamaResearchReasoningEnabled) return { reasoning: '', questions: [] };

  const payload = {
    task: 'From these data-source snapshots and headlines, name the highest-signal follow-up web-search questions.',
    headlines: (news.items || []).slice(0, 12).map((item) => item.title).filter(Boolean),
    sources: Object.fromEntries(
      Object.entries(sources)
        .filter(([, value]) => value)
        .map(([key, value]) => [key, compact(value.compact || value)])
    ),
  };

  try {
    const result = await ollamaClient.askOllamaJson({ systemPrompt: SYSTEM_PROMPT, payload });
    const questions = normalizeQuestions(result?.questions).slice(0, maxQuestions);
    emit(onEvent, 'research-reasoning', 20, 'debug', 'Ollama reasoned follow-up research questions from data-source snapshots.', {
      questions: questions.length,
    });
    return { reasoning: cleanText(result?.reasoning).slice(0, 500), questions };
  } catch (err) {
    emit(onEvent, 'research-reasoning', 20, 'debug', 'Ollama research reasoning unavailable; continuing without LLM-generated questions.', {
      error: err.message,
    });
    return { reasoning: '', questions: [] };
  }
}

function normalizeQuestions(value) {
  const items = Array.isArray(value) ? value : [value].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = cleanText(item).slice(0, 200);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = { reasonFollowUpQuestions, normalizeQuestions };
