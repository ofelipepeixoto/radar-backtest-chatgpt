import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request as requestHttp } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { portFromEnvironment } from '../src/cli.js';
import { demoReport, type Report } from '../src/report.js';

const stdioPath = fileURLToPath(new URL('../src/stdio.js', import.meta.url));
const httpPath = fileURLToPath(new URL('../src/http.js', import.meta.url));
const errorText = 'Unable to review the selected report.';

function client() { return new Client({ name: 'transport-regression', version: '1.0.0' }); }

async function httpLab(report: Report = demoReport()) {
  const server = createHttpServer(report, 0);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function text(result: unknown): string {
  assert.ok(result && typeof result === 'object' && 'content' in result);
  const content = result.content as Array<{ type: string; text?: string }>;
  assert.equal(content[0]?.type, 'text');
  assert.equal(typeof content[0]?.text, 'string');
  return content[0]!.text!;
}

async function assertToolsAndCalls(mcp: Client) {
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['backtest_list_reports', 'backtest_analyze_report']);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.openWorldHint, false);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const list = await mcp.callTool({ name: 'backtest_list_reports', arguments: {} });
  assert.equal(list.isError, undefined);
  const reports = JSON.parse(text(list));
  assert.equal(reports.demo, true);
  assert.equal(reports.executionEnabled, false);
  assert.equal(reports.strategies[0].strategyId, 'strategy-1');
  const review = await mcp.callTool({ name: 'backtest_analyze_report', arguments: { strategyId: 'strategy-1' } });
  const analysis = JSON.parse(text(review));
  assert.equal(analysis.executionEnabled, false);
  assert.equal(analysis.derived.tradeCount, 4);
}

test('official SDK stdio initializes, lists strict read-only tools and reviews explicit demo', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [stdioPath, '--demo'], stderr: 'pipe' });
  const mcp = client();
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += String(data); });
  try {
    await mcp.connect(transport);
    await assertToolsAndCalls(mcp);
    assert.equal(stderr, '');
  } finally { await mcp.close(); }
});

test('official SDK stateless HTTP initializes, lists tools and calls report analysis', async () => {
  const lab = await httpLab();
  const mcp = client();
  try {
    await mcp.connect(new StreamableHTTPClientTransport(lab.url));
    await assertToolsAndCalls(mcp);
  } finally { await mcp.close(); await lab.close(); }
});

test('MCP rejects unknown names, filesystem/URL arguments, extra approval and invalid strategy ids with a generic error', async () => {
  const lab = await httpLab();
  const mcp = client();
  try {
    await mcp.connect(new StreamableHTTPClientTransport(lab.url));
    const calls = [
      { name: '/private/secret-tool', arguments: {} },
      { name: '__proto__', arguments: {} },
      { name: 'trade_place_order', arguments: {} },
      { name: 'backtest_list_reports', arguments: { path: '/private/customer.json' } },
      { name: 'backtest_list_reports', arguments: { url: 'https://example.invalid/report' } },
      { name: 'backtest_analyze_report', arguments: { strategyId: 'strategy-1', approved: true } },
      { name: 'backtest_analyze_report', arguments: { strategyId: '../../private/customer.json' } },
      { name: 'backtest_analyze_report', arguments: { strategyId: 'strategy-0' } },
      { name: 'backtest_analyze_report', arguments: { strategyId: 'strategy-100' } },
      { name: 'backtest_analyze_report', arguments: {} },
      { name: 'backtest_analyze_report', arguments: { strategyId: 'strategy-99' } },
    ];
    for (const call of calls) {
      const result = await mcp.callTool(call);
      assert.equal(result.isError, true);
      assert.equal(text(result), errorText);
    }
  } finally { await mcp.close(); await lab.close(); }
});

