import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { AuthorizationError, READ_SCOPE, type JwtAuthorization } from './auth.js';
import { PrivateCatalog } from './catalog.js';
import { createCatalogServer } from './catalog-server.js';
import { OperatorContextSchema } from './context.js';
import { MAX_BYTES, parseStrictJson } from './report.js';

const IMPORT_SCOPE = 'backtest:import';
const ADMIN_SCOPE = 'backtest:admin';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADMIN_BODY_BYTES = 3 * 1024 * 1024;
const MCP_BODY_BYTES = 16 * 1024;

/** Separate administrative contract. This envelope is never accepted by an MCP tool. */
export const ImportEnvelopeSchema = z.object({
  schemaVersion: z.literal(2),
  reportBase64: z.string().min(4).max(4 * Math.ceil(MAX_BYTES / 3)),
  contexts: z.record(z.string().regex(/^strategy-[1-9][0-9]?$/), OperatorContextSchema)
    .refine(value => Object.keys(value).length <= 32),
}).strict();

export interface RemoteHttpLimits {
  readonly requestTimeoutMs?: number;
  readonly maxConcurrentRequests?: number;
  readonly globalRequestsPerMinute?: number;
  readonly subjectRequestsPerMinute?: number;
  readonly maxTrackedSubjects?: number;
  readonly mcpBodyBytes?: number;
  readonly adminBodyBytes?: number;
}
export interface RemoteHttpOptions {
  readonly catalog: PrivateCatalog;
  readonly authorization: JwtAuthorization;
  /** Public HTTPS resource. A reverse proxy terminates TLS; forwarded headers confer no trust. */
  readonly resource: string;
  readonly allowedOrigins?: readonly string[];
  readonly limits?: RemoteHttpLimits;
  /** Optional fixed-field operational event. It never receives identity, input, path or credentials. */
  readonly onEvent?: (event: RemoteRequestEvent) => void;
}
export interface RemoteRequestEvent {
  readonly requestId: string;
  readonly status: number;
  readonly durationMs: number;
  readonly route: 'MCP' | 'ADMIN_IMPORT' | 'ADMIN_REMOVE' | 'METADATA' | 'HEALTH' | 'OTHER';
}

class RequestError extends Error {
  constructor(readonly status: number) { super('Request rejected.'); }
}
function bounded(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('Invalid remote configuration.');
  return result;
}
function respond(response: ServerResponse, status: number, value: object): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.end(); return; }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
function reject(response: ServerResponse, status: number): void {
  respond(response, status, { error: 'Request rejected.' });
}
function uniqueHeaders(request: IncomingMessage): boolean {
  const sensitive = new Set(['host', 'authorization', 'origin', 'content-type', 'content-length', 'content-encoding']);
  const seen = new Set<string>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const key = request.rawHeaders[index]!.toLowerCase();
    if (!sensitive.has(key)) continue;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
function jsonMediaType(request: IncomingMessage): void {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType) ||
      (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity')) {
    throw new RequestError(415);
  }
}
async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  jsonMediaType(request);
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > maxBytes)) {
    request.resume();
    throw new RequestError(413);
  }
  const bytes = await new Promise<Buffer>((resolve, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('aborted', aborted);
      request.removeListener('error', aborted);
    };
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        cleanup(); request.resume(); rejectPromise(new RequestError(413));
      } else chunks.push(buffer);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const aborted = () => { cleanup(); rejectPromise(new RequestError(400)); };
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', aborted);
  });
  try { return parseStrictJson(bytes, maxBytes); }
  catch { throw new RequestError(400); }
}
function decodeReport(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new RequestError(400);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > MAX_BYTES || bytes.toString('base64') !== value) throw new RequestError(400);
  return bytes;
}
interface Window { started: number; count: number; }
function consume(window: Window, now: number, limit: number): boolean {
  if (now - window.started >= 60_000) { window.started = now; window.count = 0; }
  if (window.count >= limit) return false;
  window.count++;
  return true;
}

