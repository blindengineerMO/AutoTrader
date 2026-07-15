const crypto = require('crypto');
const researchService = require('../researchService');
const brainMesh = require('../brainMeshService');
const brokerAccountRepo = require('../../db/repositories/brokerAccountRepo');
const positionRepo = require('../../db/repositories/positionRepo');
const specRepo = require('../../db/repositories/specResearchRepo');
const dataQuality = require('./dataQualityService');
const featureEngine = require('./featureEngineService');
const fundamentalsIngestion = require('./fundamentalsIngestionService');
const modelRegistry = require('./modelRegistryService');
const portfolioConstructor = require('./portfolioConstructionService');
const riskEngine = require('./riskEngineService');
const { safeResearchMvpOutputContract } = require('./interfaceContracts');

async function runSafeResearchMvp({
  userId,
  watchlist = researchService.DEFAULT_WATCHLIST,
  runResearchCycle = researchService.runResearchCycle,
  now = new Date(),
  onEvent = () => {},
} = {}) {
  const runId = `safe_${crypto.randomUUID()}`;
  const generatedAt = now.toISOString();
  const conversation = brainMesh.startConversation({
    userId,
    topic: 'safe-research-mvp',
    metadata: { runId },
  });
  tell({ userId, runId, conv: conversation.id, op: 'safe_mvp.started', body: { watchlist } });
  emit(onEvent, 'safe-mvp', 2, 'info', 'Starting SPEC safe research MVP.', { runId });
  specRepo.audit({ userId, runId, eventType: 'started', entityType: 'safe_research_mvp', entityId: runId, payload: { watchlist } });

  const snapshot = await runResearchCycle(watchlist, { userId });
  const datasetVersion = `dataset-${snapshot.id}-${generatedAt.slice(0, 10)}`;
  emit(onEvent, 'safe-mvp-data', 20, 'debug', 'Research snapshot collected; normalizing point-in-time rows.', {
    snapshotId: snapshot.id,
    datasetVersion,
  });
  specRepo.audit({ userId, runId, eventType: 'snapshot_collected', entityType: 'research_snapshot', entityId: String(snapshot.id), payload: { datasetVersion } });

  const rawSource = specRepo.saveRawSource({
    userId,
    sourceName: snapshot.source,
    sourceUrl: null,
    observedAt: generatedAt,
    availableAt: generatedAt,
    payload: {
      summary: snapshot.summary,
      signals: snapshot.signals,
    },
  });

  const securities = normalizeSecurities(watchlist);
  for (const security of securities) specRepo.upsertSecurity(userId, security);
  const savedSecurities = specRepo.listSecurities(userId);
  const bars = buildPointInTimeBars({ snapshot, rawSource, now });
  specRepo.saveMarketBars({ userId, bars });
  emit(onEvent, 'safe-mvp-quality', 35, 'debug', 'Running deterministic point-in-time data-quality checks.', { bars: bars.length });
  const qualityReport = dataQuality.validateMarketBars({ userId, datasetVersion, bars, now });
  specRepo.audit({ userId, runId, eventType: 'quality_reported', entityType: 'data_quality_report', entityId: String(qualityReport.id), payload: qualityReport });

  emit(onEvent, 'safe-mvp-fundamentals', 42, 'debug', 'Fetching SEC EDGAR fundamentals for feature enrichment.', {
    symbols: savedSecurities.filter((item) => item.security_type !== 'etf').map((item) => item.symbol),
  });
  const latestPriceBySymbol = buildLatestPriceMap(bars);
  const fundamentalsBySymbol = await fundamentalsIngestion.ingestFundamentalsForSymbols({
    userId,
    symbols: savedSecurities.filter((item) => item.security_type !== 'etf').map((item) => item.symbol),
    pricesBySymbol: latestPriceBySymbol,
  });
  emit(onEvent, 'safe-mvp-fundamentals', 45, 'debug', 'SEC EDGAR fundamentals resolved.', {
    resolvedSymbols: [...fundamentalsBySymbol.keys()],
  });

  emit(onEvent, 'safe-mvp-features', 48, 'debug', 'Building safe MVP factor features.', { status: qualityReport.status });
  const featureSet = featureEngine.buildFeatureSet({
    userId,
    datasetVersion,
    bars,
    securities: savedSecurities,
    qualityReport,
    fundamentalsBySymbol,
  });

  const champion = modelRegistry.ensureSafeMvpChampion(userId);
  emit(onEvent, 'safe-mvp-model', 58, 'debug', 'Resolved approved safe MVP champion model.', {
    modelVersion: champion.model_version,
    status: champion.status,
  });

  const brokerAccount = brokerAccountRepo.ensureDefault(userId);
  const positions = positionRepo.listByUser(userId);
  const accountState = {
    cashUsd: brokerAccount.cash_balance_usd || 0,
    buyingPowerUsd: brokerAccount.buying_power_usd || brokerAccount.cash_balance_usd || 0,
  };
  const portfolioResult = portfolioConstructor.constructLongOnlyPortfolio({
    featureRows: featureSet.rows,
    positions,
    accountState,
  });
  specRepo.savePortfolioTarget({
    userId,
    runId,
    datasetVersion,
    featureVersion: featureSet.featureVersion,
    modelVersion: champion.model_version,
    strategyVersion: portfolioResult.strategyVersion,
    marketRegime: portfolioResult.marketRegime,
    target: portfolioResult.portfolio,
  });
  specRepo.audit({ userId, runId, eventType: 'portfolio_constructed', entityType: 'portfolio_target', entityId: runId, payload: portfolioResult });

  emit(onEvent, 'safe-mvp-risk', 75, 'debug', 'Running independent deterministic risk checks.', {
    targetCount: portfolioResult.portfolio.length,
  });
  const riskResult = riskEngine.validateSafeMvpPortfolio({
    userId,
    runId,
    portfolio: portfolioResult.portfolio,
    securities: savedSecurities,
    modelVersion: champion.model_version,
    datasetVersion,
    accountState,
    now,
  });
  specRepo.saveRiskChecks({ userId, runId, checks: riskResult.checks });
  const paperIntents = riskEngine.buildPaperOrderIntents({
    userId,
    runId,
    portfolio: portfolioResult.portfolio,
    riskResult,
    accountState,
  });
  specRepo.savePaperOrderIntents({ userId, runId, intents: paperIntents });
  specRepo.audit({
    userId,
    runId,
    eventType: 'risk_checked',
    entityType: 'risk_result',
    entityId: runId,
    payload: { allowed: riskResult.allowed, checks: riskResult.checks, rejectedTrades: riskResult.rejectedTrades },
  });

  const output = safeResearchMvpOutputContract.parse({
    run_id: runId,
    generated_at: generatedAt,
    model_version: champion.model_version,
    dataset_version: datasetVersion,
    strategy_version: portfolioResult.strategyVersion,
    market_regime: portfolioResult.marketRegime,
    portfolio: portfolioResult.portfolio,
    risk_checks: riskResult.checks,
    rejected_trades: riskResult.rejectedTrades,
    warnings: [
      ...portfolioResult.warnings,
      ...(qualityReport.warnings || []),
      ...(featureSet.warnings || []),
      'Safe research MVP does not connect to live brokerage.',
    ],
  });
  specRepo.audit({ userId, runId, eventType: 'completed', entityType: 'safe_research_mvp', entityId: runId, payload: output });
  tell({ userId, runId, conv: conversation.id, op: 'safe_mvp.completed', body: { runId, portfolioTargets: output.portfolio.length, rejectedTrades: output.rejected_trades.length } });
  brainMesh.completeConversation(conversation.id, userId, {
    completedBy: 'brain.spec.safe-research',
    completedOp: 'safe_mvp.completed',
    completedAt: new Date().toISOString(),
    runId,
  });
  emit(onEvent, 'safe-mvp-complete', 100, 'info', 'SPEC safe research MVP completed.', {
    runId,
    portfolioTargets: output.portfolio.length,
    riskChecks: output.risk_checks.length,
  });
  return {
    ...output,
    audit_events: specRepo.listAuditEvents(userId, runId),
    paper_order_intents: specRepo.listPaperOrderIntents(userId, runId),
  };
}

