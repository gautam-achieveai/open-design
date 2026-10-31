import { describe, expect, it, vi } from 'vitest';
import { isRevokedProjectFileAccess, maybeResolveVitePreviewHtml } from '../src/services/project-file-read.js';

describe('shared raw-file preview transformation', () => {
  it('substitutes the same nested Vite dist entry and rewrites asset URLs', async () => {
    const read = vi.fn(async () => ({ buffer: Buffer.from('<script src="/assets/app.js"></script>') }));
    const result = await maybeResolveVitePreviewHtml({
      projectsRoot: 'root', projectId: 'project', relPath: 'nested/index.html', metadata: { baseDir: 'imported' }, readProjectFile: read,
      file: { mime: 'text/html; charset=utf-8', buffer: Buffer.from('<script type="module" src="/src/main.js"></script>') },
    });
    expect(result).toBe('<script src="dist/assets/app.js"></script>');
    expect(read).toHaveBeenCalledWith('root', 'project', 'nested/dist/index.html', { baseDir: 'imported' });
  });

  it('returns original bytes for non-Vite content or a missing dist file', async () => {
    const source = Buffer.from('<script type="module" src="/src/main.js"></script>');
    const read = vi.fn(async () => { throw new Error('missing'); });
    const args = { projectsRoot: 'root', projectId: 'project', relPath: 'index.html', readProjectFile: read };
    expect(await maybeResolveVitePreviewHtml({ ...args, file: { mime: 'text/plain', buffer: source } })).toBe(source);
    expect(await maybeResolveVitePreviewHtml({ ...args, file: { mime: 'text/html', buffer: source } })).toBe(source);
    expect(isRevokedProjectFileAccess({ metadata: { teamMirrorRevokedAt: 'now' } as never })).toBe(true);
    expect(isRevokedProjectFileAccess({ metadata: { kind: 'prototype' } })).toBe(false);
  });
});
