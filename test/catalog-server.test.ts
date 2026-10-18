import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PrivateCatalog } from '../src/catalog.js';
import { createCatalogServer } from '../src/catalog-server.js';

const fixture = (name: string) => readFileSync(new URL(`../../examples/${name}`, import.meta.url));
async function lab() {
  const root = mkdtempSync(join(tmpdir(), 'backtest-mcp-v2-'));
  const catalog = new PrivateCatalog(join(root, 'data'));
  const owner = { subject: 'owner-fixture' };
  const contexts = JSON.parse(fixture('operator-context.json').toString('utf8'));
  const a = catalog.importReport(owner, fixture('freqtrade-a.json'), contexts);
  const b = catalog.importReport(owner, fixture('freqtrade-b.json'), contexts);
  const foreign = catalog.importReport({ subject: 'other-fixture' }, fixture('freqtrade-a.json'), contexts);
  const server = createCatalogServer(catalog, owner);
  const client = new Client({ name: 'catalog-sdk-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { a, b, foreign, client, close: async () => { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('v2 SDK lists only authorized reports and resolves repeated local strategy IDs without ambiguity', async () => {
  const instance = await lab();
  try {
    const { tools } = await instance.client.listTools();
    assert.deepEqual(tools.map(t => t.name), ['backtest_v2_list_reports', 'backtest_v2_analyze_report', 'backtest_v2_compare_reports']);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.outputSchema);
    }
    const list = await instance.client.callTool({ name: tools[0]!.name, arguments: {} });
    assert.equal((list.structuredContent as any).reports.length, 2);
    const compare = await instance.client.callTool({ name: tools[2]!.name, arguments: {
      left: { reportId: instance.a.reportId, strategyId: 'strategy-1' },
      right: { reportId: instance.b.reportId, strategyId: 'strategy-1' },
    } });
    assert.equal(compare.isError, undefined);
    const result = compare.structuredContent as any;
    assert.equal(result.left.analysis.derived.netProfitStakeUnits, 15);
    assert.equal(result.right.analysis.derived.netProfitStakeUnits, 25);
    assert.equal(result.comparison.status, 'COMPARABLE');
    assert.equal(result.comparison.directDeltas.netProfitStakeUnits, 10);
  } finally { await instance.close(); }
});

test('v2 SDK rejects model authority, unknown writes and foreign/missing reports with one reduced error', async () => {
  const instance = await lab();
  try {
    const requests = [
      { name: 'backtest_v2_list_reports', arguments: { userId: 'other-fixture' } },
      { name: 'backtest_v2_analyze_report', arguments: { reportId: instance.a.reportId, strategyId: 'strategy-1', approved: true } },
      { name: 'backtest_v2_analyze_report', arguments: { reportId: instance.foreign.reportId, strategyId: 'strategy-1' } },
      { name: 'backtest_v2_analyze_report', arguments: { reportId: '29900900-c6d8-40e9-bc31-82276e58b004', strategyId: 'strategy-1' } },
      { name: 'backtest_v2_import_report', arguments: { path: '/private/report.json' } },
      { name: 'trade_place_order', arguments: {} },
    ];
    const results = await Promise.all(requests.map(r => instance.client.callTool(r)));
    for (const result of results) {
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.deepEqual(JSON.parse((result.content as any)[0].text), { schemaVersion: 2, error: { code: 'REQUEST_REJECTED', retryable: false } });
    }
  } finally { await instance.close(); }
});
