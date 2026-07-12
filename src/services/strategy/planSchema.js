const { z } = require('zod');

const planActionSchema = z.object({
  symbol: z.string().min(1).max(10),
  action: z.enum(['buy', 'sell', 'hold']),
  quantity: z.number().positive().nullable().optional(),
  rationale: z.string().min(1).max(500),
});

const tradingPlanSchema = z.object({
  actions: z.array(planActionSchema).max(10),
  overallRationale: z.string().min(1).max(1000),
});

module.exports = { tradingPlanSchema };
