import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const READ_SCOPE = 'backtest:read';
const MAX_AUTHORIZATION_BYTES = 16 * 1024;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const ALGORITHMS = ['RS256', 'ES256'] as const;

/** The backend derives this principal from a verified access token, never MCP arguments. */
export interface AuthPrincipal {
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

export interface JwtAuthorizationConfig {
  readonly issuer: string;
  /** Exact RFC 8707 identifier, which must appear in the access token's aud claim. */
  readonly resource: string;
  /** Operator-pinned URL. JWT jku/x5u headers and request parameters never select keys. */
  readonly jwksUrl: string;
  /** This first pilot authorizes exactly one owner. */
  readonly allowedSubjects: readonly string[];
  readonly requiredScopes?: readonly string[];
  /** Allowed route scopes; discovery advertises only requiredScopes for basic MCP use. */
  readonly supportedScopes?: readonly string[];
  readonly algorithms?: readonly (typeof ALGORITHMS[number])[];
}

export type AuthorizationErrorCode = 'invalid_token' | 'insufficient_scope' | 'access_denied';

export class AuthorizationError extends Error {
  constructor(readonly status: 401 | 403, readonly code: AuthorizationErrorCode) {
    super('Authorization required.');
    this.name = 'AuthorizationError';
  }
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
}

export interface JwtAuthorization {
  readonly resourceMetadataUrl: string;
  authenticate(header: string | undefined, requiredScopes?: readonly string[]): Promise<AuthPrincipal>;
  protectedResourceMetadata(): ProtectedResourceMetadata;
  challenge(error?: AuthorizationError, requiredScopes?: readonly string[]): string;
}

/** Test seams inject a local, signed JWKS and clock; remote setup never accepts them from HTTP. */
export interface JwtAuthorizationOptions {
  readonly keyResolver?: JWTVerifyGetKey;
  readonly currentDate?: () => Date;
}

function endpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Invalid authorization configuration.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      value !== value.trim() || /[\u0000-\u0020\u007f"\\]/u.test(value)) {
    throw new Error('Invalid authorization configuration.');
  }
  return url;
}

function scopes(values: readonly string[]): string[] {
  if (!values.length || values.length > 16 || values.some(value =>
    typeof value !== 'string' || value.length > 128 || !SCOPE_TOKEN.test(value))) {
    throw new Error('Invalid authorization configuration.');
  }
  return [...new Set(values)];
}

/**
 * Resource server for an established OAuth provider's typed (at+jwt) JWT access tokens.
 * Login, consent, authorization-code + S256 PKCE, registration and refresh stay at the provider.
 * No token is logged, retained in the principal, forwarded or accepted as an identity argument.
 */
export function createJwtAuthorization(
  config: JwtAuthorizationConfig,
  options: JwtAuthorizationOptions = {},
): JwtAuthorization {
  endpoint(config.issuer);
  const resourceUrl = endpoint(config.resource);
  const jwksUrl = endpoint(config.jwksUrl);
  if (config.allowedSubjects.length !== 1 || config.allowedSubjects.some(subject =>
    typeof subject !== 'string' || subject.length < 1 || subject.length > 255 || /[\u0000-\u0020\u007f]/u.test(subject))) {
    throw new Error('Exactly one owner subject is required.');
  }
  const owner = config.allowedSubjects[0]!;
  const requiredScopes = scopes(config.requiredScopes ?? [READ_SCOPE]);
  const supportedScopes = scopes(config.supportedScopes ?? requiredScopes);
  if (requiredScopes.some(scope => !supportedScopes.includes(scope))) throw new Error('Invalid authorization configuration.');
  const algorithms = [...(config.algorithms ?? ALGORITHMS)];
  if (!algorithms.length || algorithms.some(algorithm => !ALGORITHMS.includes(algorithm))) {
    throw new Error('Invalid authorization configuration.');
  }
  const issuer = config.issuer;
  const resource = config.resource;
  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource', resourceUrl.origin).href;
  const keyResolver = options.keyResolver ?? createRemoteJWKSet(jwksUrl, {
    timeoutDuration: 3_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 5 * 60_000,
  });
  function requiredForRequest(values?: readonly string[]): string[] {
    const requested = values === undefined ? requiredScopes : scopes(values);
    if (requested.some(scope => !supportedScopes.includes(scope))) throw new Error('Invalid authorization configuration.');
    return requested;
  }
  return Object.freeze({
    resourceMetadataUrl,
    async authenticate(header: string | undefined, requestedScopes?: readonly string[]): Promise<AuthPrincipal> {
      const needed = requiredForRequest(requestedScopes);
      if (typeof header !== 'string' || Buffer.byteLength(header, 'utf8') > MAX_AUTHORIZATION_BYTES) {
        throw new AuthorizationError(401, 'invalid_token');
      }
      const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
      if (!match) throw new AuthorizationError(401, 'invalid_token');
      let validated: { subject: string; exp: number; scope: string };
      try {
        const { payload } = await jwtVerify(match[1]!, keyResolver, {
          algorithms,
          issuer,
          audience: resource,
          typ: 'at+jwt',
          requiredClaims: ['exp', 'iat', 'sub'],
          currentDate: options.currentDate?.(),
          clockTolerance: 0,
        });
        const now = (options.currentDate?.() ?? new Date()).getTime() / 1000;
        if (typeof payload.sub !== 'string' || !payload.sub ||
            typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) ||
            typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat) ||
            payload.iat > now || payload.exp <= payload.iat ||
            typeof payload.scope !== 'string' || payload.scope.length > 2048) {
          throw new Error('Invalid token.');
        }
        validated = { subject: payload.sub, exp: payload.exp, scope: payload.scope };
      } catch {
        throw new AuthorizationError(401, 'invalid_token');
      }
      // Verify signature and token profile before applying the owner policy.
      if (validated.subject !== owner) throw new AuthorizationError(403, 'access_denied');
      const granted = validated.scope === '' ? [] : validated.scope.split(' ');
      if (granted.some(scope => !SCOPE_TOKEN.test(scope))) throw new AuthorizationError(401, 'invalid_token');
      if (needed.some(scope => !granted.includes(scope))) throw new AuthorizationError(403, 'insufficient_scope');
      return Object.freeze({ subject: validated.subject, scopes: Object.freeze([...new Set(granted)]), expiresAt: validated.exp });
    },
    protectedResourceMetadata(): ProtectedResourceMetadata {
      return {
        resource,
        authorization_servers: [issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: [...requiredScopes],
      };
    },
    challenge(error?: AuthorizationError, requestedScopes?: readonly string[]): string {
      const needed = requiredForRequest(requestedScopes);
      const parts = [`resource_metadata="${resourceMetadataUrl}"`, `scope="${needed.join(' ')}"`];
      if (error?.code === 'invalid_token' || error?.code === 'insufficient_scope') parts.push(`error="${error.code}"`);
      return `Bearer ${parts.join(', ')}`;
    },
  });
}
