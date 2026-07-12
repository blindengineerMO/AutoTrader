const specRepo = require('../../db/repositories/specResearchRepo');
const { featureRowContract } = require('./interfaceContracts');

const FEATURE_VERSION = 'safe-mvp-features-v2-fundamentals';

function buildFeatureSet({ userId, datasetVersion, bars, securities = [], qualityReport, fundamentalsBySymbol = new Map(), persist = true }) {
  if (qualityReport?.critical || qualityReport?.status === 'fail') {
    if (persist) {
      specRepo.saveFeatureSet({
        userId,
        datasetVersion,
        featureVersion: FEATURE_VERSION,
        status: 'blocked',
        qualityReportId: qualityReport.id,
        metadata: { reason: 'Critical data-quality failure blocked feature generation.' },
        rows: [],
      });
    }
    return { featureVersion: FEATURE_VERSION, status: 'blocked', rows: [], warnings: ['Feature generation blocked by data quality.'] };
  }

  const securityMap = new Map((securities || []).map((item) => [item.symbol, item]));
  const grouped = groupBySymbol(bars || []);
  const rows = [];
  for (const [symbol, symbolBars] of grouped.entries()) {
    const sorted = symbolBars.slice().sort((a, b) => String(a.barDate).localeCompare(String(b.barDate)));
    const latest = sorted.at(-1);
    const prior = sorted.at(-2) || latest;
    const close = Number(latest.closeAdjusted ?? latest.closeUnadjusted);
    const prevClose = Number(prior.closeAdjusted ?? prior.closeUnadjusted);
    const changePct = prevClose ? ((close - prevClose) / prevClose) * 100 : 0;
    const rangePct = close ? ((Number(latest.highUnadjusted || close) - Number(latest.lowUnadjusted || close)) / close) * 100 : 0;
    const volume = Number(latest.volume || 0);
    const spreadPct = latest.bid && latest.ask && close ? ((Number(latest.ask) - Number(latest.bid)) / close) * 100 : null;
    const security = securityMap.get(symbol) || {};

    const momentumScore = clamp01(0.5 + changePct / 20);
    const riskScore = clamp01(1 - rangePct / 15);
    const liquidityScore = clamp01(Math.log10(Math.max(1, volume)) / 8);
    const fundamentals = fundamentalsBySymbol.get(symbol) || null;
    const fundamentalValueScore = computeFundamentalValueScore(fundamentals?.ratios);
    const fundamentalQualityScore = computeFundamentalQualityScore(fundamentals?.ratios);
    const valueScore = fundamentalValueScore ?? clamp01(security.market_cap_usd ? Math.log10(security.market_cap_usd) / 13 : 0.5);
    const qualityScore = fundamentalQualityScore ?? (security.security_type === 'etf' ? 0.72 : security.market_cap_usd && security.market_cap_usd > 2_000_000_000 ? 0.66 : 0.5);
    const spreadPenalty = spreadPct === null ? 0 : Math.min(0.12, spreadPct / 20);
    const compositeScore = clamp01(
      momentumScore * 0.3
      + qualityScore * 0.22
      + valueScore * 0.16
      + liquidityScore * 0.18
      + riskScore * 0.14
      - spreadPenalty
    );
    const expectedVolatility = Math.max(0.01, rangePct / 100);
    const expectedExcessReturn = Number(((compositeScore - 0.5) * 0.08).toFixed(6));
    const downsideProbability = clamp01(0.5 + (0.5 - riskScore) * 0.45 - Math.max(0, changePct) / 80);
    const confidence = clamp01(0.35 + liquidityScore * 0.25 + riskScore * 0.2 + (sorted.length > 1 ? 0.1 : 0));

    rows.push(featureRowContract.parse({
      symbol,
      asOf: latest.asOf,
      availableAt: latest.availableAt,
      features: {
        valueScore: round(valueScore),
        qualityScore: round(qualityScore),
        momentumScore: round(momentumScore),
        riskScore: round(riskScore),
        liquidityScore: round(liquidityScore),
        compositeScore: round(compositeScore),
        expectedExcessReturn,
        expectedVolatility: round(expectedVolatility),
        downsideProbability: round(downsideProbability),
        confidence: round(confidence),
        reasonCodes: buildReasonCodes({ changePct, rangePct, volume, security, spreadPct, fundamentalValueScore, fundamentalQualityScore }),
      },
    }));
  }

  if (persist) {
    specRepo.saveFeatureSet({
      userId,
      datasetVersion,
      featureVersion: FEATURE_VERSION,
      status: 'created',
      qualityReportId: qualityReport?.id || null,
      metadata: { generatedBy: 'deterministic-safe-mvp-feature-engine' },
      rows,
    });
  }

  return { featureVersion: FEATURE_VERSION, status: 'created', rows, warnings: [] };
}

function buildReasonCodes({ changePct, rangePct, volume, security, spreadPct, fundamentalValueScore, fundamentalQualityScore }) {
  const codes = [];
  if (changePct > 1) codes.push('positive_momentum');
  if (changePct < -1) codes.push('negative_momentum');
  if (rangePct > 5) codes.push('high_intraday_range_risk');
  if (volume > 1_000_000) codes.push('liquid_volume_proxy');
  if (security.security_type === 'etf') codes.push('broad_market_etf');
  if (security.market_cap_usd && security.market_cap_usd > 2_000_000_000) codes.push('large_liquid_issuer_proxy');
  if (spreadPct !== null && spreadPct > 0.5) codes.push('wide_spread_penalty');
  codes.push(fundamentalValueScore !== null ? 'sec_edgar_value_score' : 'proxy_value_score');
  codes.push(fundamentalQualityScore !== null ? 'sec_edgar_quality_score' : 'proxy_quality_score');
  return codes.length ? codes : ['baseline_point_in_time_quote'];
}

/**
 * Higher earnings yield and higher book-to-market both indicate a cheaper
 * stock relative to fundamentals. Returns null (not 0.5) when EDGAR has no
 * usable ratios so the caller can fall back to the market-cap heuristic.
 */
function computeFundamentalValueScore(ratios) {
  if (!ratios) return null;
  const parts = [];
  if (Number.isFinite(ratios.earningsYield?.value)) parts.push(clamp01(0.5 + ratios.earningsYield.value * 3));
  if (Number.isFinite(ratios.bookToMarket?.value)) parts.push(clamp01(0.5 + (ratios.bookToMarket.value - 1) * 0.15));
  if (!parts.length) return null;
  return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

/**
 * Higher ROE and operating margin, and lower leverage, indicate a
 * higher-quality business. Returns null when EDGAR has no usable ratios.
 */
function computeFundamentalQualityScore(ratios) {
  if (!ratios) return null;
  const parts = [];
  if (Number.isFinite(ratios.returnOnEquity?.value)) parts.push(clamp01(0.5 + ratios.returnOnEquity.value * 2));
  if (Number.isFinite(ratios.operatingMargin?.value)) parts.push(clamp01(0.5 + ratios.operatingMargin.value * 2));
  if (Number.isFinite(ratios.debtToEquity?.value)) parts.push(clamp01(1 - ratios.debtToEquity.value / 4));
  if (!parts.length) return null;
  return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

function groupBySymbol(bars) {
  const map = new Map();
  for (const bar of bars) {
    const symbol = String(bar.symbol || '').toUpperCase();
    if (!map.has(symbol)) map.set(symbol, []);
    map.get(symbol).push(bar);
  }
  return map;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value) {
  return Number(value.toFixed(6));
}

module.exports = { buildFeatureSet, FEATURE_VERSION };
