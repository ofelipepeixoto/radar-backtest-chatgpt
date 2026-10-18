import { createHash } from 'node:crypto';
import { z } from 'zod';

// This is a deliberately narrow profile of the pinned Freqtrade result format.
// No value from notes, configs, strategy names or metadata is projected.
export class ContextError extends Error {
  constructor() { super('INVALID_CONTEXT'); }
}
const amount = z.number().finite().positive().max(1e12);
const ratio = z.number().finite().min(0).max(1);
const epochMilliseconds = z.number().int().min(0).max(8.64e15);
const epochSeconds = z.number().int().min(0).max(8.64e12);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const currency = z.string().regex(/^[A-Z][A-Z0-9]{0,15}$/);
const timeframe = z.string().regex(/^[1-9][0-9]{0,5}[mhdwM]$/);
const version = z.string().min(1).max(512);
const PeriodSchema = z.object({
  startEpochMilliseconds: epochMilliseconds,
  endEpochMilliseconds: epochMilliseconds,
  timezone: z.literal('UTC'), unit: z.literal('MILLISECONDS'),
}).strict().refine(p => p.startEpochMilliseconds < p.endEpochMilliseconds);
const ExecutionPeriodSchema = z.object({
  startEpochSeconds: epochSeconds, endEpochSeconds: epochSeconds,
  timezone: z.literal('UTC'), unit: z.literal('SECONDS'),
}).strict().refine(p => p.startEpochSeconds <= p.endEpochSeconds);
const LeverageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CONSTANT'), ratio: z.number().finite().min(1).max(1e6) }).strict(),
  z.object({ kind: z.literal('VARIABLE') }).strict(),
]);
const ModeSchema = z.object({
  trading: z.enum(['SPOT', 'MARGIN', 'FUTURES']),
  margin: z.enum(['NONE', 'ISOLATED', 'CROSS']),
}).strict().refine(m => (m.trading === 'SPOT') === (m.margin === 'NONE'));
const provenance = z.enum(['EXPORT', 'OPERATOR', 'UNKNOWN']);
function field<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ value: schema.nullable(), provenance }).strict()
    .refine(f => (f.value === null) === (f.provenance === 'UNKNOWN'));
}
export const ExperimentContextSchema = z.object({
  schemaVersion: z.literal(1),
  period: field(PeriodSchema),
  executionPeriod: field(ExecutionPeriodSchema),
  currency: field(currency),
  startingBalanceStakeUnits: field(amount),
  timeframe: field(timeframe),
  universeSha256: field(sha256),
  datasetSha256: field(sha256),
  entryFeeRatio: field(ratio),
  exitFeeRatio: field(ratio),
  slippageRatio: field(ratio),
  leverage: field(LeverageSchema),
  mode: field(ModeSchema),
  producerVersionSha256: field(sha256),
  strategyVersionSha256: field(sha256),
  sourceVerification: z.literal('DECLARATIONS_NOT_INDEPENDENTLY_VERIFIED'),
}).strict().refine(c => c.mode.value?.trading !== 'SPOT' || c.leverage.value === null
  || (c.leverage.value.kind === 'CONSTANT' && c.leverage.value.ratio === 1));
export type ExperimentContext = z.infer<typeof ExperimentContextSchema>;

