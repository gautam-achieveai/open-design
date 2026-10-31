import type { SkillInfo } from '../skills.js';

export type SkillCatalogEntry = Omit<SkillInfo, 'body' | 'dir'> & { hasBody: boolean };

export function projectSkillCatalog(skills: readonly SkillInfo[]): SkillCatalogEntry[] {
  return skills.map(({ body, dir: _dir, ...rest }) => ({ ...rest, hasBody: typeof body === 'string' && body.length > 0 }));
}

/** Shared projection for REST and MCP; filesystem paths and bodies stay private. */
export async function readSkillCatalog(
  list: (scope: { workspaceId: string | null; workspaceMemberId: string | null }) => Promise<SkillInfo[]>,
  scope: { workspaceId: string | null; workspaceMemberId: string | null },
): Promise<SkillCatalogEntry[]> {
  return projectSkillCatalog(await list(scope));
}
