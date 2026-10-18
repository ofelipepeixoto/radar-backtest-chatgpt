import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { MAX_BYTES, parseStrictJson } from './report.js';
import { OperatorContextSchema } from './context.js';
import { ImportResultSchema, ReportIdSchema } from './catalog.js';
import { readOperatorFile } from './operator-config.js';

/** Only the operator invokes this CLI. Tokens are read from an OS-protected file. */
export async function administer(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<object> {
  if (!env.BACKTEST_RESOURCE || !env.BACKTEST_TOKEN_FILE) throw new Error();
  const resource = new URL(env.BACKTEST_RESOURCE);
  if (resource.protocol !== 'https:' || resource.username || resource.password || resource.search || resource.hash || resource.pathname !== '/mcp') throw new Error();
  const token = readOperatorFile(env.BACKTEST_TOKEN_FILE, 16 * 1024, true).toString('utf8').trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
  let url = new URL('/admin/reports', resource);
  let method: 'POST' | 'DELETE';
  let body: string | undefined;
  if (args[0] === 'import' && (args.length === 2 || args.length === 3)) {
    const bytes = readOperatorFile(args[1]!, MAX_BYTES);
    // Validate locally as well; the server independently repeats all validation.
    parseStrictJson(bytes);
    const contexts = args[2] ? z.record(z.string().regex(/^strategy-[1-9][0-9]?$/), OperatorContextSchema)
      .parse(parseStrictJson(readOperatorFile(args[2], 32 * 1024), 32 * 1024)) : {};
    method = 'POST';
    body = JSON.stringify({ schemaVersion: 2, reportBase64: bytes.toString('base64'), contexts });
  } else if (args[0] === 'remove' && args.length === 2) {
    url = new URL(`/admin/reports/${ReportIdSchema.parse(args[1])}`, resource);
    method = 'DELETE';
  } else throw new Error();
  // HTTPS only; redirects must never move a bearer token to a different destination.
  const response = await fetch(url, {
    method, body, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  if (!response.ok) throw new Error();
  const data: unknown = await response.json();
  return method === 'POST' ? ImportResultSchema.parse(data) : z.object({ schemaVersion: z.literal(2), reportId: ReportIdSchema, state: z.literal('REMOVED') }).strict().parse(data);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  administer(process.argv.slice(2)).then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); }).catch(() => {
    process.stderr.write('Administrative request rejected.\n');
    process.exitCode = 1;
  });
}