// This is an administrative declaration, never a parameter accepted by MCP.
export const OperatorContextSchema = z.object({
  period: PeriodSchema.optional(),
  executionPeriod: ExecutionPeriodSchema.optional(),
  currency: currency.optional(),
  startingBalanceStakeUnits: amount.optional(),
  timeframe: timeframe.optional(),
  universeSha256: sha256.optional(),
  datasetSha256: sha256.optional(),
  entryFeeRatio: ratio.optional(),
  exitFeeRatio: ratio.optional(),
  slippageRatio: ratio.optional(),
  leverage: LeverageSchema.optional(),
  mode: ModeSchema.optional(),
  producerVersion: version.optional(),
  strategyVersion: version.optional(),
}).strict();
export type OperatorContext = z.infer<typeof OperatorContextSchema>;

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ContextError();
  return result.data;
}
function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function known<T>(value: T | null, source: 'EXPORT' | 'OPERATOR' = 'EXPORT') {
  return { value, provenance: value === null ? 'UNKNOWN' as const : source };
}
function optional<T extends z.ZodTypeAny>(stats: Record<string, unknown>, key: string, schema: T): z.infer<T> | null {
  return stats[key] === undefined || stats[key] === null ? null : parse(schema, stats[key]);
}
function periodFromExport(stats: Record<string, unknown>) {
  const start = optional(stats, 'backtest_start_ts', epochMilliseconds);
  const end = optional(stats, 'backtest_end_ts', epochMilliseconds);
  if ((start === null) !== (end === null)) throw new ContextError();
  if (start === null || end === null) return null;
  return parse(PeriodSchema, { startEpochMilliseconds: start, endEpochMilliseconds: end, timezone: 'UTC', unit: 'MILLISECONDS' });
}
function executionFromExport(stats: Record<string, unknown>) {
  const start = optional(stats, 'backtest_run_start_ts', epochSeconds);
  const end = optional(stats, 'backtest_run_end_ts', epochSeconds);
  if ((start === null) !== (end === null)) throw new ContextError();
  if (start === null || end === null) return null;
  return parse(ExecutionPeriodSchema, { startEpochSeconds: start, endEpochSeconds: end, timezone: 'UTC', unit: 'SECONDS' });
}
function universeFromExport(stats: Record<string, unknown>): string | null {
  if (stats.pairlist === undefined || stats.pairlist === null) return null;
  const pairs = parse(z.array(z.string().min(1).max(128)).min(1).max(10_000), stats.pairlist);
  if (new Set(pairs).size !== pairs.length) throw new ContextError();
  return digest(JSON.stringify([...pairs].sort()));
}
function leverageFromExport(stats: Record<string, unknown>): z.infer<typeof LeverageSchema> | null {
  const trades = stats.trades as Record<string, unknown>[];
  const values = trades.map(t => optional(t, 'leverage', z.number().finite().min(1).max(1e6)));
  if (values.some(v => v === null) && values.some(v => v !== null)) throw new ContextError();
  if (!values.length || values.some(v => v === null)) return null;
  if (values.every(v => v === values[0])) return { kind: 'CONSTANT', ratio: values[0]! };
  return { kind: 'VARIABLE' };
}
function modeFromExport(stats: Record<string, unknown>): z.infer<typeof ModeSchema> | null {
  const trading = optional(stats, 'trading_mode', z.enum(['spot', 'margin', 'futures']));
  const margin = optional(stats, 'margin_mode', z.enum(['', 'isolated', 'cross']));
  if ((trading === null) !== (margin === null)) throw new ContextError();
  if (trading === null || margin === null) return null;
  return parse(ModeSchema, { trading: trading.toUpperCase(), margin: margin === '' ? 'NONE' : margin.toUpperCase() });
}
// Pinned exports do not provide dataset identity, slippage assumptions or strategy
// version. These remain unknown until explicitly declared by the operator.
export function extractExperimentContext(stats: Record<string, unknown>): ExperimentContext {
  const period = periodFromExport(stats);
  const trades = stats.trades as Record<string, unknown>[];
  const pairlist = stats.pairlist;
  if (period && trades.some(t => (t.open_timestamp !== undefined && (t.open_timestamp as number) < period.startEpochMilliseconds)
      || (t.close_timestamp as number) > period.endEpochMilliseconds)) throw new ContextError();
  if (Array.isArray(pairlist) && trades.some(t => t.pair !== undefined
      && (typeof t.pair !== 'string' || !pairlist.includes(t.pair)))) throw new ContextError();
  return parse(ExperimentContextSchema, {
    schemaVersion: 1,
    period: known(period),
    executionPeriod: known(executionFromExport(stats)),
    currency: known(optional(stats, 'stake_currency', currency)),
    startingBalanceStakeUnits: known(parse(amount, stats.starting_balance)),
    timeframe: known(optional(stats, 'timeframe', timeframe)),
    universeSha256: known(universeFromExport(stats)),
    datasetSha256: known(null),
    entryFeeRatio: known(null), exitFeeRatio: known(null), slippageRatio: known(null),
    leverage: known(leverageFromExport(stats)), mode: known(modeFromExport(stats)),
    producerVersionSha256: known(null), strategyVersionSha256: known(null),
    sourceVerification: 'DECLARATIONS_NOT_INDEPENDENTLY_VERIFIED',
  });
}

export function resolveOperatorContext(exported: ExperimentContext, input: unknown = {}): ExperimentContext {
  const context = structuredClone(parse(ExperimentContextSchema, exported));
  const operator = parse(OperatorContextSchema, input);
  const declarations: Record<string, unknown> = { ...operator };
  if (operator.producerVersion !== undefined) declarations.producerVersionSha256 = digest(operator.producerVersion);
  if (operator.strategyVersion !== undefined) declarations.strategyVersionSha256 = digest(operator.strategyVersion);
  delete declarations.producerVersion;
  delete declarations.strategyVersion;
  for (const [key, value] of Object.entries(declarations)) {
    const current = context[key as keyof ExperimentContext] as { value: unknown; provenance: string };
    if (current.value !== null && JSON.stringify(current.value) !== JSON.stringify(value)) throw new ContextError();
    if (current.value === null) Object.assign(current, known(value, 'OPERATOR'));
  }
  return parse(ExperimentContextSchema, context);
}
