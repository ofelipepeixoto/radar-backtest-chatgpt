import { z } from 'zod';
import { AnalysisWithContextSchema, type AnalysisWithContext } from './report.js';

const decisiveFields = ['period', 'currency', 'startingBalanceStakeUnits', 'timeframe', 'universeSha256',
  'datasetSha256', 'entryFeeRatio', 'exitFeeRatio', 'slippageRatio', 'leverage', 'mode'] as const;
const versionFields = ['producerVersionSha256', 'strategyVersionSha256'] as const;
const reasonFields = [...decisiveFields, ...versionFields, 'consistency', 'arithmetic'] as const;
const ReasonSchema = z.object({
  field: z.enum(reasonFields),
  code: z.enum(['MISSING_LEFT', 'MISSING_RIGHT', 'MISMATCH', 'VARIABLE_LEVERAGE', 'SUMMARY_MISMATCH', 'NUMERIC_RANGE_EXCEEDED']),
  impact: z.enum(['BLOCKS_DIRECT_COMPARISON', 'CAVEAT']),
}).strict();
const DeltasSchema = z.object({
  direction: z.literal('RIGHT_MINUS_LEFT'),
  netProfitStakeUnits: z.number().finite(),
  closedTradeReturnRatio: z.number().finite(),
  tradeCount: z.number().int().min(-10_000).max(10_000),
  winRateRatio: z.number().finite().min(-1).max(1).nullable(),
  profitFactor: z.number().finite().nullable(),
}).strict();
export const ComparisonSchema = z.object({
  schemaVersion: z.literal(1), comparisonVersion: z.literal('declared-context-v1'),
  status: z.enum(['COMPARABLE', 'WITH_CAVEATS', 'NOT_COMPARABLE']),
  historicalDifferencesAllowed: z.boolean(), rankingAllowed: z.literal(false),
  reasons: z.array(ReasonSchema).max(40), directDeltas: DeltasSchema.nullable(),
  contextVerification: z.literal('DECLARATIONS_NOT_INDEPENDENTLY_VERIFIED'),
  limitations: z.tuple([z.literal('HISTORICAL_CLOSED_TRADES_ONLY'), z.literal('NO_MARK_TO_MARKET_OR_DRAWDOWN_RECALCULATION'), z.literal('NO_CAUSAL_ATTRIBUTION_OR_FORECAST'), z.literal('NO_INVESTMENT_RECOMMENDATION')]),
  executionEnabled: z.literal(false),
}).strict().refine(c => c.historicalDifferencesAllowed === (c.status !== 'NOT_COMPARABLE')
  && (c.directDeltas !== null) === c.historicalDifferencesAllowed
  && (c.status === 'COMPARABLE') === (c.reasons.length === 0)
  && (c.status === 'NOT_COMPARABLE') === c.reasons.some(r => r.impact === 'BLOCKS_DIRECT_COMPARISON'));
export type Comparison = z.infer<typeof ComparisonSchema>;

/** Descriptive historical differences only. This function never selects a winner. */
export function compareAnalyses(leftInput: AnalysisWithContext, rightInput: AnalysisWithContext): Comparison {
  const left = AnalysisWithContextSchema.parse(leftInput);
  const right = AnalysisWithContextSchema.parse(rightInput);
  const reasons: z.infer<typeof ReasonSchema>[] = [];
  for (const field of [...decisiveFields, ...versionFields]) {
    const impact = (decisiveFields as readonly string[]).includes(field) ? 'BLOCKS_DIRECT_COMPARISON' as const : 'CAVEAT' as const;
    const a = left.context[field].value;
    const b = right.context[field].value;
    if (a === null) reasons.push({ field, code: 'MISSING_LEFT', impact });
    if (b === null) reasons.push({ field, code: 'MISSING_RIGHT', impact });
    if (a !== null && b !== null && JSON.stringify(a) !== JSON.stringify(b)) reasons.push({ field, code: 'MISMATCH', impact });
  }
  if (left.context.leverage.value?.kind === 'VARIABLE' || right.context.leverage.value?.kind === 'VARIABLE')
    reasons.push({ field: 'leverage', code: 'VARIABLE_LEVERAGE', impact: 'BLOCKS_DIRECT_COMPARISON' });
  if (left.consistency.status === 'MISMATCH' || right.consistency.status === 'MISMATCH')
    reasons.push({ field: 'consistency', code: 'SUMMARY_MISMATCH', impact: 'CAVEAT' });
  const difference = (a: number | null, b: number | null) => a === null || b === null ? null : b - a;
  let directDeltas: z.infer<typeof DeltasSchema> | null = null;
  if (!reasons.some(r => r.impact === 'BLOCKS_DIRECT_COMPARISON')) {
    const deltas = DeltasSchema.safeParse({
      direction: 'RIGHT_MINUS_LEFT',
      netProfitStakeUnits: right.derived.netProfitStakeUnits - left.derived.netProfitStakeUnits,
      closedTradeReturnRatio: right.derived.closedTradeReturnRatio - left.derived.closedTradeReturnRatio,
      tradeCount: right.derived.tradeCount - left.derived.tradeCount,
      winRateRatio: difference(left.derived.winRateRatio, right.derived.winRateRatio),
      profitFactor: difference(left.derived.profitFactor, right.derived.profitFactor),
    });
    if (deltas.success) directDeltas = deltas.data;
    else reasons.push({ field: 'arithmetic', code: 'NUMERIC_RANGE_EXCEEDED', impact: 'BLOCKS_DIRECT_COMPARISON' });
  }
  const status = reasons.some(r => r.impact === 'BLOCKS_DIRECT_COMPARISON') ? 'NOT_COMPARABLE' : reasons.length ? 'WITH_CAVEATS' : 'COMPARABLE';
  return ComparisonSchema.parse({
    schemaVersion: 1, comparisonVersion: 'declared-context-v1', status,
    historicalDifferencesAllowed: status !== 'NOT_COMPARABLE', rankingAllowed: false, reasons, directDeltas,
    contextVerification: 'DECLARATIONS_NOT_INDEPENDENTLY_VERIFIED',
    limitations: ['HISTORICAL_CLOSED_TRADES_ONLY', 'NO_MARK_TO_MARKET_OR_DRAWDOWN_RECALCULATION', 'NO_CAUSAL_ATTRIBUTION_OR_FORECAST', 'NO_INVESTMENT_RECOMMENDATION'],
    executionEnabled: false,
  });
}
