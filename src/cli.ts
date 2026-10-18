import { demoReport, loadReport, type Report } from './report.js';

/** Only the operator may choose a local report, before an MCP client connects. */
export function selectReport(args: string[]): Report {
  if (args.length === 1 && args[0] === '--demo') return demoReport();
  if (args.length === 2 && args[0] === '--report' && args[1]) return loadReport(args[1]);
  throw new Error('An explicit report selection is required.');
}

export function portFromEnvironment(value = process.env.PORT): number {
  if (value === undefined) return 8788;
  if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error('Invalid port.');
  const port = Number(value);
  if (port < 1024 || port > 65535) throw new Error('Invalid port.');
  return port;
}
