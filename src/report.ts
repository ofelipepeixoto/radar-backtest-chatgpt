import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { z } from 'zod';
import { ExperimentContextSchema, OperatorContextSchema, extractExperimentContext, resolveOperatorContext, type ExperimentContext, type OperatorContext } from './context.js';

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_TRADES = 10_000;
const MAX_STRATEGIES = 32;
const AMOUNT_LIMIT = 1e12;

export class ReportError extends Error {
  constructor() { super('INVALID_REPORT'); }
}
function fail(): never { throw new ReportError(); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return fail();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  const result = number(value, min, max);
  return Number.isSafeInteger(result) ? result : fail();
}
function sum(values: number[]): number {
  let total = 0, correction = 0;
  for (const value of values) {
    const adjusted = value - correction;
    const next = total + adjusted;
    correction = (next - total) - adjusted;
    total = next;
  }
  return number(total, -1e16, 1e16);
}
function approx(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-8;
}
function rejectAmbiguousJson(text: string): void {
  // JSON.parse has already checked syntax. This token pass rejects duplicate
  // decoded object keys (including escaped aliases) and excessive nesting.
  const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g;
  const stack: { keys: Set<string> | null; keyExpected: boolean }[] = [];
  for (let match; (match = tokens.exec(text)) !== null;) {
    const token = match[0];
    const top = stack.at(-1);
    if (token === '{' || token === '[') {
      stack.push({ keys: token === '{' ? new Set() : null, keyExpected: token === '{' });
      if (stack.length > 64) fail();
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && top?.keys) top.keyExpected = true;
    else if (token.startsWith('"') && top?.keys && top.keyExpected) {
      const key: string = JSON.parse(token);
      if (top.keys.has(key)) fail();
      top.keys.add(key);
      top.keyExpected = false;
    }
  }
}
function rejectNonFiniteJson(root: unknown): void {
  const pending: unknown[] = [root];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'number' && !Number.isFinite(value)) fail();
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) pending.push(item);
    }
  }
}
export function parseStrictJson(bytes: Buffer, maxBytes = MAX_BYTES): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.length === 0 || bytes.length > maxBytes) return fail();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const raw: unknown = JSON.parse(text);
    rejectAmbiguousJson(text);
    rejectNonFiniteJson(raw);
    return raw;
  } catch { return fail(); }
}
const boundedNumber = z.number().finite().min(-1e16).max(1e16);
const count = z.number().int().min(0).max(MAX_TRADES);
const checkedIssues = z.enum(['TOTAL_TRADES_MISMATCH', 'WINS_MISMATCH', 'LOSSES_MISMATCH', 'DRAWS_MISMATCH', 'PROFIT_TOTAL_ABS_MISMATCH', 'PROFIT_TOTAL_MISMATCH']);
export const AnalysisSchema = z.object({
  strategyId: z.string().regex(/^strategy-([1-9]|[12][0-9]|3[0-2])$/),
  derived: z.object({
    tradeCount: count, wins: count, losses: count, draws: count,
    outcomeBasis: z.literal('EXPORTED_PROFIT_RATIO'),
    winRateRatio: z.number().finite().min(0).max(1).nullable(),
    startingBalanceStakeUnits: z.number().finite().positive().max(AMOUNT_LIMIT),
    netProfitStakeUnits: boundedNumber,
    closedTradeReturnRatio: z.number().finite(),
    profitFactor: z.number().finite().min(0).nullable(),
    profitFactorStatus: z.enum(['NO_TRADES', 'NO_LOSSES_UNDEFINED', 'DEFINED']),
  }).strict(),
  reportedUnverified: z.object({
    total_trades: count.optional(), wins: count.optional(), losses: count.optional(), draws: count.optional(),
    profit_total_abs: boundedNumber.optional(), profit_total: boundedNumber.optional(),
    max_relative_drawdown: z.number().finite().min(0).max(1e6).optional(),
    max_drawdown_account: z.number().finite().min(0).max(1e6).optional(),
    profit_factor: z.number().finite().min(0).max(1e16).optional(),
  }).strict(),
  consistency: z.object({
    status: z.enum(['MISMATCH', 'NO_MISMATCH_IN_CHECKED_FIELDS', 'NO_FIELDS_CHECKED']),
    checkedFieldCount: z.number().int().min(0).max(6), issues: z.array(checkedIssues).max(6),
  }).strict(),
  interpretation: z.object({
    units: z.literal('Amounts use the export stake currency; ratios are fractions, not percentages.'),
    drawdown: z.literal('max_relative_drawdown is the largest relative drawdown; max_drawdown_account is the relative drawdown of the largest absolute loss episode. Neither is recomputed here.'),
    scope: z.literal('Closed and force-exited trades only; floating-point descriptive calculations, not accounting or a forecast.'),
  }).strict(),
  limitations: z.tuple([z.literal('BACKTEST_ONLY'), z.literal('SOURCE_NOT_AUTHENTICATED'), z.literal('COSTS_NOT_INDEPENDENTLY_VERIFIED'), z.literal('LOOKAHEAD_AND_RECURSIVE_BIAS_NOT_TESTED'), z.literal('OUT_OF_SAMPLE_NOT_VERIFIED'), z.literal('NO_INVESTMENT_RECOMMENDATION')]),
  executionEnabled: z.literal(false),
}).strict();
export type Analysis = z.infer<typeof AnalysisSchema>;
export const AnalysisWithContextSchema = AnalysisSchema.extend({ context: ExperimentContextSchema });
export type AnalysisWithContext = z.infer<typeof AnalysisWithContextSchema>;
export const ReportSnapshotSchema = z.object({
  schemaVersion: z.literal(2), parserVersion: z.literal('freqtrade-reduced-v2'),
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/), demo: z.boolean(),
  analyses: z.array(AnalysisWithContextSchema).min(1).max(MAX_STRATEGIES),
}).strict().refine(s => new Set(s.analyses.map(a => a.strategyId)).size === s.analyses.length
  && s.analyses.reduce((n, a) => n + a.derived.tradeCount, 0) <= MAX_TRADES
  && s.analyses.every((a, i) => a.strategyId === `strategy-${i + 1}`
    && a.context.startingBalanceStakeUnits.value === a.derived.startingBalanceStakeUnits
    && a.derived.wins + a.derived.losses + a.derived.draws === a.derived.tradeCount
    && a.derived.winRateRatio === (a.derived.tradeCount ? a.derived.wins / a.derived.tradeCount : null)
    && a.derived.closedTradeReturnRatio === a.derived.netProfitStakeUnits / a.derived.startingBalanceStakeUnits
    && (a.derived.profitFactor === null) === (a.derived.profitFactorStatus !== 'DEFINED')
    && (a.derived.tradeCount === 0) === (a.derived.profitFactorStatus === 'NO_TRADES')
    && (a.consistency.status === 'MISMATCH') === (a.consistency.issues.length > 0)));
