import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readProjectFile, resolveProjectFilePath } from '../src/projects.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('checks resolved paths for internal versions and hidden imported files while allowing ordinary in-root links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'od-read-confinement-'));
  roots.push(root);
  const project = path.join(root, 'p');
  await mkdir(path.join(project, '.file-versions'), { recursive: true });
  await mkdir(path.join(project, '.hidden'), { recursive: true });
  await writeFile(path.join(project, '.file-versions', 'private.txt'), 'internal-marker');
  await writeFile(path.join(project, '.hidden', 'private.txt'), 'hidden-marker');
  await writeFile(path.join(project, 'inside.txt'), 'inside');
  for (const [source, alias] of [['.file-versions/private.txt', 'version.txt'], ['.hidden/private.txt', 'hidden.txt'], ['inside.txt', 'allowed.txt']]) {
    await symlink(path.join(project, source!), path.join(project, alias!), 'file');
  }
  const imported = { importedFrom: 'folder', baseDir: project };
  const forbidden = [
    readProjectFile(root, 'p', 'version.txt'),
    resolveProjectFilePath(root, 'p', 'version.txt'),
    readProjectFile(root, 'p', 'hidden.txt', imported),
    resolveProjectFilePath(root, 'p', 'hidden.txt', imported),
    ...(process.platform === 'win32' ? [readProjectFile(root, 'p', '.FILE-VERSIONS/private.txt')] : []),
  ];
  const results = await Promise.allSettled(forbidden);
  expect(results.map(result => result.status)).toEqual(forbidden.map(() => 'rejected'));
  expect((await readProjectFile(root, 'p', 'allowed.txt', imported)).buffer.toString('utf8')).toBe('inside');
  expect((await resolveProjectFilePath(root, 'p', 'allowed.txt', imported)).name).toBe('inside.txt');
});