function buildPointInTimeBars({ snapshot, rawSource, now }) {
  const today = now.toISOString().slice(0, 10);
  const prior = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const evidenceBySymbol = new Map((snapshot.summary?.evidence || []).map((item) => [item.symbol, item]));
  const bars = [];
  for (const signal of snapshot.signals || []) {
    const evidence = evidenceBySymbol.get(signal.symbol) || {};
    const current = Number(evidence.current || signal.price);
    const prevClose = Number(evidence.prevClose || current);
    bars.push({
      symbol: signal.symbol,
      barDate: prior,
      openUnadjusted: prevClose,
      highUnadjusted: prevClose,
      lowUnadjusted: prevClose,
      closeUnadjusted: prevClose,
      closeAdjusted: prevClose,
      volume: evidence.volume || 0,
      dataSource: snapshot.source,
      sourceRawId: rawSource.id,
      asOf: `${prior}T21:00:00.000Z`,
      availableAt: `${prior}T21:05:00.000Z`,
      revisionVersion: 1,
    });
    bars.push({
      symbol: signal.symbol,
      barDate: today,
      openUnadjusted: Number(evidence.open || prevClose),
      highUnadjusted: Number(evidence.high || current),
      lowUnadjusted: Number(evidence.low || current),
      closeUnadjusted: current,
      closeAdjusted: current,
      volume: evidence.volume || 0,
      dataSource: snapshot.source,
      sourceRawId: rawSource.id,
      asOf: now.toISOString(),
      availableAt: now.toISOString(),
      revisionVersion: 1,
    });
  }
  return bars.filter((bar) => Number.isFinite(bar.closeUnadjusted) && bar.symbol);
}

