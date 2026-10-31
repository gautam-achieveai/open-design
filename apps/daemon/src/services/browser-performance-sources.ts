import { lstat, open } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { SourceMap } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import type { BrowserPerformanceReport, BrowserPerformanceSourceReference } from '@open-design/contracts';
import { BrowserBrokerError } from './browser-command-broker.js';

const locatorSchema = z.array(z.object({ label: z.string().regex(/^source-\d+$/), url: z.string().max(2048),
  line: z.number().int().min(1).max(10_000_000), column: z.number().int().min(1).max(10_000_000),
  functionName: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/).max(128).optional(),
  kind: z.enum(['script', 'stylesheet']).optional() })).max(64);
const mapSchema = z.object({ version: z.literal(3), sources: z.array(z.string().max(1024)).max(4096),
  sourceRoot: z.string().max(1024).optional(), names: z.array(z.string().max(512)).max(8192).default([]),
  mappings: z.string().max(512 * 1024) });
type Reason = NonNullable<BrowserPerformanceSourceReference['unavailableReason']>;
class SourceUnavailable extends Error { constructor(readonly reason: Reason) { super(reason); } }
const unavailable = (reason: Reason): never => { throw new SourceUnavailable(reason); };

export interface PerformanceSourceDependencies {
  allowedOrigins: () => readonly string[];
  /** Opaque fingerprint of canonical root plus current file visibility policy. */
  getBinding: (projectId: string) => Promise<string>;
  /** Existing project-file policy: visibility, project binding and realpath containment. */
  resolveFile: (projectId: string, relativePath: string) => Promise<{ filePath: string; name: string; size: number }>;
}

