import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { AuthorizationError, createJwtAuthorization, type JwtAuthorizationConfig } from '../src/auth.js';

const now = new Date('2026-10-18T15:00:00.000Z');
const epoch = Math.floor(now.getTime() / 1000);
const key = await generateKeyPair('ES256', { extractable: true });
const unrelated = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...await exportJWK(key.publicKey), kid: 'test-key', alg: 'ES256', use: 'sig' };
const config: JwtAuthorizationConfig = {
  issuer: 'https://identity.example.invalid/tenant/',
  resource: 'https://backtest.example.invalid/mcp',
  jwksUrl: 'https://identity.example.invalid/tenant/jwks',
  allowedSubjects: ['owner-subject'],
  supportedScopes: ['backtest:read', 'backtest:import', 'backtest:delete'],
};
const auth = createJwtAuthorization(config, {
  keyResolver: createLocalJWKSet({ keys: [jwk] }), currentDate: () => now,
});

async function signed(overrides: JWTPayload = {}, header: Record<string, unknown> = {}, signingKey = key.privateKey) {
  return new SignJWT({
    iss: config.issuer, aud: config.resource, sub: 'owner-subject',
    iat: epoch - 10, exp: epoch + 300, scope: 'backtest:read', ...overrides,
  }).setProtectedHeader({ alg: 'ES256', kid: 'test-key', typ: 'at+jwt', ...header }).sign(signingKey);
}

async function rejects(header: string | undefined, status: number, code: string, needed?: readonly string[]) {
  await assert.rejects(() => auth.authenticate(header, needed), (error: unknown) => {
    assert.ok(error instanceof AuthorizationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.message, 'Authorization required.');
    assert.ok(!error.message.includes('owner-subject'));
    return true;
  });
}

test('JWT resource server verifies signature, provider, resource, expiry and owner, returning only a minimal principal', async () => {
  const token = await signed({ email: 'do-not-return@example.invalid', scope: 'backtest:read backtest:import' });
  const principal = await auth.authenticate(`Bearer ${token}`);
  assert.deepEqual(principal, { subject: 'owner-subject', scopes: ['backtest:read', 'backtest:import'], expiresAt: epoch + 300 });
  assert.ok(Object.isFrozen(principal));
  assert.ok(Object.isFrozen(principal.scopes));
  assert.ok(!JSON.stringify(principal).includes(token));
  assert.ok(!JSON.stringify(principal).includes('do-not-return'));
  assert.deepEqual(await auth.authenticate(`bearer ${token}`), principal);
});

test('JWT resource server rejects missing, malformed, duplicate and oversized bearer credentials', async () => {
  const valid = await signed();
  for (const header of [undefined, '', valid, `Basic ${valid}`, `Bearer ${valid} trailing`,
    `Bearer ${valid}, Bearer ${valid}`, `Bearer  ${valid}`, 'Bearer a.b.', 'Bearer a.b.c\n',
    `Bearer ${'x'.repeat(17 * 1024)}`]) await rejects(header, 401, 'invalid_token');
});

test('JWT resource server rejects expired and not-yet-valid tokens including the exact expiry boundary', async () => {
  for (const overrides of [
    { exp: epoch - 1 }, { exp: epoch }, { nbf: epoch + 1 }, { iat: epoch + 1 },
    { iat: epoch + 20, exp: epoch + 10 },
  ]) await rejects(`Bearer ${await signed(overrides)}`, 401, 'invalid_token');
});

test('JWT resource server rejects absent or malformed required claims without coercing numeric strings', async () => {
  const invalid: JWTPayload[] = [
    { exp: undefined }, { iat: undefined }, { sub: undefined }, { sub: '' },
    { exp: '2099999999' as unknown as number }, { exp: epoch + 0.5 }, { iat: epoch - 0.5 },
    { scope: undefined }, { scope: ['backtest:read'] }, { scope: 'backtest:read  backtest:import' },
    { scope: 'backtest:read\nbacktest:import' }, { scope: 'backtest:read\\escape' },
  ];
  for (const overrides of invalid) await rejects(`Bearer ${await signed(overrides)}`, 401, 'invalid_token');
});

test('JWT resource server rejects issuer and audience mismatch, missing audience and ID tokens', async () => {
  for (const overrides of [
    { iss: 'https://identity.example.invalid/other/' },
    { iss: 'https://identity.example.invalid/tenant' },
    { aud: 'https://other-resource.example.invalid/mcp' }, { aud: undefined },
    { aud: ['unrelated-client', 'other-resource'] },
  ]) await rejects(`Bearer ${await signed(overrides)}`, 401, 'invalid_token');
  await rejects(`Bearer ${await signed({}, { typ: 'JWT' })}`, 401, 'invalid_token');
  await rejects(`Bearer ${await signed({}, { typ: 'id+jwt' })}`, 401, 'invalid_token');
  assert.equal((await auth.authenticate(`Bearer ${await signed({ aud: [config.resource, 'another-api'] })}`)).subject, 'owner-subject');
});

test('JWT resource server rejects unsigned, wrong-signature and symmetric algorithm tokens', async () => {
  await rejects(`Bearer ${await signed({}, {}, unrelated.privateKey)}`, 401, 'invalid_token');
  const unsignedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: config.issuer, aud: config.resource, sub: 'owner-subject' })).toString('base64url');
  await rejects(`Bearer ${unsignedHeader}.${payload}.x`, 401, 'invalid_token');
  const symmetric = await new SignJWT({ iss: config.issuer, aud: config.resource, sub: 'owner-subject',
    iat: epoch - 1, exp: epoch + 20, scope: 'backtest:read' })
    .setProtectedHeader({ alg: 'HS256', kid: 'test-key', typ: 'at+jwt' }).sign(new Uint8Array(32).fill(7));
  await rejects(`Bearer ${symmetric}`, 401, 'invalid_token');
});

