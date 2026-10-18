import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { parseStrictJson } from './report.js';

/** Paths are supplied only by the local operator; no MCP tool accepts them. */
export function readOperatorFile(path: string, maxBytes: number, privateFile = false): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes ||
      (privateFile && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw new Error();
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, size);
      if (!read) break;
      size += read;
    }
    if (size < 1 || size > maxBytes) throw new Error();
    return buffer.subarray(0, size);
  } catch { throw new Error('Operator file rejected.'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export const RemoteConfigSchema = z.object({
  schemaVersion: z.literal(1),
  storageDir: z.string().min(1).refine(isAbsolute),
  resource: z.string().url(),
  issuer: z.string().url(),
  jwksUrl: z.string().url(),
  ownerSubject: z.string().min(1).max(512),
  port: z.number().int().min(1024).max(65535).default(8789),
  listenHost: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  allowedOrigins: z.array(z.string().url()).max(8).default([]),
}).strict();
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;
export function loadRemoteConfig(path: string): RemoteConfig {
  return RemoteConfigSchema.parse(parseStrictJson(readOperatorFile(path, 16 * 1024, true), 16 * 1024));
}
