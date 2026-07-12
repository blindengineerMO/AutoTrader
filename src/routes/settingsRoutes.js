const express = require('express');
const { z } = require('zod');
const settingsRepo = require('../db/repositories/settingsRepo');
const researchSourceRepo = require('../db/repositories/researchSourceRepo');
const rulesEngine = require('../services/rulesEngine');
const providerConfigService = require('../services/providerConfigService');
const sourceLearning = require('../services/researchSourceLearningService');
const scheduler = require('../jobs/scheduler');

const router = express.Router();

const settingsPatchSchema = z.object({
  dailyLossLimitUsd: z.number().positive().optional(),
  maxTradesPerSymbolPer24h: z.number().int().positive().max(10).optional(),
  researchCadenceCron: z.string().optional(),
  evaluationCadenceCron: z.string().optional(),
  sourceLearningEnabled: z.boolean().optional(),
  tradingEnabled: z.boolean().optional(),
});

const sourceSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  sourceType: z.string().optional(),
  status: z.enum(['active', 'paused', 'blocked', 'failed']).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  relevanceScore: z.number().min(0).max(100).optional(),
  credibilityScore: z.number().min(0).max(100).optional(),
});

const sourceQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().max(200).optional(),
  status: z.enum(['', 'active', 'paused', 'blocked', 'failed']).optional(),
  sourceType: z.string().max(50).optional(),
  sortBy: z.enum(['updated_at', 'relevance_score', 'credibility_score', 'failure_count', 'success_count', 'title', 'url', 'status', 'source_type']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

router.get('/', (req, res) => {
  res.json(settingsRepo.get(req.user.id));
});

router.get('/providers', (req, res) => {
  res.json(providerConfigService.listProviders(req.user.id));
});

router.get('/research-sources', (req, res) => {
  sourceLearning.seedSources(req.user.id);
  const parsed = sourceQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid source query' });
  res.json(researchSourceRepo.queryByUser(req.user.id, parsed.data));
});

router.post('/research-sources', (req, res) => {
  const parsed = sourceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid source' });
  const source = researchSourceRepo.upsert({
    userId: req.user.id,
    ...parsed.data,
    sourceType: parsed.data.sourceType || 'manual',
    discoveryMethod: 'manual',
    relevanceScore: parsed.data.relevanceScore ?? 70,
    credibilityScore: parsed.data.credibilityScore ?? 60,
  });
  res.status(201).json(source);
});

router.patch('/research-sources/:id', (req, res) => {
  const parsed = sourceSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid source' });
  const source = researchSourceRepo.update(req.user.id, Number(req.params.id), parsed.data);
  if (!source) return res.status(404).json({ error: 'Research source not found' });
  res.json(source);
});

router.put('/providers/:providerKey', (req, res) => {
  try {
    const fields = req.body?.fields && typeof req.body.fields === 'object' ? req.body.fields : {};
    res.json(providerConfigService.saveProvider(req.user.id, req.params.providerKey, fields));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/', (req, res) => {
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
  const patch = { ...parsed.data };
  if (patch.tradingEnabled !== undefined) patch.tradingEnabled = patch.tradingEnabled ? 1 : 0;
  if (patch.sourceLearningEnabled !== undefined) patch.sourceLearningEnabled = patch.sourceLearningEnabled ? 1 : 0;
  const updated = settingsRepo.update(req.user.id, patch);
  scheduler.scheduleForUser(req.user.id, updated.research_cadence_cron);
  scheduler.scheduleEvaluationForUser(req.user.id, updated.evaluation_cadence_cron || '0 0 * * *');
  res.json(updated);
});

router.post('/kill-switch/engage', (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
  res.json(rulesEngine.engageKillSwitch(req.user.id, 'user', reason));
});

router.post('/kill-switch/release', (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
  res.json(rulesEngine.releaseKillSwitch(req.user.id, 'user', reason));
});

module.exports = router;
