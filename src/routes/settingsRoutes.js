const express = require('express');
const { z } = require('zod');
const settingsRepo = require('../db/repositories/settingsRepo');
const researchSourceRepo = require('../db/repositories/researchSourceRepo');
const rulesEngine = require('../services/rulesEngine');
const providerConfigService = require('../services/providerConfigService');
const sourceLearning = require('../services/researchSourceLearningService');
const scheduler = require('../jobs/scheduler');
const simulationModeService = require('../services/simulationModeService');
const timeSettings = require('../services/timeSettingsService');

const router = express.Router();

const dashboardWidgetSchema = z.object({
  i: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const settingsPatchSchema = z.object({
  dailyLossLimitUsd: z.number().positive().optional(),
  maxTradesPerSymbolPer24h: z.number().int().positive().max(10).optional(),
  dayTradingEnabled: z.boolean().optional(),
  researchCadenceCron: z.string().optional(),
  evaluationCadenceCron: z.string().optional(),
  sourceLearningEnabled: z.boolean().optional(),
  tradingEnabled: z.boolean().optional(),
  watcherCycleCadenceCron: z.string().optional(),
  watcherGradingCadenceCron: z.string().optional(),
  applicationTimezone: z.string().refine(timeSettings.isValidTimeZone, 'Invalid timezone').optional(),
  tradingStartTime: z.string().refine(timeSettings.isValidTime, 'Trading start time must be HH:mm').optional(),
  tradingEndTime: z.string().refine(timeSettings.isValidTime, 'Trading end time must be HH:mm').optional(),
  simulationModeEnabled: z.boolean().optional(),
  simulationStartingCashUsd: z.number().positive().max(100000000).optional(),
  fractionalTradingEnabled: z.boolean().optional(),
  fractionalMinNotionalUsd: z.number().positive().max(1000000).optional(),
  maxBuyOrderNotionalUsd: z.number().positive().max(100000000).optional(),
  alpacaStatementDownloadDay: z.number().int().min(1).max(28).optional(),
  investingMode: z.enum(['aggressive', 'balanced', 'conservative']).optional(),
  councilSizingEnabled: z.boolean().optional(),
  agentPersonalityRefreshEnabled: z.boolean().optional(),
  agentPersonalityRefreshTime: z.string().refine(timeSettings.isValidTime, 'Agent refresh time must be HH:mm').optional(),
  personalityTickCadenceCron: z.string().optional(),
  agentLocalLearningEnabled: z.boolean().optional(),
  excludedSymbols: z.array(z.object({
    symbol: z.string().min(1).max(16),
    companyName: z.string().max(200).optional(),
    reason: z.string().max(500).optional(),
    source: z.string().max(120).optional(),
    addedAt: z.string().max(80).optional(),
    assetStatus: z.string().max(80).optional(),
    exchange: z.string().max(80).optional(),
  })).optional(),
  dashboardLayout: z.union([
    z.object({
      dashboardVersion: z.number().int().positive().optional(),
      dashboard: z.array(dashboardWidgetSchema),
    }),
    z.record(z.array(dashboardWidgetSchema)),
  ]).optional(),
});

const excludedSymbolSchema = z.object({
  symbol: z.string().min(1).max(16),
  companyName: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
  source: z.string().max(120).optional(),
  assetStatus: z.string().max(80).optional(),
  exchange: z.string().max(80).optional(),
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
  res.json(providerConfigService.listProviders(req.user.id, { isAdmin: req.user.isAdmin }));
});

router.get('/research-sources', (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  sourceLearning.seedSources(req.user.id);
  const parsed = sourceQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid source query' });
  res.json(researchSourceRepo.queryByUser(req.user.id, parsed.data));
});

router.post('/research-sources', (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
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
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  const parsed = sourceSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid source' });
  const source = researchSourceRepo.update(req.user.id, Number(req.params.id), parsed.data);
  if (!source) return res.status(404).json({ error: 'Research source not found' });
  res.json(source);
});

router.put('/providers/:providerKey', (req, res) => {
  try {
    const fields = req.body?.fields && typeof req.body.fields === 'object' ? req.body.fields : {};
    res.json(providerConfigService.saveProvider(req.user.id, req.params.providerKey, fields, { isAdmin: req.user.isAdmin }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/', (req, res) => {
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
  const before = settingsRepo.get(req.user.id);
  const patch = { ...parsed.data };
  if (patch.tradingEnabled !== undefined) patch.tradingEnabled = patch.tradingEnabled ? 1 : 0;
  if (patch.dayTradingEnabled !== undefined) patch.dayTradingEnabled = patch.dayTradingEnabled ? 1 : 0;
  if (patch.sourceLearningEnabled !== undefined) patch.sourceLearningEnabled = patch.sourceLearningEnabled ? 1 : 0;
  if (patch.simulationModeEnabled !== undefined) patch.simulationModeEnabled = patch.simulationModeEnabled ? 1 : 0;
  if (patch.fractionalTradingEnabled !== undefined) patch.fractionalTradingEnabled = patch.fractionalTradingEnabled ? 1 : 0;
  if (patch.agentPersonalityRefreshEnabled !== undefined) patch.agentPersonalityRefreshEnabled = patch.agentPersonalityRefreshEnabled ? 1 : 0;
  if (patch.agentLocalLearningEnabled !== undefined) patch.agentLocalLearningEnabled = patch.agentLocalLearningEnabled ? 1 : 0;
  if (patch.councilSizingEnabled !== undefined) patch.councilSizingEnabled = patch.councilSizingEnabled ? 1 : 0;
  if (patch.excludedSymbols !== undefined) {
    patch.excludedSymbolsJson = JSON.stringify(patch.excludedSymbols);
    delete patch.excludedSymbols;
  }
  if (patch.dashboardLayout !== undefined) {
    patch.dashboardLayoutJson = JSON.stringify(patch.dashboardLayout);
    delete patch.dashboardLayout;
  }
  const updated = settingsRepo.update(req.user.id, patch);
  let finalSettings = updated;
  if (patch.simulationModeEnabled === 1 && !before?.simulation_mode_enabled) {
    finalSettings = simulationModeService.startSimulation(req.user.id, updated);
  } else if (patch.simulationModeEnabled === 0 && before?.simulation_mode_enabled) {
    finalSettings = simulationModeService.stopSimulation(req.user.id);
  }
  scheduler.scheduleUserAutomation(req.user.id, finalSettings);
  res.json(finalSettings);
});

router.post('/excluded-symbols', (req, res) => {
  const parsed = excludedSymbolSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid symbol' });
  res.status(201).json(settingsRepo.addExcludedSymbol(req.user.id, {
    ...parsed.data,
    source: parsed.data.source || 'manual-settings',
    reason: parsed.data.reason || 'Manually excluded in Settings.',
  }));
});

router.delete('/excluded-symbols/:symbol', (req, res) => {
  res.json(settingsRepo.removeExcludedSymbol(req.user.id, req.params.symbol));
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