test('valid second-user and client credentials subjects do not inherit the owner identity', async () => {
  for (const subject of ['second-user', 'oauth-client-subject']) {
    await rejects(`Bearer ${await signed({ sub: subject, scope: 'backtest:read backtest:import' })}`, 403, 'access_denied');
  }
  assert.equal((await auth.authenticate(`Bearer ${await signed()}`)).subject, 'owner-subject');
});

test('route scopes are enforced separately so a read token cannot import or delete', async () => {
  const read = await signed();
  await rejects(`Bearer ${read}`, 403, 'insufficient_scope', ['backtest:import']);
  await rejects(`Bearer ${read}`, 403, 'insufficient_scope', ['backtest:delete']);
  await rejects(`Bearer ${await signed({ scope: '' })}`, 403, 'insufficient_scope');
  await rejects(`Bearer ${await signed({ scope: 'backtest:readonly' })}`, 403, 'insufficient_scope');
  const admin = await signed({ scope: 'backtest:import' });
  assert.equal((await auth.authenticate(`Bearer ${admin}`, ['backtest:import'])).subject, 'owner-subject');
  await rejects(`Bearer ${admin}`, 403, 'insufficient_scope');
});

test('discovery metadata and RFC6750 challenges contain fixed public configuration, no subject or credentials', () => {
  assert.deepEqual(auth.protectedResourceMetadata(), {
    resource: config.resource, authorization_servers: [config.issuer], bearer_methods_supported: ['header'],
    scopes_supported: ['backtest:read'],
  });
  assert.equal(auth.resourceMetadataUrl, 'https://backtest.example.invalid/.well-known/oauth-protected-resource');
  assert.equal(auth.challenge(), 'Bearer resource_metadata="https://backtest.example.invalid/.well-known/oauth-protected-resource", scope="backtest:read"');
  assert.match(auth.challenge(new AuthorizationError(401, 'invalid_token')), /error="invalid_token"$/);
  assert.match(auth.challenge(new AuthorizationError(403, 'insufficient_scope'), ['backtest:import']), /scope="backtest:import", error="insufficient_scope"$/);
  assert.ok(!auth.challenge(new AuthorizationError(403, 'access_denied')).includes('error='));
  assert.ok(!JSON.stringify(auth.protectedResourceMetadata()).includes('owner-subject'));
});

test('authorization configuration fails closed for insecure endpoints, empty owners/scopes and unsafe algorithms', () => {
  for (const overrides of [
    { issuer: 'http://identity.example.invalid' }, { resource: 'http://backtest.example.invalid' },
    { jwksUrl: 'https://user:password@identity.example.invalid/keys' },
    { jwksUrl: 'https://identity.example.invalid/keys?token=secret' },
    { issuer: `${config.issuer}#fragment` }, { issuer: `${config.issuer}\n` },
    { allowedSubjects: [] }, { allowedSubjects: ['first', 'second'] }, { allowedSubjects: [''] }, { allowedSubjects: ['x'.repeat(256)] },
    { requiredScopes: [] }, { requiredScopes: ['bad scope'] }, { requiredScopes: ['quote"scope'] },
    { requiredScopes: ['backtest:missing'] }, { algorithms: [] }, { algorithms: ['HS256'] },
  ]) assert.throws(() => createJwtAuthorization({ ...config, ...overrides } as JwtAuthorizationConfig));
});

test('token headers cannot nominate a remote JWKS or change the configured resolver', async () => {
  const token = await signed({}, { jku: 'https://untrusted.example.invalid/keys', x5u: 'https://untrusted.example.invalid/cert' });
  assert.equal((await auth.authenticate(`Bearer ${token}`)).subject, 'owner-subject');
  await rejects(`Bearer ${await signed({}, { kid: 'unknown-key' })}`, 401, 'invalid_token');
});

test('configuration and returned metadata are detached from later caller mutation', async () => {
  const mutable = { ...config, allowedSubjects: ['owner-subject'], supportedScopes: ['backtest:read'] };
  const independent = createJwtAuthorization(mutable, {
    keyResolver: createLocalJWKSet({ keys: [jwk] }), currentDate: () => now,
  });
  mutable.allowedSubjects[0] = 'second-user';
  mutable.supportedScopes.push('backtest:delete');
  independent.protectedResourceMetadata().scopes_supported.push('backtest:import');
  assert.deepEqual(independent.protectedResourceMetadata().scopes_supported, ['backtest:read']);
  assert.equal((await independent.authenticate(`Bearer ${await signed()}`)).subject, 'owner-subject');
  const token = await signed();
  await assert.rejects(() => independent.authenticate(`Bearer ${token}`, ['backtest:import']));
});

test('key resolution failure is a generic authentication failure, without leaking provider internals', async () => {
  const unavailable = createJwtAuthorization(config, { keyResolver: async () => {
    throw new Error('provider-error /private/location token=do-not-return');
  }, currentDate: () => now });
  const token = await signed();
  await assert.rejects(() => unavailable.authenticate(`Bearer ${token}`), (error: unknown) => {
    assert.ok(error instanceof AuthorizationError);
    assert.equal(error.code, 'invalid_token');
    assert.equal(error.message, 'Authorization required.');
    return true;
  });
});
