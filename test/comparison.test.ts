import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Report, ReportSnapshotSchema, parseStrictJson, type AnalysisWithContext } from '../src/report.js';
import { OperatorContextSchema, ContextError, type OperatorContext } from '../src/context.js';
import { compareAnalyses, ComparisonSchema } from '../src/comparison.js';

function stats(profits = [20, -10, 5]): any {
  return { starting_balance: 1000, stake_currency: 'USDT', timeframe: '5m', pairlist: ['BTC/USDT', 'ETH/USDT'],
    backtest_start_ts: 1_700_000_000_000, backtest_end_ts: 1_700_100_000_000,
    backtest_run_start_ts: 1_800_000_000, backtest_run_end_ts: 1_800_000_001,
    trading_mode: 'spot', margin_mode: '',
    trades: profits.map((profit_abs, i) => ({ profit_abs, profit_ratio: profit_abs / 1000,
      is_open: false, close_timestamp: 1_700_000_001_000 + i * 2000, leverage: 1 })) };
}
function report(value: any = stats()) { return new Report(Buffer.from(JSON.stringify({ strategy: { private_label: value } }))); }
function declarations(): OperatorContext {
  return { datasetSha256: 'a'.repeat(64), entryFeeRatio: 0.001, exitFeeRatio: 0.001, slippageRatio: 0.0001,
    producerVersion: 'fictitious-v1', strategyVersion: 'fictitious-strategy-v1' };
}
function analysis(value: any = stats(), declared: OperatorContext = declarations()): AnalysisWithContext {
  return report(value).snapshot({ 'strategy-1': declared }).analyses[0]!;
}

