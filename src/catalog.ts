import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { z } from 'zod';
import { Report, ReportSnapshotSchema, AnalysisWithContextSchema, parseStrictJson, type ReportSnapshot } from './report.js';
import type { OperatorContext } from './context.js';

/** This is a backend identity. It is never taken from an MCP tool argument. */
export interface CatalogPrincipal { readonly subject: string; }
export class CatalogError extends Error {
  constructor() { super('CATALOG_UNAVAILABLE'); }
}
const fail = (): never => { throw new CatalogError(); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_CATALOG_REPORTS = 1000;
export const MAX_PAGE_SIZE = 50;
export const ReportIdSchema = z.string().regex(UUID);
const StrategyIdSchema = z.string().regex(/^strategy-[1-9][0-9]?$/);
const MetadataShape = { reportId: ReportIdSchema, importedAt: z.string().datetime(),
  reportSha256: z.string().regex(SHA), parserVersion: z.literal('freqtrade-reduced-v2') };
export const ReportReferenceSchema = z.object({ reportId: ReportIdSchema, strategyId: StrategyIdSchema }).strict();
export const ImportResultSchema = z.object({ schemaVersion: z.literal(2), ...MetadataShape,
  state: z.literal('AVAILABLE'), duplicate: z.boolean() }).strict();
export const ListReportsResultSchema = z.object({ schemaVersion: z.literal(2), reports: z.array(z.object({
  ...MetadataShape, state: z.literal('AVAILABLE'), demo: z.boolean(),
  strategies: z.array(z.object({ strategyId: StrategyIdSchema, tradeCount: z.number().int().min(0).max(10000) }).strict()).min(1).max(32),
}).strict()).max(MAX_PAGE_SIZE), nextCursor: z.string().max(512).nullable() }).strict();
export const AnalyzeReportResultSchema = z.object({ schemaVersion: z.literal(2), ...MetadataShape,
  demo: z.boolean(), analysis: AnalysisWithContextSchema }).strict();
const RecordSchema = z.object({
  storageVersion: z.literal(1), reportId: z.string().regex(UUID), ownerKey: z.string().regex(SHA),
  importedAt: z.string().datetime(), snapshot: ReportSnapshotSchema,
}).strict();
type StoredReport = z.infer<typeof RecordSchema>;
const CursorSchema = z.object({ version: z.literal(1), after: z.string().regex(UUID) }).strict();

function ownerKey(principal: CatalogPrincipal, namespace: string): string {
  const subject = principal?.subject;
  if (typeof subject !== 'string' || subject.length < 1 || subject.length > 255 || /[\u0000-\u001f\u007f]/u.test(subject)) return fail();
  return createHash('sha256').update('radar-catalog-owner-v1\0').update(namespace).update('\0').update(subject).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function privateInfo(info: Stats, directory = false): void {
  if ((directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o777) !== (directory ? 0o700 : 0o600)) fail();
  if (process.getuid && info.uid !== process.getuid()) fail();
}
function readPrivate(path: string, maxBytes: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor); privateInfo(info);
    if (info.size < 1 || info.size > maxBytes) return fail();
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size !== info.size) return fail();
    return bytes.subarray(0, size);
  } catch { return fail(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
export function parseBoundedJson(bytes: Buffer, maxBytes = MAX_RECORD_BYTES): unknown {
  try { return parseStrictJson(bytes, maxBytes); } catch { return fail(); }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
}
function noSymlinks(path: string): void {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) fail();
  }
}
function rootSafe(path: string): void {
  noSymlinks(path); privateInfo(lstatSync(path), true);
}

/** Private reduced projections. The configured directory is an operator setting,
 * never a model argument. One synchronous mutation holds the process-independent
 * writer lock; a crash leaves that lock closed to further writes until recovery. */
