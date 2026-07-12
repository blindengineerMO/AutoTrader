const { z } = require('zod');

const utcTimestamp = z.string().min(10);
const symbol = z.string().trim().toUpperCase().regex(/^[A-Z.]{1,7}$/);

const securityContract = z.object({
  symbol,
  permanentId: z.string().min(1),
  exchange: z.string().min(1).default('UNKNOWN'),
  securityType: z.enum(['common_stock', 'etf', 'preferred', 'adr', 'other']).default('common_stock'),
  listingDate: z.string().nullable().optional(),
  delistingDate: z.string().nullable().optional(),
  sector: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  marketCapUsd: z.number().nonnegative().nullable().optional(),
  sharesOutstanding: z.number().nonnegative().nullable().optional(),
  isActive: z.boolean().default(true),
  isTradeable: z.boolean().default(true),
  exclusionReason: z.string().nullable().optional(),
});

const pointInTimeBarContract = z.object({
  symbol,
  barDate: z.string().min(10),
  openUnadjusted: z.number().positive().nullable().optional(),
  highUnadjusted: z.number().positive().nullable().optional(),
  lowUnadjusted: z.number().positive().nullable().optional(),
  closeUnadjusted: z.number().positive(),
  closeAdjusted: z.number().positive().optional(),
  volume: z.number().nonnegative().nullable().optional(),
  bid: z.number().positive().nullable().optional(),
  ask: z.number().positive().nullable().optional(),
  dataSource: z.string().min(1),
  asOf: utcTimestamp,
  availableAt: utcTimestamp,
  revisionVersion: z.number().int().positive().default(1),
  sourceRawId: z.number().int().positive().nullable().optional(),
});

const textFactContract = z.object({
  symbol,
  document_id: z.string().min(1),
  published_at: utcTimestamp,
  event_type: z.string().min(1),
  sentiment: z.number().min(-1).max(1),
  uncertainty: z.number().min(0).max(1),
  financial_impact: z.number().min(-1).max(1),
  time_horizon_days: z.number().int().nonnegative(),
  facts: z.array(z.string()).default([]),
  citations: z.array(z.string().url()).min(1),
  confidence: z.number().min(0).max(1),
});

const featureRowContract = z.object({
  symbol,
  asOf: utcTimestamp,
  availableAt: utcTimestamp,
  features: z.object({
    valueScore: z.number().min(0).max(1),
    qualityScore: z.number().min(0).max(1),
    momentumScore: z.number().min(0).max(1),
    riskScore: z.number().min(0).max(1),
    liquidityScore: z.number().min(0).max(1),
    compositeScore: z.number().min(0).max(1),
    expectedExcessReturn: z.number(),
    expectedVolatility: z.number().min(0),
    downsideProbability: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    reasonCodes: z.array(z.string()),
  }),
});

const portfolioItemContract = z.object({
  symbol,
  current_weight: z.number().min(0).max(1),
  target_weight: z.number().min(0).max(1),
  expected_excess_return: z.number(),
  expected_volatility: z.number().min(0),
  downside_probability: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reason_codes: z.array(z.string()),
});

const riskCheckContract = z.object({
  symbol: symbol.nullable().optional(),
  checkName: z.string().min(1),
  status: z.enum(['pass', 'warn', 'fail']),
  severity: z.enum(['info', 'warning', 'critical']),
  reason: z.string().min(1),
  details: z.record(z.any()).default({}),
});

const safeResearchMvpOutputContract = z.object({
  run_id: z.string().min(1),
  generated_at: utcTimestamp,
  model_version: z.string().min(1),
  dataset_version: z.string().min(1),
  strategy_version: z.string().min(1),
  market_regime: z.string().min(1),
  portfolio: z.array(portfolioItemContract),
  risk_checks: z.array(riskCheckContract),
  rejected_trades: z.array(z.object({
    symbol,
    side: z.enum(['buy', 'sell']),
    reason: z.string(),
    failed_checks: z.array(z.string()),
  })),
  warnings: z.array(z.string()),
});

module.exports = {
  securityContract,
  pointInTimeBarContract,
  textFactContract,
  featureRowContract,
  portfolioItemContract,
  riskCheckContract,
  safeResearchMvpOutputContract,
};