export type ReportSnapshot = z.infer<typeof ReportSnapshotSchema>;
function analyze(stats: Record<string, unknown>, strategyId: string) {
  const startingBalance = number(stats.starting_balance, Number.MIN_VALUE, AMOUNT_LIMIT);
  if (!Array.isArray(stats.trades) || stats.trades.length > MAX_TRADES) return fail();
  const profits: number[] = [];
  const outcomes: number[] = [];
  for (const item of stats.trades) {
    const trade = object(item);
    // Backtest force_exit rows are already present in trades. Never append left_open_trades.
    if (trade.is_open !== false) return fail();
    const close = integer(trade.close_timestamp, 0, 8.64e15);
    if (trade.open_timestamp !== undefined && integer(trade.open_timestamp, 0, 8.64e15) > close) return fail();
    profits.push(number(trade.profit_abs, -AMOUNT_LIMIT, AMOUNT_LIMIT));
    outcomes.push(number(trade.profit_ratio, -1e6, 1e6));
  }
  // Match upstream counts: profit_ratio and profit_abs are rounded separately.
  const wins = outcomes.filter(p => p > 0).length;
  const losses = outcomes.filter(p => p < 0).length;
  const draws = profits.length - wins - losses;
  const netProfit = sum(profits);
  const grossProfit = sum(profits.filter(p => p > 0));
  const grossLoss = -sum(profits.filter(p => p < 0));
  const ratio = netProfit / startingBalance;
  if (!Number.isFinite(ratio)) return fail();
  const reported: Record<string, number> = {};
  const issues: string[] = [];
  const compare = (key: string, derived: number, min: number, max: number, whole = false) => {
    if (stats[key] === undefined) return;
    const value = whole ? integer(stats[key], min, max) : number(stats[key], min, max);
    reported[key] = value;
    if (!approx(value, derived)) issues.push(`${key.toUpperCase()}_MISMATCH`);
  };
  compare('total_trades', profits.length, 0, MAX_TRADES, true);
  compare('wins', wins, 0, MAX_TRADES, true);
  compare('losses', losses, 0, MAX_TRADES, true);
  compare('draws', draws, 0, MAX_TRADES, true);
  compare('profit_total_abs', netProfit, -1e16, 1e16);
  compare('profit_total', ratio, -1e16, 1e16);
  // Distinct upstream definitions: do not substitute one drawdown measure for another.
  for (const key of ['max_relative_drawdown', 'max_drawdown_account']) {
    if (stats[key] !== undefined) reported[key] = number(stats[key], 0, 1e6);
  }
  if (stats.profit_factor !== undefined) reported.profit_factor = number(stats.profit_factor, 0, 1e16);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  if (profitFactor !== null && !Number.isFinite(profitFactor)) return fail();
  return {
    strategyId,
    derived: {
      tradeCount: profits.length, wins, losses, draws, outcomeBasis: 'EXPORTED_PROFIT_RATIO',
      winRateRatio: profits.length ? wins / profits.length : null,
      startingBalanceStakeUnits: startingBalance,
      netProfitStakeUnits: netProfit,
      closedTradeReturnRatio: ratio,
      profitFactor,
      profitFactorStatus: profits.length === 0 ? 'NO_TRADES' : grossLoss === 0 ? 'NO_LOSSES_UNDEFINED' : 'DEFINED',
    },
    reportedUnverified: reported,
    consistency: { status: issues.length ? 'MISMATCH' : Object.keys(reported).some(k => !['max_relative_drawdown', 'max_drawdown_account', 'profit_factor'].includes(k)) ? 'NO_MISMATCH_IN_CHECKED_FIELDS' : 'NO_FIELDS_CHECKED',
      checkedFieldCount: Object.keys(reported).filter(k => !['max_relative_drawdown', 'max_drawdown_account', 'profit_factor'].includes(k)).length, issues },
    interpretation: {
      units: 'Amounts use the export stake currency; ratios are fractions, not percentages.',
      drawdown: 'max_relative_drawdown is the largest relative drawdown; max_drawdown_account is the relative drawdown of the largest absolute loss episode. Neither is recomputed here.',
      scope: 'Closed and force-exited trades only; floating-point descriptive calculations, not accounting or a forecast.',
    },
    limitations: ['BACKTEST_ONLY', 'SOURCE_NOT_AUTHENTICATED', 'COSTS_NOT_INDEPENDENTLY_VERIFIED', 'LOOKAHEAD_AND_RECURSIVE_BIAS_NOT_TESTED', 'OUT_OF_SAMPLE_NOT_VERIFIED', 'NO_INVESTMENT_RECOMMENDATION'],
    executionEnabled: false,
  };
}