function buildLatestPriceMap(bars) {
  const bySymbol = new Map();
  for (const bar of bars || []) {
    const symbol = String(bar.symbol || '').toUpperCase();
    const existing = bySymbol.get(symbol);
    if (!existing || String(bar.availableAt) > String(existing.availableAt)) {
      bySymbol.set(symbol, bar);
    }
  }
  const prices = {};
  for (const [symbol, bar] of bySymbol.entries()) {
    prices[symbol] = Number(bar.closeAdjusted ?? bar.closeUnadjusted) || undefined;
  }
  return prices;
}

function normalizeSecurities(watchlist) {
  return [...new Set((watchlist || []).map((symbol) => String(symbol).toUpperCase().replace(/[^A-Z.]/g, '')).filter(Boolean))]
    .map((symbol) => {
      const isEtf = ['SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO'].includes(symbol);
      const exclusionReason = /OTC|PINK/i.test(symbol) ? 'OTC securities are excluded from the safe MVP universe.' : null;
      return {
        symbol,
        permanentId: `AUTO-${symbol}`,
        exchange: 'US-LISTED',
        securityType: isEtf ? 'etf' : 'common_stock',
        sector: isEtf ? 'broad_market' : 'unknown',
        industry: isEtf ? 'broad_market_etf' : 'unknown',
        isActive: true,
        isTradeable: !exclusionReason,
        exclusionReason,
      };
    });
}

function tell({ userId, runId, conv, op, body }) {
  brainMesh.tell({
    from: 'brain.research.source',
    to: ['brain.model.neural', 'brain.reporting', 'brain.evaluation'],
    kind: 'event',
    op,
    conv,
    ctx: { userId, runId, domain: 'research' },
    body,
  });
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = { runSafeResearchMvp, buildPointInTimeBars, normalizeSecurities };
