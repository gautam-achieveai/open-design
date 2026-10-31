// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';
import { localWorkspaceHeaders, readResourceBinding, seedLegacyTeamResource } from '@/vitest/local-workspace';

test('[P0] Personal skills remain editable while legacy Team skills cannot be exposed or overwritten', { timeout: 300_000 }, async () => {
  const suite = await createSmokeSuite('local-skill-team-unavailable');
  await suite.with.toolsDev(async ({ webUrl }) => {
    const headers = localWorkspaceHeaders();
    const input = { name: 'Local scope skill', description: 'Local resource witness', body: 'Keep my local design consistent.', triggers: ['local design'] };
    const imported = await requestJson<{ skill: { id: string } }>(webUrl, '/api/skills/import', {
      method: 'POST', headers, body: input,
    });
    const id = imported.skill.id;
    const listed = await requestJson<{ skills: Array<{ id: string }> }>(webUrl, '/api/skills', { headers });
    expect(listed.skills.map(skill => skill.id)).toContain(id);
    const updated = await fetch(new URL(`/api/skills/${id}`, webUrl), {
      method: 'PUT', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ ...input, body: 'Updated local instructions.' }),
    });
    expect(updated.status).toBe(200);
    const skillFile = join(suite.dataDir, 'skills', 'local-scope-skill', 'SKILL.md');
    const skillBefore = await readFile(skillFile, 'utf8');
    expect(skillBefore).toContain('Updated local instructions.');
    const before = seedLegacyTeamResource(suite.dataDir, 'skill', id);
    const hidden = await requestJson<{ skills: Array<{ id: string }> }>(webUrl, '/api/skills');
    expect(hidden.skills.map(skill => skill.id)).not.toContain(id);
    for (const method of ['PUT', 'DELETE']) {
      const response = await fetch(new URL(`/api/skills/${id}`, webUrl), {
        method, headers: { 'content-type': 'application/json', ...localWorkspaceHeaders('legacy-resource-team') },
        ...(method === 'PUT' ? { body: JSON.stringify(input) } : {}),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'WORKSPACE_UNAVAILABLE' } });
    }
    expect(readResourceBinding(suite.dataDir, 'skill', id)).toEqual(before);
    expect(await readFile(skillFile, 'utf8')).toBe(skillBefore);
  });
});
