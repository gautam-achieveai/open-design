// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';
import { e2eWorkspaceRoot } from '@/tools-dev/runtime';
import { localWorkspaceHeaders, readInstalledPlugin, readResourceBinding, seedLegacyTeamResource } from '@/vitest/local-workspace';

test('[P0] local plugins apply while stored Team plugins remain hidden and preserved', { timeout: 300_000 }, async () => {
  const suite = await createSmokeSuite('local-plugin-team-unavailable');
  const source = join(suite.scratchDir, 'local-plugin');
  // tools-dev launches the daemon with the repository root as cwd. Use its
  // supported relative local-source form on both Windows and POSIX hosts.
  const daemonCwd = e2eWorkspaceRoot();
  const installSource = `./${relative(daemonCwd, source).replaceAll('\\', '/')}`;
  expect(resolve(daemonCwd, installSource)).toBe(source);
  const id = 'workspace-retraction-plugin';
  await mkdir(source, { recursive: true });
  const manifest = JSON.stringify({
    name: id, version: '1.0.0', title: 'Local fixture plugin', description: 'Local plugin isolation witness',
    od: { kind: 'skill', taskKind: 'new-generation', useCase: { query: 'Build a {{topic}} brief.' },
      inputs: [{ name: 'topic', type: 'string', required: true }] },
  });
  await writeFile(join(source, 'open-design.json'), manifest);
  await suite.with.toolsDev(async ({ webUrl }) => {
    const installed = await fetch(new URL('/api/plugins/install', webUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: installSource }),
    });
    const installResult = await installed.text();
    expect(installed.status, installResult).toBe(200);
    expect(installResult).toContain('event: success');
    const apply = (headers: Record<string, string> = {}) => fetch(new URL(`/api/plugins/${id}/apply`, webUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ inputs: { topic: 'local design' } }),
    });
    expect((await apply()).status).toBe(200);
    const installedBefore = readInstalledPlugin(suite.dataDir, id);
    const storedManifest = join(installedBefore.fs_path, 'open-design.json');
    const storedBefore = await readFile(storedManifest, 'utf8');
    const before = seedLegacyTeamResource(suite.dataDir, 'plugin', id);
    const catalog = await requestJson<{ plugins: Array<{ id: string }> }>(webUrl, '/api/plugins');
    expect(catalog.plugins.map(plugin => plugin.id)).not.toContain(id);
    for (const denied of [
      { name: 'unscoped lookup conceals the plugin', headers: {}, status: 404,
        body: { error: 'plugin not found' } },
      { name: 'spoofed Personal identity cannot claim stored Team resources',
        headers: localWorkspaceHeaders('legacy-resource-team'), status: 403,
        body: { error: { code: 'WORKSPACE_UNAVAILABLE',
          message: 'Team resources are unavailable because Cloud support has been removed. Stored data has been preserved.' } } },
    ]) {
      const response = await apply(denied.headers);
      expect(response.status, denied.name).toBe(denied.status);
      expect(await response.json(), denied.name).toEqual(denied.body);
    }
    expect(readResourceBinding(suite.dataDir, 'plugin', id)).toEqual(before);
    expect(readInstalledPlugin(suite.dataDir, id)).toEqual(installedBefore);
    expect(await readFile(storedManifest, 'utf8')).toBe(storedBefore);
    expect(await readFile(join(source, 'open-design.json'), 'utf8')).toBe(manifest);
  });
});
