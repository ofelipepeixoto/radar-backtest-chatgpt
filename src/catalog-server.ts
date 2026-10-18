import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PrivateCatalog, ReportReferenceSchema, ListReportsResultSchema, AnalyzeReportResultSchema } from './catalog.js';
import { compareAnalyses, ComparisonSchema } from './comparison.js';

export const ListReportsInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(1024).optional(),
}).strict();
export const CompareReportsInputSchema = z.object({ left: ReportReferenceSchema, right: ReportReferenceSchema }).strict();
export const CompareReportsResultSchema = z.object({
  schemaVersion: z.literal(2),
  left: AnalyzeReportResultSchema,
  right: AnalyzeReportResultSchema,
  comparison: ComparisonSchema,
}).strict();
export const CatalogErrorSchema = z.object({
  schemaVersion: z.literal(2),
  error: z.object({ code: z.literal('REQUEST_REJECTED'), retryable: z.literal(false) }).strict(),
}).strict();

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const securitySchemes = [{ type: 'oauth2', scopes: ['backtest:read'] }];

function success(schema: z.ZodTypeAny, value: unknown) {
  const data = schema.parse(value);
  return { structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}
function failure() {
  const error = CatalogErrorSchema.parse({ schemaVersion: 2, error: { code: 'REQUEST_REJECTED', retryable: false } });
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
}

/** Identity is fixed by the authenticated transport, never by tool arguments. */
export function createCatalogServer(catalog: PrivateCatalog, principal: { subject: string }): McpServer {
  const identity = Object.freeze({ subject: principal.subject });
  const server = new McpServer({ name: 'radar-backtest-private', version: '0.2.0' });
  const configs = [
    {
      name: 'backtest_v2_list_reports',
      description: 'List this authenticated owner’s private historical reports. Use reportId plus strategyId from this list; follow nextCursor for more results.',
      input: ListReportsInputSchema, output: ListReportsResultSchema,
    },
    {
      name: 'backtest_v2_analyze_report',
      description: 'Analyze one authorized reportId and strategyId. Returns deterministic historical metrics, evidence digest, declared context and inconsistencies. No orders or forecasts.',
      input: ReportReferenceSchema, output: AnalyzeReportResultSchema,
    },
    {
      name: 'backtest_v2_compare_reports',
      description: 'Compare two authorized report/strategy references. Respect comparability and missing context; no investment ranking. Currency or decisive context mismatch prevents direct conclusions.',
      input: CompareReportsInputSchema, output: CompareReportsResultSchema,
    },
  ];
  // A narrow dispatch table enforces identical strict validation for every call.
  for (const config of configs) {
    server.registerTool(config.name, {
      description: config.description, inputSchema: config.input, outputSchema: config.output,
      annotations, _meta: { securitySchemes },
    }, async () => failure());
  }
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.task) return failure();
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      if (name === 'backtest_v2_list_reports') return success(ListReportsResultSchema, catalog.listReports(identity, ListReportsInputSchema.parse(args)));
      if (name === 'backtest_v2_analyze_report') {
        const ref = ReportReferenceSchema.parse(args);
        return success(AnalyzeReportResultSchema, catalog.analyzeReport(identity, ref.reportId, ref.strategyId));
      }
      if (name === 'backtest_v2_compare_reports') {
        const refs = CompareReportsInputSchema.parse(args);
        const left = catalog.analyzeReport(identity, refs.left.reportId, refs.left.strategyId);
        const right = catalog.analyzeReport(identity, refs.right.reportId, refs.right.strategyId);
        return success(CompareReportsResultSchema, { schemaVersion: 2, left, right, comparison: compareAnalyses(left.analysis, right.analysis) });
      }
      return failure();
    } catch { return failure(); }
  });
  return server;
}
