import { pathToFileURL } from 'node:url';
import { createJwtAuthorization } from './auth.js';
import { PrivateCatalog } from './catalog.js';
import { createRemoteHttpServer } from './remote-http.js';
import { loadRemoteConfig } from './operator-config.js';

async function main(): Promise<void> {
  const configPath = process.env.BACKTEST_CONFIG;
  if (!configPath || process.argv.length !== 2) throw new Error();
  const config = loadRemoteConfig(configPath);
  const authorization = createJwtAuthorization({
    issuer: config.issuer, resource: config.resource, jwksUrl: config.jwksUrl,
    allowedSubjects: [config.ownerSubject], requiredScopes: ['backtest:read'],
    supportedScopes: ['backtest:read', 'backtest:import', 'backtest:admin'],
  });
  const catalog = new PrivateCatalog(config.storageDir, config.issuer);
  const server = createRemoteHttpServer({
    catalog, authorization, resource: config.resource, allowedOrigins: config.allowedOrigins,
    onEvent: event => { process.stderr.write(`${JSON.stringify({ timestampUTC: new Date().toISOString(), event: 'http_complete', ...event })}\n`); },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.listenHost, resolve);
  });
  process.stderr.write('Private backtest resource server started.\n');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => { process.exitCode = 0; });
    const timer = setTimeout(() => { server.closeAllConnections(); }, 10_000);
    timer.unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Unable to start the private backtest resource server.\n');
    process.exitCode = 1;
  });
}
