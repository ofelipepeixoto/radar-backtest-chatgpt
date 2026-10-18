import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Report, ReportError, loadReport, demoReport, MAX_BYTES, MAX_TRADES } from '../src/report.js';

function stats(profits = [20, -10, 0, 5]): any {
  return { starting_balance: 1000, trades: profits.map((profit_abs, i) => ({
    profit_abs, profit_ratio: profit_abs / 1000, is_open: false, close_timestamp: 1_700_000_001_000 + i * 2000,
    open_timestamp: 1_700_000_000_000 + i * 2000,
  })) };
}
function build(value: any = stats()): Report {
  return new Report(Buffer.from(JSON.stringify({ strategy: { secret_name: value } })));
}
function result(report = build()): any { return report.analyze('strategy-1'); }
test('recomputes count, signed net, ratios, wins and factor from trades', () => {
  const d = result().derived;
  assert.deepEqual(d, { tradeCount: 4, wins: 2, losses: 1, draws: 1, outcomeBasis: 'EXPORTED_PROFIT_RATIO', winRateRatio: .5,
    startingBalanceStakeUnits: 1000, netProfitStakeUnits: 15, closedTradeReturnRatio: .015,
    profitFactor: 2.5, profitFactorStatus: 'DEFINED' });
});
test('keeps distinct reported drawdown definitions and ratios above 100%', () => {
  const s = stats([2500]); s.max_relative_drawdown = 1.2; s.max_drawdown_account = .7;
  const r = result(build(s));
  assert.equal(r.derived.closedTradeReturnRatio, 2.5);
  assert.deepEqual(r.reportedUnverified, { max_relative_drawdown: 1.2, max_drawdown_account: .7 });
});
test('reports summary mismatch instead of trusting advertised performance', () => {
  const s = stats(); Object.assign(s, { total_trades: 99, wins: 99, profit_total_abs: 999, profit_total: 9 });
  const r = result(build(s));
  assert.equal(r.derived.netProfitStakeUnits, 15);
  assert.equal(r.consistency.status, 'MISMATCH'); assert.equal(r.consistency.issues.length, 4);
});
test('tiny stake currency discrepancies cannot hide behind an absolute tolerance', () => {
  const s = stats([9e-7]); s.starting_balance = 1e-8; s.profit_total_abs = 0;
  assert.equal(result(build(s)).consistency.status, 'MISMATCH');
});
test('outcome counts use profit_ratio as upstream, even when rounding changes absolute sign', () => {
  const s = stats([1e-8]); s.trades[0].profit_ratio = 0; s.wins = 0; s.draws = 1;
  const r = result(build(s));
  assert.equal(r.derived.wins, 0); assert.equal(r.derived.draws, 1);
  assert.equal(r.derived.netProfitStakeUnits, 1e-8);
  assert.equal(r.consistency.status, 'NO_MISMATCH_IN_CHECKED_FIELDS');
});
test('missing reported summaries are explicitly not checked', () => {
  assert.deepEqual(result().consistency, { status: 'NO_FIELDS_CHECKED', checkedFieldCount: 0, issues: [] });
});
test('rejects duplicate decoded keys and excessive depth; accepts separate repeated field names', () => {
  const prefix = '{"strategy":{"s":{"starting_balance":100,"trades":[{"profit_abs":-50,"profit_abs":10,"profit_ratio":0.1,"is_open":false,"close_timestamp":0}]}}}';
  assert.throws(() => new Report(Buffer.from(prefix)), ReportError);
  assert.throws(() => new Report(Buffer.from(prefix.replace('"profit_abs":10', '"profit_\\u0061bs":10'))), ReportError);
  const valid = { strategy: { s: stats() }, metadata: { x: 'quotes: "[,]{}"', array: [1, { x: false }] } };
  assert.equal((new Report(Buffer.from(JSON.stringify(valid))).list() as any).strategies.length, 1);
  const tooDeep = JSON.stringify({ strategy: { s: stats() } }).slice(0, -1) + ',"padding":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}';
  assert.throws(() => new Report(Buffer.from(tooDeep)), ReportError);
});
test('does not double count force_exit left_open_trades subset', () => {
  const s = stats(); s.trades[0].exit_reason = 'force_exit'; s.left_open_trades = [s.trades[0]];
  assert.equal(result(build(s)).derived.tradeCount, 4);
});
test('zero losses yields null profit factor and explicit status, not infinity or zero', () => {
  const r = result(build(stats([2, 3]))); assert.equal(r.derived.profitFactor, null);
  assert.equal(r.derived.profitFactorStatus, 'NO_LOSSES_UNDEFINED');
});
test('no trades yields null win rate and no-trades factor', () => {
  const r = result(build(stats([]))); assert.equal(r.derived.winRateRatio, null);
  assert.equal(r.derived.profitFactorStatus, 'NO_TRADES');
});
test('all losses, zero-only and negative portfolio return remain descriptive', () => {
  assert.equal(result(build(stats([-1500]))).derived.closedTradeReturnRatio, -1.5);
  assert.equal(result(build(stats([-1, -2]))).derived.profitFactor, 0);
  assert.equal(result(build(stats([0]))).derived.draws, 1);
});
test('arbitrary labels, credentials, config, URLs and instructions never appear in output', () => {
  const s = stats(); s.config = { apiKey: 'SECRET_MARKER' }; s.trades[0].pair = 'IGNORE_POLICY';
  s.description = 'https://evil.invalid/exfiltrate';
  const r = build(s); const output = JSON.stringify([r.list(), r.analyze('strategy-1')]);
  for (const secret of ['secret_name', 'SECRET_MARKER', 'IGNORE_POLICY', 'evil.invalid']) assert.ok(!output.includes(secret));
  assert.equal(result(r).executionEnabled, false);
});
test('separate strategies and detached return objects cannot mutate stored results', () => {
  const r = new Report(Buffer.from(JSON.stringify({ strategy: { a: stats([1]), b: stats([-1]) } })));
  assert.equal((r.list() as any).strategies.length, 2);
  const a: any = r.analyze('strategy-1'); a.derived.netProfitStakeUnits = 900;
  assert.equal(result(r).derived.netProfitStakeUnits, 1);
  assert.equal((r.analyze('strategy-2') as any).derived.netProfitStakeUnits, -1);
});
test('unknown strategy fails without returning source data', () => {
  assert.throws(() => build().analyze('../../file'), /^Error: UNKNOWN_STRATEGY$/);
});
test('rejects incomplete trades and invalid numbers without coercion', () => {
  for (const change of [
    (s: any) => { s.starting_balance = 0; },
    (s: any) => { s.starting_balance = '1000'; },
    (s: any) => { s.trades[0].is_open = true; },
    (s: any) => { delete s.trades[0].is_open; },
    (s: any) => { s.trades[0].profit_abs = null; },
    (s: any) => { s.trades[0].profit_abs = '10'; },
    (s: any) => { delete s.trades[0].profit_ratio; },
    (s: any) => { s.trades[0].close_timestamp = 2.5; },
    (s: any) => { s.trades[0].close_timestamp = 0; },
    (s: any) => { s.wins = -1; },
    (s: any) => { s.profit_total = '100'; },
  ]) { const s = stats(); change(s); assert.throws(() => build(s), ReportError); }
});
test('rejects missing structures, invalid UTF-8, ZIP, NaN and overflow JSON', () => {
  for (const raw of ['{}', 'null', '{"strategy":{}}', '{"strategy":[]}', 'PK00', '{"strategy":{"s":{"starting_balance":1e999,"trades":[]}}}'])
    assert.throws(() => new Report(Buffer.from(raw)), ReportError);
  assert.throws(() => new Report(Buffer.from([0xff, 0xfe])), ReportError);
});
test('bounds raw bytes, per-strategy trades and total trades', () => {
  assert.throws(() => new Report(Buffer.alloc(MAX_BYTES + 1)), ReportError);
  const s = stats([1]); s.trades = Array(MAX_TRADES + 1).fill(s.trades[0]);
  assert.throws(() => build(s), ReportError);
  const small = stats([1]); small.trades = Array(6000).fill(small.trades[0]);
  assert.throws(() => new Report(Buffer.from(JSON.stringify({ strategy: { a: small, b: small } }))), ReportError);
});
test('bounds number of strategies and does not merge metadata as results', () => {
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [i, stats([])]));
  assert.throws(() => new Report(Buffer.from(JSON.stringify({ strategy: many }))), ReportError);
  assert.throws(() => new Report(Buffer.from('{"metadata":{"s":{}},"strategy_comparison":[]}')), ReportError);
});
test('digest identifies exact bytes and demo remains explicitly synthetic', () => {
  assert.match((demoReport().list() as any).reportSha256, /^[a-f0-9]{64}$/);
  assert.equal((demoReport().list() as any).demo, true);
  assert.equal((build().list() as any).demo, false);
});
test('local loader accepts a regular JSON file and rejects directory, oversized and symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-backtest-'));
  try {
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify({ strategy: { a: stats() } }));
    assert.equal(result(loadReport(file)).derived.netProfitStakeUnits, 15);
    mkdirSync(join(dir, 'directory'));
    assert.throws(() => loadReport(join(dir, 'directory')), ReportError);
    writeFileSync(join(dir, 'large'), Buffer.alloc(MAX_BYTES + 1));
    assert.throws(() => loadReport(join(dir, 'large')), ReportError);
    symlinkSync(file, join(dir, 'link'));
    assert.throws(() => loadReport(join(dir, 'link')), ReportError);
    assert.throws(() => loadReport(join(dir, 'nonexistent-SECRET')), { message: 'INVALID_REPORT' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
