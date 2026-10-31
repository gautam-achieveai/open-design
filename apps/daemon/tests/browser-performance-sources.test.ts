import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { open as controlledOpen } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserPerformanceReport } from '@open-design/contracts';
import { resolveProjectFilePath } from '../src/projects.js';
import { resolvePerformanceSources } from '../src/services/browser-performance-sources.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const owned: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(controlledOpen).mockImplementation(fsp.open);
  syncBuiltinESMExports();
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(kind: 'script' | 'stylesheet' = 'script') {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'od-performance-source-')));
  owned.push(directory);
  const roots = ['A', 'B'].map((name) => join(directory, name));
  const generatedName = kind === 'script' ? 'slow.js' : 'layout.css';
  const originalExtension = kind === 'script' ? 'ts' : 'scss';
  for (const [index, root] of roots.entries()) {
    fs.mkdirSync(join(root, 'project'), { recursive: true });
    fs.writeFileSync(join(root, 'project', generatedName), kind === 'script'
      ? 'function insideFunction(){}\n//# sourceMappingURL=slow.js.map'
      : '.private-selector { width: 10px; }\n/*# sourceMappingURL=layout.css.map */');
    fs.writeFileSync(join(root, 'project', `${generatedName}.map`), JSON.stringify({ version: 3,
      sources: [`original-${index}.${originalExtension}`], names: [], mappings: 'AAAA' }));
    fs.writeFileSync(join(root, `project/original-${index}.${originalExtension}`), 'original source');
  }
  const locator = { label: 'source-1', url: `http://localhost:5001/api/projects/project/raw/${generatedName}`, line: 1, column: 1,
    kind, ...(kind === 'script' ? { functionName: 'insideFunction' } : {}) };
  // All unrelated report fields pass through; these cases exercise attribution only.
  const report = { evidence: [{ id: 'sample-1', sources: [{ label: 'source-1', mapping: 'unavailable' }] }] } as BrowserPerformanceReport;
  return { directory, roots, locator, report, allowedOrigins: () => ['http://localhost:5001'] };
}

it('rejects root rebinding between completed generated and map reads, including repeated cached source', async () => {
  const ctx = fixture();
  let active = ctx.roots[0]!;
  let generatedReads = 0;
  const output = await resolvePerformanceSources(ctx.report, [ctx.locator, ctx.locator], 'project', {
    allowedOrigins: ctx.allowedOrigins,
    getBinding: async () => active,
    resolveFile: async (id, relative) => {
      const file = await resolveProjectFilePath(active, id, relative);
      if (relative === 'slow.js' && ++generatedReads === 2) active = ctx.roots[1]!;
      return file;
    },
  }, () => true);
  expect(output.evidence[0]!.sources![0]).toEqual({ label: 'source-1', mapping: 'unavailable', unavailableReason: 'source-unavailable' });
});

it('rejects an outside opened handle before reading when its authorized pathname was restored', async () => {
  const ctx = fixture();
  const root = ctx.roots[0]!;
  const generated = join(root, 'project/slow.js');
  const outside = join(ctx.directory, 'outside.js');
  fs.writeFileSync(outside, 'function outsideFunction(){}\n//# sourceMappingURL=slow.js.map');
  const originalOpen = fsp.open;
  let injected = false;
  let outsideReads = 0;
  vi.mocked(controlledOpen).mockImplementation(async (file, flags, mode) => {
    if (injected || typeof file !== 'string' || fs.statSync(file).ino !== fs.statSync(generated).ino) return originalOpen(file, flags, mode);
    injected = true;
    fs.renameSync(generated, `${generated}.owned-backup`);
    fs.symlinkSync(outside, generated, 'file');
    let handle: Awaited<ReturnType<typeof fsp.open>>;
    try { handle = await originalOpen(file, flags, mode); }
    finally { fs.unlinkSync(generated); fs.renameSync(`${generated}.owned-backup`, generated); }
    const read = handle.read.bind(handle);
    handle.read = ((...args: unknown[]) => { outsideReads++; return Reflect.apply(read, handle, args); }) as typeof handle.read;
    return handle;
  });
  syncBuiltinESMExports();
  const output = await resolvePerformanceSources(ctx.report, [{ ...ctx.locator, functionName: 'outsideFunction' }], 'project', {
    allowedOrigins: ctx.allowedOrigins, getBinding: async () => root,
    resolveFile: (id, relative) => resolveProjectFilePath(root, id, relative),
  }, () => true);
  expect(injected).toBe(true);
  expect(outsideReads).toBe(0);
  expect(output.evidence[0]!.sources![0]).toEqual({ label: 'source-1', mapping: 'unavailable', unavailableReason: 'source-unavailable' });
});

it.each(['script', 'stylesheet'] as const)('retains unchanged authorized %s mapping and its explicit current-file uncertainty', async (kind) => {
  const ctx = fixture(kind);
  const root = ctx.roots[0]!;
  const output = await resolvePerformanceSources(ctx.report, [ctx.locator], 'project', {
    allowedOrigins: ctx.allowedOrigins, getBinding: async () => root,
    resolveFile: (id, relative) => resolveProjectFilePath(root, id, relative),
  }, () => true);
  expect(output.evidence[0]!.sources![0]).toMatchObject({ mapping: 'project-local',
    generated: kind === 'script' ? { path: 'slow.js', functionName: 'insideFunction' } : { path: 'layout.css', line: 1, column: 1 },
    original: { path: kind === 'script' ? 'original-0.ts' : 'original-0.scss', line: 1, column: 1 },
    resolutionBasis: 'current-project-files-unverified-at-capture' });
  expect(JSON.stringify(output)).not.toContain('private-selector');
});
