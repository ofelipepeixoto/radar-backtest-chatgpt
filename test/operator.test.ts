import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRemoteConfig, readOperatorFile } from '../src/operator-config.js';
import { administer } from '../src/admin.js';

test('operator config requires private regular file, bounded bytes and strict fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'backtest-operator-'));
  const config = join(root, 'config.json');
  const value = { schemaVersion: 1, storageDir: join(root, 'data'), resource: 'https://backtest.example/mcp',
    issuer: 'https://identity.example', jwksUrl: 'https://identity.example/jwks', ownerSubject: 'owner-fixture' };
  try {
    writeFileSync(config, JSON.stringify(value), { mode: 0o600 });
    assert.equal(loadRemoteConfig(config).listenHost, '127.0.0.1');
    assert.equal(loadRemoteConfig(config).port, 8789);
    chmodSync(config, 0o644);
    assert.throws(() => loadRemoteConfig(config));
    chmodSync(config, 0o600);
    const link = join(root, 'link'); symlinkSync(config, link);
    assert.throws(() => loadRemoteConfig(link));
    assert.throws(() => readOperatorFile(root, 1024));
    assert.throws(() => readOperatorFile(config, 3));
    writeFileSync(config, JSON.stringify({ ...value, userId: 'model-chosen' }));
    assert.throws(() => loadRemoteConfig(config));
    writeFileSync(config, JSON.stringify({ ...value, storageDir: 'relative' }));
    assert.throws(() => loadRemoteConfig(config));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('admin explicitly transfers exact JSON bytes with protected token, never follows redirects or accepts insecure destination', async t => {
  const root = mkdtempSync(join(tmpdir(), 'backtest-admin-'));
  const token = join(root, 'token'); const file = join(root, 'report.json');
  const reportId = '29900900-c6d8-40e9-bc31-82276e58b004';
  const bytes = Buffer.from('{"strategy":{"fixture":{"starting_balance":1000,"trades":[]}}}');
  const env = { BACKTEST_TOKEN_FILE: token, BACKTEST_RESOURCE: 'https://backtest.example/mcp' };
  try {
    writeFileSync(token, 'header.payload.signature\n', { mode: 0o600 });
    writeFileSync(file, bytes);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
      calls.push({ url: input.href, init });
      return new Response(JSON.stringify(init.method === 'POST' ? {
        schemaVersion: 2, reportId, importedAt: '2026-10-18T15:00:00.000Z', reportSha256: 'a'.repeat(64),
        parserVersion: 'freqtrade-reduced-v2', state: 'AVAILABLE', duplicate: false,
      } : { schemaVersion: 2, reportId, state: 'REMOVED' }), { status: 200 });
    });
    await administer(['import', file], env);
    assert.equal(calls[0]!.url, 'https://backtest.example/admin/reports');
    assert.equal(calls[0]!.init.redirect, 'error');
    const envelope = JSON.parse(calls[0]!.init.body as string);
    assert.deepEqual(Buffer.from(envelope.reportBase64, 'base64'), bytes);
    assert.deepEqual(envelope.contexts, {});
    await administer(['remove', reportId], env);
    assert.equal(calls[1]!.init.method, 'DELETE');
    await assert.rejects(administer(['remove', '../private'], env));
    await assert.rejects(administer(['import', file], { ...env, BACKTEST_RESOURCE: 'http://backtest.example/mcp' }));
    chmodSync(token, 0o644);
    await assert.rejects(administer(['import', file], env));
    assert.equal(calls.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
