import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';

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
type Analysis = ReturnType<typeof analyze>;
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
  #hash!: string;
  #demo!: boolean;
  constructor(bytes: Buffer, demo = false) {
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return fail();
    let raw: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      raw = JSON.parse(text);
      rejectAmbiguousJson(text);
    }
    catch { return fail(); }
    const root = object(raw);
    const entries = Object.entries(object(root.strategy));
    if (!entries.length || entries.length > MAX_STRATEGIES) return fail();
    let trades = 0;
    this.#analyses = entries.map(([, value], index) => {
      const stats = object(value);
      const result = analyze(stats, `strategy-${index + 1}`);
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