test('report exceptions are redacted before returning through MCP', async () => {
  const throwing = { list() { throw new Error('/private/customer.json'); }, analyze() { throw new Error('secret-report-name'); } } as unknown as Report;
  const lab = await httpLab(throwing);
  const mcp = client();
  try {
    await mcp.connect(new StreamableHTTPClientTransport(lab.url));
    for (const call of [
      { name: 'backtest_list_reports', arguments: {} },
      { name: 'backtest_analyze_report', arguments: { strategyId: 'strategy-1' } },
    ]) {
      const result = await mcp.callTool(call);
      assert.equal(result.isError, true);
      assert.equal(text(result), errorText);
    }
  } finally { await mcp.close(); await lab.close(); }
});

test('HTTP denies a foreign Host even on the loopback listener', async () => {
  const lab = await httpLab();
  try {
    // Node fetch normalizes Host; the raw HTTP client preserves this hostile header.
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const request = requestHttp(lab.url, { method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += String(chunk); });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', reject);
      request.end('{}');
    });
    assert.equal(result.status, 403);
    assert.deepEqual(JSON.parse(result.body), { error: 'Request rejected.' });
  } finally { await lab.close(); }
});

test('HTTP rejects foreign and null Origin, permits only absent or exact local Origin', async () => {
  const lab = await httpLab();
  try {
    for (const origin of ['https://evil.example', 'null', 'http://localhost:8788']) {
      const result = await fetch(lab.url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(result.status, 403);
    }
    const allowed = await fetch(lab.url, {
      method: 'POST', headers: { Origin: lab.url.origin, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'origin-test', version: '1' } } }),
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json() as { jsonrpc: string }).jsonrpc, '2.0');
  } finally { await lab.close(); }
});

test('HTTP rejects oversized bodies before JSON parsing and reflects no input', async () => {
  const lab = await httpLab();
  try {
    const result = await fetch(lab.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(16 * 1024 + 1) });
    assert.equal(result.status, 413);
    assert.deepEqual(await result.json(), { error: 'Request rejected.' });
  } finally { await lab.close(); }
});

test('HTTP also enforces the body limit when Content-Length is absent', async () => {
  const lab = await httpLab();
  try {
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const request = requestHttp(lab.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += String(chunk); });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', reject);
      request.write('x'.repeat(16 * 1024));
      request.end('x');
    });
    assert.equal(result.status, 413);
    assert.deepEqual(JSON.parse(result.body), { error: 'Request rejected.' });
  } finally { await lab.close(); }
});

test('HTTP rejects malformed JSON, unknown routes and unsupported methods', async () => {
  const lab = await httpLab();
  try {
    assert.equal((await fetch(lab.url, { method: 'POST', body: '{' })).status, 400);
    assert.equal((await fetch(new URL('/other', lab.url), { method: 'POST', body: '{}' })).status, 404);
    const get = await fetch(lab.url);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
  } finally { await lab.close(); }
});

test('CLI requires exactly one explicit selection and redacts invalid local file paths', () => {
  for (const args of [[], ['--demo', '--demo'], ['--report'], ['--report', '/private/missing-customer.json'], ['--demo', '--report', '/private/customer.json']]) {
    const result = spawnSync(process.execPath, [stdioPath, ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Unable to start the offline backtest review service.\n');
  }
});

test('HTTP CLI rejects invalid PORT values before opening a listener', () => {
  for (const port of ['0', '80', '65536', '8788evil', '1e4', '']) {
    const result = spawnSync(process.execPath, [httpPath, '--demo'], { env: { ...process.env, PORT: port }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Unable to start the offline backtest review service.\n');
  }
});

test('port configuration is decimal, bounded and defaults to 8788', () => {
  assert.equal(portFromEnvironment('8788'), 8788);
  assert.equal(portFromEnvironment('65535'), 65535);
  assert.equal(portFromEnvironment('1024'), 1024);
  for (const value of ['-1', '01', '127.0.0.1:8788', '8788\n']) assert.throws(() => portFromEnvironment(value));
});