export function isPerformanceSourcePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\\\x00-\x1f\x7f:?#]/.test(value)
    && !path.posix.isAbsolute(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Resolve only authorized local files. No HTTP, source content, or remote names escape. */
export async function resolvePerformanceSources(report: BrowserPerformanceReport, rawLocators: unknown, projectId: string,
  deps: PerformanceSourceDependencies, authorize: () => boolean | Promise<boolean>): Promise<BrowserPerformanceReport> {
  const parsed = locatorSchema.safeParse(rawLocators ?? []);
  const locators = parsed.success ? parsed.data : [];
  const resolved = new Map<string, BrowserPerformanceSourceReference>();
  const fileCache = new Map<string, string>();
  const usedFiles = new Map<string, { filePath: string; identity: BigIntStats }>();
  let binding: string | undefined;
  let invalidated = false;
  let remainingBytes = 2 * 1024 * 1024;
  const current = async () => {
    if (!await authorize()) throw new BrowserBrokerError('FORBIDDEN', 'Browser performance source access denied', 403);
  };
  const invalidate = (): never => { invalidated = true; return unavailable('source-unavailable'); };
  async function bindingCurrent() {
    await current();
    const next = await deps.getBinding(projectId);
    if (binding !== undefined && next !== binding) return invalidate();
    binding ??= next;
    if (invalidated) return invalidate();
  }
  function sameFile(a: BigIntStats, b: BigIntStats): boolean {
    return a.isFile() && b.isFile() && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev
      && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  }
  async function checkFile(relative: string, expected: { filePath: string; identity: BigIntStats }) {
    await bindingCurrent();
    const currentFile = await deps.resolveFile(projectId, relative);
    const identity = await lstat(currentFile.filePath, { bigint: true });
    if (currentFile.filePath !== expected.filePath || !sameFile(expected.identity, identity)) return invalidate();
    await bindingCurrent();
  }
  async function readLocal(relative: string, maximum: number, largeReason: Reason): Promise<string> {
    if (!isPerformanceSourcePath(relative)) return unavailable('invalid-source-path');
    await bindingCurrent();
    const cacheKey = `${binding}\0${relative}`;
    if (fileCache.has(cacheKey)) {
      await checkFile(relative, usedFiles.get(relative)!);
      return fileCache.get(cacheKey)!;
    }
    const located = await deps.resolveFile(projectId, relative);
    if (located.size > maximum || located.size > remainingBytes) return unavailable(largeReason);
    const authorized = { filePath: located.filePath, identity: await lstat(located.filePath, { bigint: true }) };
    if (!authorized.identity.isFile() || authorized.identity.ino === 0n) return invalidate();
    await bindingCurrent();
    const handle = await open(located.filePath, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      // Check the actual opened object before reading any bytes, not merely its
      // pathname: a replaced-then-restored symlink can otherwise pass postchecks.
      if (!sameFile(authorized.identity, before)) return invalidate();
      await checkFile(relative, authorized);
      if (before.size > BigInt(maximum) || before.size > BigInt(remainingBytes)) return unavailable(largeReason);
      // Explicit byte bound also handles a file that grows after stat.
      const buffer = Buffer.alloc(Math.min(maximum, remainingBytes) + 1);
      let used = 0;
      while (used < buffer.length) {
        const chunk = await handle.read(buffer, used, buffer.length - used, used);
        if (!chunk.bytesRead) break;
        used += chunk.bytesRead;
      }
      if (used > maximum || used > remainingBytes) return unavailable(largeReason);
      const after = await handle.stat({ bigint: true });
      if (!sameFile(before, after)) return invalidate();
      await checkFile(relative, authorized);
      remainingBytes -= used;
      const text = buffer.subarray(0, used).toString('utf8');
      usedFiles.set(relative, authorized);
      fileCache.set(cacheKey, text);
      return text;
    } finally { await handle.close(); }
  }

  function relativeReference(owner: string, reference: string, reason: Reason): string {
    if (!reference || /[\\\x00-\x1f\x7f:?#]/.test(reference) || reference.startsWith('/')) return unavailable(reason);
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(owner), reference));
    if (!isPerformanceSourcePath(relative)) return unavailable('source-outside-project');
    return relative;
  }

  for (const locator of locators) {
    const source: BrowserPerformanceSourceReference = { label: locator.label, line: locator.line, column: locator.column, mapping: 'unavailable' };
    try {
      await bindingCurrent();
      let url: URL;
      try { url = new URL(locator.url); } catch { unavailable('external-source'); }
      if (!deps.allowedOrigins().includes(url!.origin) || url!.username || url!.password || url!.search || url!.hash) unavailable('external-source');
      const prefix = `/api/projects/${encodeURIComponent(projectId)}/raw/`;
      if (!url!.pathname.startsWith(prefix)) unavailable('external-source');
      let generatedPath: string;
      try { generatedPath = decodeURIComponent(url!.pathname.slice(prefix.length)); } catch { unavailable('invalid-source-path'); }
      const extension = locator.kind === 'stylesheet' ? /\.css$/i : /\.(?:c|m)?js$/i;
      if (!isPerformanceSourcePath(generatedPath!) || !extension.test(generatedPath!)) unavailable('invalid-source-path');
      const generated = await readLocal(generatedPath!, 256 * 1024, 'source-too-large');
      const generatedLine = generated.split('\n')[locator.line - 1];
      if (generatedLine === undefined || locator.column > generatedLine.length + 1) unavailable('source-unavailable');
      source.mapping = 'generated';
      const escapedName = locator.functionName?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const functionName = locator.kind !== 'stylesheet' && locator.functionName && escapedName
        && new RegExp(`\\b(?:function\\s+${escapedName}\\s*\\(|(?:const|let|var)\\s+${escapedName}\\s*=)`).test(generated)
        ? locator.functionName : undefined;
      source.generated = { path: generatedPath!, line: locator.line, column: locator.column,
        ...(functionName ? { functionName } : {}) };
      source.resolutionBasis = 'current-project-files-unverified-at-capture';
      const references = [...generated.matchAll(/(?:\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\/)/g)];
      const lastReference = references.at(-1);
      const reference = lastReference?.[1] ?? lastReference?.[2];
      if (!reference) unavailable('map-missing');
      const mapPath = relativeReference(generatedPath!, reference!, 'map-external');
      let mapText: string;
      try { mapText = await readLocal(mapPath, 512 * 1024, 'map-too-large'); }
      catch (error) {
        if (error instanceof SourceUnavailable || error instanceof BrowserBrokerError) throw error;
        unavailable('map-missing');
      }
      let parsedMap: z.infer<typeof mapSchema>;
      try { parsedMap = mapSchema.parse(JSON.parse(mapText!)); } catch { unavailable('map-invalid'); }
      if (parsedMap!.sourceRoot && /[\\:?#]/.test(parsedMap!.sourceRoot)) unavailable('map-external');
      // Drop sourcesContent and names before decoding. Original source strings
      // remain transient until independently checked against project boundaries.
      const map = new SourceMap({ version: 3, file: generatedPath!, sourceRoot: '', sources: parsedMap!.sources,
        sourcesContent: [], names: parsedMap!.names.map(() => ''), mappings: parsedMap!.mappings });
      const entry = map.findEntry(locator.line - 1, locator.column - 1);
      if (!('originalSource' in entry)) return unavailable('map-unmapped');
      if (typeof entry.originalSource !== 'string'
        || !Number.isInteger(entry.originalLine) || entry.originalLine! < 0
        || !Number.isInteger(entry.originalColumn) || entry.originalColumn! < 0) unavailable('map-unmapped');
      const originalPath = relativeReference(mapPath, path.posix.join(parsedMap!.sourceRoot ?? '', entry.originalSource!), 'map-external');
      await bindingCurrent();
      const original = await deps.resolveFile(projectId, originalPath);
      const originalIdentity = { filePath: original.filePath, identity: await lstat(original.filePath, { bigint: true }) };
      if (!originalIdentity.identity.isFile() || originalIdentity.identity.ino === 0n) return invalidate();
      await checkFile(originalPath, originalIdentity);
      usedFiles.set(originalPath, originalIdentity);
      source.original = { path: originalPath, line: entry.originalLine! + 1, column: entry.originalColumn! + 1 };
      source.mapping = 'project-local';
    } catch (error) {
      if (error instanceof BrowserBrokerError) throw error;
      source.unavailableReason = error instanceof SourceUnavailable ? error.reason
        : (error as NodeJS.ErrnoException).code === 'EPATHESCAPE' ? 'source-outside-project' : 'source-unavailable';
    }
    resolved.set(source.label, source);
  }
  try {
    for (const [relative, file] of usedFiles) await checkFile(relative, file);
    await bindingCurrent();
  } catch (error) {
    if (error instanceof BrowserBrokerError) throw error;
    invalidated = true;
  }
  await current();
  return { ...report, evidence: report.evidence.map((entry) => ({ ...entry,
    ...(entry.sources ? { sources: entry.sources.map((source) => (!invalidated ? resolved.get(source.label) : undefined)
      ?? { label: source.label, mapping: 'unavailable' as const, unavailableReason: 'source-unavailable' as const }) } : {}) })) };
}
