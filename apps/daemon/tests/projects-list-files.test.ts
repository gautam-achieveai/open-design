import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listFiles, readProjectFile } from '../src/projects.js';

const tempRoots: string[] = [];

async function makeProjectsRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'od-project-files-'));
  tempRoots.push(root);
  return path.join(root, 'projects');
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('listFiles', () => {
  it('does not follow an imported manifest alias into a hidden directory', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectDir = path.join(projectsRoot, 'p');
    await mkdir(path.join(projectDir, '.hidden'), { recursive: true });
    await writeFile(path.join(projectDir, 'sample.txt'), 'inside');
    await writeFile(path.join(projectDir, '.hidden', 'manifest.json'), JSON.stringify({ version: 1, kind: 'code-snippet',
      renderer: 'code', exports: ['txt'], entry: 'sample.txt', title: 'hidden-private-title' }));
    await symlink(path.join(projectDir, '.hidden', 'manifest.json'), path.join(projectDir, 'sample.txt.artifact.json'), 'file');
    const metadata = { importedFrom: 'folder', baseDir: projectDir };
    expect(JSON.stringify(await listFiles(projectsRoot, 'p', { metadata }))).not.toContain('hidden-private-title');
    expect(JSON.stringify((await readProjectFile(projectsRoot, 'p', 'sample.txt', metadata)).artifactManifest)).not.toContain('hidden-private-title');
  });

  it('omits outside-symlink manifests from list and read while retaining in-root manifests', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectDir = path.join(projectsRoot, 'p');
    await mkdir(projectDir, { recursive: true });
    const manifest = (title: string, entry: string) => ({ version: 1, kind: 'code-snippet', renderer: 'code',
      exports: ['txt'], entry, title });
    const outside = path.join(path.dirname(projectsRoot), 'outside.json');
    await writeFile(outside, JSON.stringify(manifest('outside-private-title', 'sample.txt')));
    await writeFile(path.join(projectDir, 'sample.txt'), 'inside');
    await symlink(outside, path.join(projectDir, 'sample.txt.artifact.json'), 'file');
    await writeFile(path.join(projectDir, 'allowed.txt'), 'inside');
    await writeFile(path.join(projectDir, 'inside-manifest.json'), JSON.stringify(manifest('inside-title', 'allowed.txt')));
    await symlink(path.join(projectDir, 'inside-manifest.json'), path.join(projectDir, 'allowed.txt.artifact.json'), 'file');

    const files = await listFiles(projectsRoot, 'p');
    const escaped = await readProjectFile(projectsRoot, 'p', 'sample.txt');
    const allowed = await readProjectFile(projectsRoot, 'p', 'allowed.txt');
    expect(JSON.stringify(files)).not.toContain('outside-private-title');
    expect(JSON.stringify(escaped.artifactManifest)).not.toContain('outside-private-title');
    expect(files.find((file) => file.name === 'allowed.txt')?.artifactManifest?.title).toBe('inside-title');
    expect(allowed.artifactManifest?.title).toBe('inside-title');
  });

  it('includes the absolute local path for each visible project file', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'project-1';
    const projectDir = path.join(projectsRoot, projectId);
    const filePath = path.join(projectDir, 'alpha.html');
    await mkdir(projectDir, { recursive: true });
    await writeFile(filePath, '<!doctype html>');

    const files = await listFiles(projectsRoot, projectId);

    expect(files).toEqual([
      expect.objectContaining({
        name: 'alpha.html',
        path: 'alpha.html',
        localPath: filePath,
      }),
    ]);
  });
});