/** Authenticated, stateless remote profile, deliberately separate from http.ts loopback development. */
export function createRemoteHttpServer(options: RemoteHttpOptions): Server {
  const resource = new URL(options.resource);
  if (resource.protocol !== 'https:' || resource.pathname !== '/mcp' || resource.search || resource.hash ||
      resource.username || resource.password || resource.href !== options.resource ||
      options.authorization.protectedResourceMetadata().resource !== options.resource) throw new Error('Invalid remote configuration.');
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  if (allowedOrigins.size > 16) throw new Error('Invalid remote configuration.');
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) throw new Error('Invalid remote configuration.');
  }
  const limits = options.limits ?? {};
  const timeout = bounded(limits.requestTimeoutMs, 10_000, 60_000);
  const concurrentLimit = bounded(limits.maxConcurrentRequests, 16, 128);
  const globalLimit = bounded(limits.globalRequestsPerMinute, 120, 10_000);
  const subjectLimit = bounded(limits.subjectRequestsPerMinute, 60, 10_000);
  const trackedLimit = bounded(limits.maxTrackedSubjects, 64, 1024);
  const mcpBytes = bounded(limits.mcpBodyBytes, MCP_BODY_BYTES, MCP_BODY_BYTES);
  const adminBytes = bounded(limits.adminBodyBytes, ADMIN_BODY_BYTES, ADMIN_BODY_BYTES);
  const globalWindow: Window = { started: Date.now(), count: 0 };
  const subjects = new Map<string, Window>();
  let concurrent = 0;

  const server = createServer(async (request, response) => {
    const started = Date.now();
    const requestId = randomUUID();
    const route: RemoteRequestEvent['route'] = request.url === '/mcp' ? 'MCP' : request.url === '/admin/reports' ? 'ADMIN_IMPORT' :
      /^\/admin\/reports\/[^/]+$/.test(request.url ?? '') ? 'ADMIN_REMOVE' : request.url === '/healthz' ? 'HEALTH' :
        request.url === '/.well-known/oauth-protected-resource' || request.url === '/.well-known/oauth-protected-resource/mcp' ? 'METADATA' : 'OTHER';
    let observed = false;
    const observe = () => {
      if (observed) return;
      observed = true;
      const event: RemoteRequestEvent = Object.freeze({ requestId, status: response.writableFinished ? response.statusCode : 499,
        durationMs: Math.max(0, Date.now() - started), route });
      try { options.onEvent?.(event); } catch { /* Logging cannot change authorization or availability. */ }
    };
    response.once('finish', observe);
    response.once('close', observe);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const discard = () => { if (!request.complete) request.resume(); };
    response.once('finish', discard);
    if (!uniqueHeaders(request)) { reject(response, 400); return; }
    if (request.headers.host !== resource.host ||
        (request.headers.origin !== undefined && !allowedOrigins.has(request.headers.origin))) {
      reject(response, 403); return;
    }
    if (!consume(globalWindow, Date.now(), globalLimit)) {
      response.setHeader('Retry-After', '60'); reject(response, 429); return;
    }
    if (concurrent >= concurrentLimit) {
      response.setHeader('Retry-After', '1'); reject(response, 503); return;
    }
    concurrent++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; concurrent--; clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (!response.headersSent) {
        response.once('finish', () => request.destroy());
        reject(response, 408);
      } else response.destroy();
    }, timeout);
    timer.unref();
    response.once('finish', release);
    response.once('close', release);
    let transport: StreamableHTTPServerTransport | undefined;
    let mcp: ReturnType<typeof createCatalogServer> | undefined;
    try {
      const path = request.url;
      if (path === '/healthz') {
        if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw new RequestError(405); }
        respond(response, 200, { status: 'ok' }); return;
      }
      if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
        if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw new RequestError(405); }
        respond(response, 200, options.authorization.protectedResourceMetadata()); return;
      }
      const removeId = /^\/admin\/reports\/([^/]+)$/.exec(path ?? '')?.[1];
      const required = path === '/mcp' ? [READ_SCOPE] : path === '/admin/reports' ? [IMPORT_SCOPE] : removeId ? [ADMIN_SCOPE] : null;
      if (!required) throw new RequestError(404);
      const principal = await options.authorization.authenticate(request.headers.authorization, required).catch(error => {
        if (error instanceof AuthorizationError) {
          response.setHeader('WWW-Authenticate', options.authorization.challenge(error, required));
          throw new RequestError(error.status);
        }
        throw error;
      });
      if (response.writableEnded || response.destroyed) return;
      const now = Date.now();
      for (const [subject, window] of subjects) if (now - window.started >= 60_000) subjects.delete(subject);
      let window = subjects.get(principal.subject);
      if (!window) {
        if (subjects.size >= trackedLimit) { response.setHeader('Retry-After', '60'); throw new RequestError(429); }
        window = { started: now, count: 0 }; subjects.set(principal.subject, window);
      }
      if (!consume(window, now, subjectLimit)) { response.setHeader('Retry-After', '60'); throw new RequestError(429); }
      if (path === '/mcp') {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw new RequestError(405); }
        const parsed = await readJson(request, mcpBytes);
        if (response.writableEnded || response.destroyed) return;
        mcp = createCatalogServer(options.catalog, principal);
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const close = () => {
          void transport?.close().catch(() => {});
          void mcp?.close().catch(() => {});
        };
        response.once('close', close);
        response.once('finish', close);
        await mcp.connect(transport);
        await transport.handleRequest(request, response, parsed);
      } else if (path === '/admin/reports') {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw new RequestError(405); }
        const parsed = ImportEnvelopeSchema.safeParse(await readJson(request, adminBytes));
        if (!parsed.success) throw new RequestError(400);
        const bytes = decodeReport(parsed.data.reportBase64);
        if (response.writableEnded || response.destroyed) return;
        try {
          const result = options.catalog.importReport(principal, bytes, parsed.data.contexts);
          respond(response, result.duplicate ? 200 : 201, result);
        } catch { throw new RequestError(400); }
      } else {
        if (request.method !== 'DELETE') { response.setHeader('Allow', 'DELETE'); throw new RequestError(405); }
        if (!removeId || !UUID.test(removeId)) throw new RequestError(404);
        if (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) throw new RequestError(400);
        try { respond(response, 200, options.catalog.removeReport(principal, removeId)); }
        catch { throw new RequestError(404); }
      }
    } catch (error) {
      reject(response, error instanceof RequestError ? error.status : 500);
    }
  });
  server.requestTimeout = timeout;
  server.headersTimeout = timeout;
  server.timeout = timeout;
  server.maxHeadersCount = 32;
  // Bound idle and partial-header sockets as well as authenticated in-flight requests.
  server.maxConnections = Math.max(16, concurrentLimit * 4);
  server.maxRequestsPerSocket = 100;
  server.keepAliveTimeout = Math.min(5_000, timeout);
  return server;
}
