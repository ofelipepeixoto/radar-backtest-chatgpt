import { createServer as createNodeServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { portFromEnvironment, selectReport } from './cli.js';
import type { Report } from './report.js';

const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

function reject(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: 'Request rejected.' }));
}

async function body(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    reject(response, 413);
    request.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) {
      reject(response, 413);
      request.resume();
      return undefined;
    }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { reject(response, 400); return undefined; }
}

/** Loopback-only development transport. It is not an authenticated remote service. */
export function createHttpServer(report: Report, port: number): Server {
  const server = createNodeServer(async (request, response) => {
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : port;
    const host = `127.0.0.1:${listeningPort}`;
    const expectedOrigin = `http://${host}`;
    response.setHeader('Cache-Control', 'no-store');
    const rawHost = request.headers.host;
    const origin = request.headers.origin;
    if (rawHost !== host || (origin !== undefined && origin !== expectedOrigin)) {
      reject(response, 403);
      return;
    }
    if (request.url !== '/mcp') { reject(response, 404); return; }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      reject(response, 405);
      return;
    }
    const timer = setTimeout(() => {
      if (!response.headersSent) reject(response, 408);
      else response.destroy();
      request.destroy();
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    response.on('close', () => clearTimeout(timer));
    try {
      const parsed = await body(request, response);
      if (response.writableEnded || parsed === undefined) return;
      const mcp = createServer(report);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on('close', () => {
        void transport.close().catch(() => {});
        void mcp.close().catch(() => {});
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, parsed);
    } catch {
      if (!response.headersSent) reject(response, 400);
      else if (!response.writableEnded) response.end();
    } finally { clearTimeout(timer); }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.timeout = REQUEST_TIMEOUT_MS;
  server.maxHeadersCount = 32;
  return server;
}

async function main(): Promise<void> {
  const report = selectReport(process.argv.slice(2));
  const port = portFromEnvironment();
  const server = createHttpServer(report, port);
  await new Promise<void>((resolve, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', resolve);
  });
  process.stderr.write('Offline backtest review service listening on loopback.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Unable to start the offline backtest review service.\n');
    process.exitCode = 1;
  });
}
