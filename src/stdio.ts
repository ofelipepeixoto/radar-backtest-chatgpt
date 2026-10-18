import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { selectReport } from './cli.js';

try {
  const server = createServer(selectReport(process.argv.slice(2)));
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write('Unable to start the offline backtest review service.\n');
  process.exitCode = 1;
}