export class Report {
  #analyses!: Analysis[];
  #contexts!: ExperimentContext[];
  #tradeBounds!: { earliestTimestamp: number | null; latestTimestamp: number | null }[];
  #hash!: string;
  #demo!: boolean;
  constructor(bytes: Buffer, demo = false) {
    const raw = parseStrictJson(bytes);
    const root = object(raw);
    const entries = Object.entries(object(root.strategy));
    if (!entries.length || entries.length > MAX_STRATEGIES) return fail();
    let trades = 0;
    this.#contexts = [];
    this.#tradeBounds = [];
    this.#analyses = entries.map(([, value], index) => {
      const stats = object(value);
      const result = AnalysisSchema.parse(analyze(stats, `strategy-${index + 1}`));
      this.#contexts.push(extractExperimentContext(stats));
      const rows = stats.trades as Record<string, number>[];
      this.#tradeBounds.push({ earliestTimestamp: rows.length ? Math.min(...rows.map(t => t.open_timestamp ?? t.close_timestamp!)) : null,
        latestTimestamp: rows.length ? Math.max(...rows.map(t => t.close_timestamp!)) : null });
      trades += result.derived.tradeCount;
      if (trades > MAX_TRADES) return fail();
      return result;
    });
    this.#hash = createHash('sha256').update(bytes).digest('hex');
    this.#demo = demo;
  }
  list(): object {
    return { schemaVersion: 1, reportSha256: this.#hash, demo: this.#demo,
      provenance: 'User-provided bytes; digest identifies bytes, not authenticity or ownership.',
      strategies: this.#analyses.map(s => ({ strategyId: s.strategyId, tradeCount: s.derived.tradeCount })),
      executionEnabled: false };
  }
  analyze(strategyId: string): object {
    const value = this.#analyses.find(s => s.strategyId === strategyId);
    if (!value) throw new Error('UNKNOWN_STRATEGY');
    return structuredClone({ schemaVersion: 1, reportSha256: this.#hash, demo: this.#demo, ...value });
  }
  snapshot(operatorContexts: Record<string, OperatorContext> = {}): ReportSnapshot {
    const contexts = z.record(z.string().regex(/^strategy-([1-9]|[12][0-9]|3[0-2])$/), OperatorContextSchema).parse(operatorContexts);
    if (Object.keys(contexts).some(id => !this.#analyses.some(a => a.strategyId === id))) return fail();
    return ReportSnapshotSchema.parse({
      schemaVersion: 2, parserVersion: 'freqtrade-reduced-v2', reportSha256: this.#hash, demo: this.#demo,
      analyses: this.#analyses.map((a, i) => {
        const context = resolveOperatorContext(this.#contexts[i]!, contexts[a.strategyId]);
        const period = context.period.value, bounds = this.#tradeBounds[i]!;
        if (period && bounds.earliestTimestamp !== null && bounds.latestTimestamp !== null
            && (bounds.earliestTimestamp < period.startEpochMilliseconds || bounds.latestTimestamp > period.endEpochMilliseconds)) return fail();
        return { ...structuredClone(a), context };
      }),
    });
  }
}
export function loadReport(path: string): Report {
  // Only the local operator supplies this path at startup. MCP has no filesystem input.
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) return fail();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    return new Report(bytes.subarray(0, size));
  } catch { return fail(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
export function demoReport(): Report {
  // Original fictitious fixture; no upstream source, strategy, dataset, or export copied.
  const trades = [20, -10, 0, 5].map((profit_abs, i) => ({
    profit_abs, profit_ratio: profit_abs / 1000, is_open: false, open_timestamp: 1_700_000_000_000 + i * 120_000,
    close_timestamp: 1_700_000_060_000 + i * 120_000,
  }));
  return new Report(Buffer.from(JSON.stringify({ strategy: { fictitious: {
    starting_balance: 1000, trades, total_trades: 4, wins: 2, losses: 1, draws: 1,
    profit_total_abs: 15, profit_total: 0.015,
    max_relative_drawdown: 0.02, max_drawdown_account: 0.01,
  } } })), true);
}