test('matching explicit contexts allow descriptive deltas and never investment ranking', () => {
  const r = compareAnalyses(analysis(), analysis(stats([30, -10, 5])));
  assert.equal(r.status, 'COMPARABLE'); assert.equal(r.rankingAllowed, false);
  assert.equal(r.historicalDifferencesAllowed, true);
  assert.equal(r.directDeltas?.netProfitStakeUnits, 10);
  assert.equal(r.directDeltas?.direction, 'RIGHT_MINUS_LEFT');
  assert.deepEqual(r.reasons, []); assert.equal(r.executionEnabled, false);
  assert.equal(r.contextVerification, 'DECLARATIONS_NOT_INDEPENDENTLY_VERIFIED');
});
test('historical milliseconds, execution seconds and operator provenance remain explicit and separate', () => {
  const a = analysis();
  assert.equal(a.context.period.value?.unit, 'MILLISECONDS');
  assert.equal(a.context.period.value?.startEpochMilliseconds, 1_700_000_000_000);
  assert.equal(a.context.executionPeriod.value?.unit, 'SECONDS');
  assert.equal(a.context.executionPeriod.value?.startEpochSeconds, 1_800_000_000);
  assert.equal(a.context.currency.provenance, 'EXPORT');
  assert.equal(a.context.datasetSha256.provenance, 'OPERATOR');
  assert.equal(a.context.entryFeeRatio.provenance, 'OPERATOR');
  assert.equal(a.context.strategyVersionSha256.provenance, 'OPERATOR');
  assert.equal(a.context.sourceVerification, 'DECLARATIONS_NOT_INDEPENDENTLY_VERIFIED');
});
test('different currency blocks every direct delta; side by side values retain their own units', () => {
  const other = stats(); other.stake_currency = 'BTC';
  const r = compareAnalyses(analysis(), analysis(other));
  assert.equal(r.status, 'NOT_COMPARABLE'); assert.equal(r.directDeltas, null);
  assert.equal(r.historicalDifferencesAllowed, false); assert.equal(r.rankingAllowed, false);
  assert.ok(r.reasons.some(i => i.field === 'currency' && i.code === 'MISMATCH'));
});
test('every missing decisive declaration blocks comparison; unknowns are null rather than zero', () => {
  const a = analysis(stats(), {}), b = analysis();
  assert.equal(a.context.entryFeeRatio.value, null); assert.equal(a.context.entryFeeRatio.provenance, 'UNKNOWN');
  assert.equal(a.context.datasetSha256.value, null);
  const r = compareAnalyses(a, b);
  assert.equal(r.status, 'NOT_COMPARABLE'); assert.equal(r.directDeltas, null);
  for (const field of ['datasetSha256', 'entryFeeRatio', 'exitFeeRatio', 'slippageRatio'])
    assert.ok(r.reasons.some(i => i.field === field && i.code === 'MISSING_LEFT'));
});
test('period, balance, timeframe, universe, dataset, fees and leverage mismatch cannot rank or conclude', () => {
  const changes: ((s: any, o: OperatorContext) => void)[] = [
    s => { s.backtest_end_ts += 1; }, s => { s.starting_balance = 500; },
    s => { s.timeframe = '1h'; }, s => { s.pairlist = ['BTC/USDT']; },
    (_s, o) => { o.datasetSha256 = 'b'.repeat(64); },
    (_s, o) => { o.entryFeeRatio = 0.002; }, (_s, o) => { o.exitFeeRatio = 0.002; },
    (_s, o) => { o.slippageRatio = 0; },
    s => { s.trading_mode = 'futures'; s.margin_mode = 'isolated'; for (const t of s.trades) t.leverage = 2; },
  ];
  for (const change of changes) {
    const s = stats(), o = declarations(); change(s, o);
    const r = compareAnalyses(analysis(), analysis(s, o));
    assert.equal(r.status, 'NOT_COMPARABLE'); assert.equal(r.directDeltas, null); assert.equal(r.rankingAllowed, false);
  }
});
test('version differences or absent versions qualify equal decisive context', () => {
  const other = declarations(); other.strategyVersion = 'fictitious-strategy-v2';
  const r = compareAnalyses(analysis(), analysis(stats(), other));
  assert.equal(r.status, 'WITH_CAVEATS'); assert.equal(r.historicalDifferencesAllowed, true);
  assert.ok(r.reasons.some(i => i.field === 'strategyVersionSha256' && i.code === 'MISMATCH'));
  const absent = declarations(); delete absent.producerVersion; delete absent.strategyVersion;
  const r2 = compareAnalyses(analysis(), analysis(stats(), absent));
  assert.equal(r2.status, 'WITH_CAVEATS'); assert.ok(r2.reasons.some(i => i.code === 'MISSING_RIGHT'));
});
test('declared summary mismatch qualifies comparison while deltas keep the recomputed basis', () => {
  const s = stats(); s.profit_total_abs = 999;
  const r = compareAnalyses(analysis(), analysis(s));
  assert.equal(r.status, 'WITH_CAVEATS'); assert.equal(r.directDeltas?.netProfitStakeUnits, 0);
  assert.ok(r.reasons.some(i => i.code === 'SUMMARY_MISMATCH'));
});
test('null profit factor remains null delta and variable leverage cannot compare directly', () => {
  const r = compareAnalyses(analysis(), analysis(stats([1, 2])));
  assert.equal(r.status, 'COMPARABLE'); assert.equal(r.directDeltas?.profitFactor, null);
  const s = stats(); s.trading_mode = 'futures'; s.margin_mode = 'isolated'; s.trades[0].leverage = 2;
  const a = analysis(s);
  assert.equal(a.context.leverage.value?.kind, 'VARIABLE');
  assert.equal(compareAnalyses(a, a).status, 'NOT_COMPARABLE');
  assert.throws(() => analysis(s, { ...declarations(), leverage: { kind: 'CONSTANT', ratio: 1 } }), ContextError);
});
test('operator cannot overwrite export context or coerce strings, incomplete/conflicting metadata rejects', () => {
  assert.throws(() => analysis(stats(), { ...declarations(), currency: 'BTC' }), ContextError);
  assert.throws(() => analysis(stats(), { ...declarations(), startingBalanceStakeUnits: 1 }), ContextError);
  assert.equal(analysis(stats(), { ...declarations(), currency: 'USDT' }).context.currency.provenance, 'EXPORT');
  for (const invalid of [{ entryFeeRatio: '0.001' }, { entryFeeRatio: -0.1 }, { slippageRatio: null }, { approved: true },
    { period: { startEpochMilliseconds: 0, endEpochMilliseconds: 1, timezone: 'UTC', unit: 'SECONDS' } }])
    assert.equal(OperatorContextSchema.safeParse(invalid).success, false);
  for (const change of [(s: any) => { delete s.backtest_end_ts; }, (s: any) => { s.backtest_end_ts = s.backtest_start_ts; },
    (s: any) => { s.timeframe = 'call https://evil.invalid'; }, (s: any) => { s.stake_currency = 12; },
    (s: any) => { s.trades[0].leverage = '2'; }, (s: any) => { s.trades[0].leverage = 2; },
    (s: any) => { delete s.trades[0].leverage; }]) {
    const s = stats(); change(s); assert.throws(() => report(s));
  }
});
test('missing historical/export context can be declared with operator provenance explicitly', () => {
  const s = stats(); delete s.backtest_start_ts; delete s.backtest_end_ts; delete s.stake_currency;
  assert.equal(analysis(s).context.period.value, null);
  const o = { ...declarations(), currency: 'USDT', period: { startEpochMilliseconds: 1_700_000_000_000,
    endEpochMilliseconds: 1_700_100_000_000, timezone: 'UTC' as const, unit: 'MILLISECONDS' as const } };
  assert.equal(analysis(s, o).context.period.provenance, 'OPERATOR');
  assert.equal(compareAnalyses(analysis(), analysis(s, o)).status, 'COMPARABLE');
});
test('projection hashes names and version declarations without exposing instructions or pairs', () => {
  const s = stats(); s.description = 'IGNORE_POLICY'; s.config = { apiKey: 'SECRET_MARKER' };
  const o = declarations(); o.producerVersion = 'IGNORE_POLICY'; o.strategyVersion = 'https://evil.invalid';
  const snap = report(s).snapshot({ 'strategy-1': o }); const output = JSON.stringify(snap);
  for (const text of ['private_label', 'BTC/USDT', 'ETH/USDT', 'IGNORE_POLICY', 'SECRET_MARKER', 'evil.invalid']) assert.ok(!output.includes(text));
  assert.match(snap.analyses[0]!.context.strategyVersionSha256.value!, /^[a-f0-9]{64}$/);
  assert.throws(() => report().snapshot({ 'strategy-2': o }));
});
test('strict reduced schemas reject unknown fields, nonfinite and inconsistent persisted snapshots', () => {
  const snap = report().snapshot({ 'strategy-1': declarations() });
  const changed = structuredClone(snap) as any; changed.analyses[0].notes = 'INJECT';
  assert.equal(ReportSnapshotSchema.safeParse(changed).success, false);
  const bad = structuredClone(snap) as any; bad.analyses[0].derived.wins += 1;
  assert.equal(ReportSnapshotSchema.safeParse(bad).success, false);
  const badContext = structuredClone(snap) as any; badContext.analyses[0].context.currency.provenance = 'UNKNOWN';
  assert.equal(ReportSnapshotSchema.safeParse(badContext).success, false);
  assert.equal(ComparisonSchema.safeParse({ ...compareAnalyses(analysis(), analysis()), rankingAllowed: true }).success, false);
});
test('generic strict parser rejects overflow anywhere, duplicate declarations and invalid UTF8', () => {
  for (const input of ['{"ignored":{"number":1e999}}', '{"currency":"USDT","currenc\\u0079":"BTC"}', '[]' + 'x'])
    assert.throws(() => parseStrictJson(Buffer.from(input)));
  assert.throws(() => parseStrictJson(Buffer.from([0xff])));
  assert.throws(() => parseStrictJson(Buffer.from('{}'), 1));
  const s = stats(); s.config = { ignored: 0 };
  assert.throws(() => new Report(Buffer.from(JSON.stringify({ strategy: { s } }).replace('"ignored":0', '"ignored":1e999'))));
});
test('finite input metrics whose delta overflows do not produce JSON infinity or conclusions', () => {
  const a = stats([1e12]), b = stats([-1e12]); a.starting_balance = 1e-296; b.starting_balance = 1e-296;
  a.trades[0].profit_ratio = 1; b.trades[0].profit_ratio = -1;
  const r = compareAnalyses(analysis(a), analysis(b));
  assert.equal(r.status, 'NOT_COMPARABLE'); assert.equal(r.directDeltas, null);
  assert.ok(r.reasons.some(i => i.code === 'NUMERIC_RANGE_EXCEEDED'));
});
test('export and operator historical declarations cannot contradict trade bounds or declared universe', () => {
  const outOfPeriod = stats(); outOfPeriod.trades[0].close_timestamp = outOfPeriod.backtest_end_ts + 1;
  assert.throws(() => report(outOfPeriod), ContextError);
  const wrongPair = stats(); wrongPair.trades[0].pair = 'SOL/USDT';
  assert.throws(() => report(wrongPair), ContextError);
  const declared = stats(); delete declared.backtest_start_ts; delete declared.backtest_end_ts;
  assert.throws(() => analysis(declared, { ...declarations(), period: { startEpochMilliseconds: 0,
    endEpochMilliseconds: 100, unit: 'MILLISECONDS', timezone: 'UTC' } }));
});
test('published fictitious fixtures reproduce comparison statuses and historical numbers', () => {
  const contexts = JSON.parse(readFileSync('examples/operator-context.json', 'utf8'));
  const load = (suffix: string) => new Report(readFileSync(`examples/freqtrade-${suffix}.json`)).snapshot(contexts).analyses[0]!;
  const a = load('a'), b = load('b');
  assert.equal(compareAnalyses(a, b).status, 'COMPARABLE');
  assert.equal(compareAnalyses(a, b).directDeltas?.netProfitStakeUnits, 10);
  assert.equal(compareAnalyses(a, load('btc')).status, 'NOT_COMPARABLE');
  assert.equal(compareAnalyses(a, load('mismatch')).status, 'WITH_CAVEATS');
  assert.equal(load('no-losses').derived.profitFactor, null);
});