export class PrivateCatalog {
  readonly #root!: string;
  readonly #cursorKey!: Buffer;
  readonly #identityNamespace!: string;
  constructor(directory: string, identityNamespace = 'local-operator-v2') {
    try {
      if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) return fail();
      this.#root = resolve(directory);
      noSymlinks(dirname(this.#root));
      // The parent must already exist and be controlled by the operator. Do not
      // create arbitrary ancestor trees or change their permissions.
      try { mkdirSync(this.#root, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      rootSafe(this.#root);
      if (typeof identityNamespace !== 'string' || identityNamespace.length < 1 || identityNamespace.length > 2048 || /[\u0000-\u001f\u007f]/u.test(identityNamespace)) return fail();
      this.#identityNamespace = createHash('sha256').update('radar-catalog-identity-v1\0').update(identityNamespace).digest('hex');
      const namespacePath = join(this.#root, '.identity-namespace');
      let persistedNamespace: Buffer;
      try { persistedNamespace = readPrivate(namespacePath, 64); }
      catch {
        persistedNamespace = this.#writeLocked(() => {
          try { return readPrivate(namespacePath, 64); }
          catch {
            // Missing marker may only be initialized in a new, empty catalog.
            // Never adopt old data under a different identity provider.
            if (readdirSync(this.#root).some(name => name !== '.writer.lock')) return fail();
          }
          const namespace = Buffer.from(this.#identityNamespace);
          this.#atomicWrite(namespacePath, namespace); return namespace;
        });
      }
      if (persistedNamespace.toString('ascii') !== this.#identityNamespace) return fail();
      const keyPath = join(this.#root, '.cursor-key');
      try {
        this.#cursorKey = readPrivate(keyPath, 32);
      } catch {
        this.#cursorKey = this.#writeLocked(() => {
          // Recheck after acquiring the lock for concurrent first initialization.
          try { return readPrivate(keyPath, 32); }
          catch {
            try { lstatSync(keyPath); return fail(); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          const key = randomBytes(32);
          this.#atomicWrite(keyPath, key);
          return key;
        });
      }
      if (this.#cursorKey.length !== 32) return fail();
      this.#ids();
    } catch { return fail(); }
  }
  #checkRoot(): void { rootSafe(this.#root); }
  #syncDirectory(): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      privateInfo(fstatSync(descriptor), true); fsyncSync(descriptor);
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  #atomicWrite(destination: string, bytes: Buffer): void {
    const temporary = join(this.#root, `.pending-${randomUUID()}`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      privateInfo(fstatSync(descriptor)); writeAll(descriptor, bytes); fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, destination); this.#syncDirectory();
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* A completed rename has no temporary file. */ }
    }
  }
  #writeLocked<T>(action: () => T): T {
    const path = join(this.#root, '.writer.lock');
    let descriptor: number | undefined;
    try {
      this.#checkRoot();
      descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      privateInfo(fstatSync(descriptor));
      writeAll(descriptor, Buffer.from('exclusive catalog mutation\n')); fsyncSync(descriptor); this.#syncDirectory();
      return action();
    } catch { return fail(); }
    finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); unlinkSync(path); this.#syncDirectory(); } catch { fail(); }
      }
    }
  }
  #ids(): string[] {
    this.#checkRoot();
    const ids = readdirSync(this.#root).filter(name => UUID.test(name.slice(0, -5)) && name.endsWith('.json')).map(name => name.slice(0, -5)).sort();
    if (ids.length > MAX_CATALOG_REPORTS) return fail();
    return ids;
  }
  #read(reportId: string): StoredReport {
    if (typeof reportId !== 'string' || !UUID.test(reportId)) return fail();
    const result = RecordSchema.safeParse(parseBoundedJson(readPrivate(join(this.#root, `${reportId}.json`), MAX_RECORD_BYTES)));
    if (!result.success || result.data.reportId !== reportId) return fail();
    return result.data;
  }
  #authorized(principal: CatalogPrincipal, reportId: string): StoredReport {
    try {
      this.#checkRoot();
      const key = ownerKey(principal, this.#identityNamespace), stored = this.#read(reportId);
      if (stored.ownerKey !== key) return fail();
      return stored;
    } catch { return fail(); }
  }
  importReport(principal: CatalogPrincipal, bytes: Buffer, contexts?: Record<string, OperatorContext>) {
    try {
      const key = ownerKey(principal, this.#identityNamespace);
      // Validate before creating a lock or durable record. No original bytes persist.
      const snapshot = ReportSnapshotSchema.parse(new Report(bytes).snapshot(contexts));
      return this.#writeLocked(() => {
        const ids = this.#ids();
        for (const id of ids) {
          const existing = this.#read(id);
          if (existing.ownerKey === key && existing.snapshot.reportSha256 === snapshot.reportSha256) {
            if (canonical(existing.snapshot) !== canonical(snapshot)) return fail();
            return this.#importResult(existing, true);
          }
        }
        if (ids.length >= MAX_CATALOG_REPORTS) return fail();
        const stored: StoredReport = { storageVersion: 1, reportId: randomUUID(), ownerKey: key, importedAt: new Date().toISOString(), snapshot };
        const encoded = Buffer.from(JSON.stringify(RecordSchema.parse(stored)));
        if (encoded.length > MAX_RECORD_BYTES) return fail();
        this.#atomicWrite(join(this.#root, `${stored.reportId}.json`), encoded);
        return this.#importResult(stored, false);
      });
    } catch { return fail(); }
  }
  #importResult(stored: StoredReport, duplicate: boolean) {
    return ImportResultSchema.parse({ schemaVersion: 2, reportId: stored.reportId, state: 'AVAILABLE',
      importedAt: stored.importedAt, reportSha256: stored.snapshot.reportSha256, parserVersion: stored.snapshot.parserVersion, duplicate });
  }
  #signCursor(key: string, payload: string): string {
    return createHmac('sha256', this.#cursorKey).update('catalog-page-v1\0').update(key).update('\0').update(payload).digest('base64url');
  }
  #decodeCursor(cursor: string, key: string): string {
    if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) return fail();
    const [payload, signature] = cursor.split('.') as [string, string];
    const expected = Buffer.from(this.#signCursor(key, payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return fail();
    return CursorSchema.parse(parseBoundedJson(Buffer.from(payload, 'base64url'))).after;
  }
  listReports(principal: CatalogPrincipal, options: { limit?: number; cursor?: string } = {}) {
    try {
      const key = ownerKey(principal, this.#identityNamespace), limit = options.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE || Object.keys(options).some(k => !['limit', 'cursor'].includes(k))) return fail();
      const after = options.cursor === undefined ? null : this.#decodeCursor(options.cursor, key);
      const own = this.#ids().map(id => this.#read(id)).filter(stored => stored.ownerKey === key && (after === null || stored.reportId > after));
      const selected = own.slice(0, limit);
      const last = selected.at(-1);
      const payload = last ? Buffer.from(JSON.stringify({ version: 1, after: last.reportId })).toString('base64url') : '';
      return ListReportsResultSchema.parse({ schemaVersion: 2, reports: selected.map(stored => ({
        reportId: stored.reportId, state: 'AVAILABLE' as const, importedAt: stored.importedAt,
        reportSha256: stored.snapshot.reportSha256, parserVersion: stored.snapshot.parserVersion, demo: stored.snapshot.demo,
        strategies: stored.snapshot.analyses.map(analysis => ({ strategyId: analysis.strategyId, tradeCount: analysis.derived.tradeCount })),
      })), nextCursor: own.length > limit ? `${payload}.${this.#signCursor(key, payload)}` : null });
    } catch { return fail(); }
  }
  getReport(principal: CatalogPrincipal, reportId: string): { schemaVersion: 2; reportId: string; importedAt: string; snapshot: ReportSnapshot } {
    const stored = this.#authorized(principal, reportId);
    return structuredClone({ schemaVersion: 2, reportId: stored.reportId, importedAt: stored.importedAt, snapshot: stored.snapshot });
  }
  analyzeReport(principal: CatalogPrincipal, reportId: string, strategyId: string) {
    try {
      const stored = this.#authorized(principal, reportId);
      const analysis = stored.snapshot.analyses.find(item => item.strategyId === strategyId);
      if (!analysis) return fail();
      return AnalyzeReportResultSchema.parse({ schemaVersion: 2, reportId, importedAt: stored.importedAt,
        reportSha256: stored.snapshot.reportSha256, parserVersion: stored.snapshot.parserVersion, demo: stored.snapshot.demo, analysis });
    } catch { return fail(); }
  }
  /** Administrative operation. Never register this as an MCP tool. */
  removeReport(principal: CatalogPrincipal, reportId: string) {
    return this.#writeLocked(() => {
      const stored = this.#authorized(principal, reportId);
      unlinkSync(join(this.#root, `${stored.reportId}.json`)); this.#syncDirectory();
      return { schemaVersion: 2 as const, reportId: stored.reportId, state: 'REMOVED' as const };
    });
  }
}
