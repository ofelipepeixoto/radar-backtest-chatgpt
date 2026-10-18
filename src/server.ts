import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Report } from './report.js';

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function result(value: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure() {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: 'Unable to review the selected report.' }],
  };
}

/** The report is selected at process startup, never through an MCP argument. */
export function createServer(report: Report): McpServer {
  const server = new McpServer({ name: 'radar-backtest-chatgpt', version: '0.1.0' });
  const listSchema = z.object({}).strict();
  const analyzeSchema = z.object({ strategyId: z.string().regex(/^strategy-[1-9][0-9]?$/) }).strict();
  server.registerTool('backtest_list_reports', {
    description: 'List anonymized strategies available in the offline report selected at startup.',
    inputSchema: listSchema,
    annotations,
  }, async () => {
    try { return result(report.list()); } catch { return failure(); }
  });
  server.registerTool('backtest_analyze_report', {
    description: 'Review historical backtest metrics for an anonymized strategy. Does not predict returns or submit orders.',
    inputSchema: analyzeSchema,
    annotations,
  }, async ({ strategyId }) => {
    try { return result(report.analyze(strategyId)); } catch { return failure(); }
  });
  // Public low-level handler enforces the same schemas while redacting SDK validation
  // errors, which otherwise echo attacker-controlled tool names or unknown field names.
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.task) return failure();
      const args = request.params.arguments ?? {};
      if (request.params.name === 'backtest_list_reports' && listSchema.safeParse(args).success) {
        return result(report.list());
      }
      if (request.params.name === 'backtest_analyze_report') {
        const parsed = analyzeSchema.safeParse(args);
        if (parsed.success) return result(report.analyze(parsed.data.strategyId));
      }
      return failure();
    } catch { return failure(); }
  });
  return server;
}
