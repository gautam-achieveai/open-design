import type Database from 'better-sqlite3';
import { getWorkspaceResourceByResourceId } from '../db.js';
import { readTeamResourceMaterialization, teamResourceMaterializationDir } from '../collab/team-resource-materialization.js';
import { resolvePluginFolder, workspaceTeamPluginBindingActivationFence, workspaceTeamPluginBindingAllowsRead, workspaceTeamPluginBindingResourceId } from '../plugins/registry.js';

/** MCP discovery is read-only: legacy unbound materializations are not adopted here. */
export async function readNonAdoptingTeamPlugin(db: Database.Database, root: string, workspaceId: string, resourceId: string) {
  const key = workspaceTeamPluginBindingResourceId(workspaceId, resourceId);
  const binding = getWorkspaceResourceByResourceId(db, 'plugin', key);
  const before = workspaceTeamPluginBindingActivationFence(db, workspaceId, resourceId);
  const marker = await readTeamResourceMaterialization(root, workspaceId, resourceId, resourceId);
  if (!marker || marker.kind !== 'plugin') return { status: 'absent' as const };
  if (!binding || !before) return { status: 'incomplete' as const };
  // Revoked materializations intentionally stay on disk and are omitted.
  if (!workspaceTeamPluginBindingAllowsRead(db, workspaceId, resourceId)) return { status: 'absent' as const };
  if (!binding.resourceHubResourceId || marker.hubResourceId !== binding.resourceHubResourceId) {
    return { status: 'incomplete' as const };
  }
  const resolved = await resolvePluginFolder({ folder: teamResourceMaterializationDir(root, workspaceId, resourceId, resourceId),
    folderId: resourceId, sourceKind: 'user', source: marker.sourceKey });
  if (workspaceTeamPluginBindingActivationFence(db, workspaceId, resourceId) !== before
    || !workspaceTeamPluginBindingAllowsRead(db, workspaceId, resourceId)) return { status: 'incomplete' as const };
  if (!resolved.ok) return { status: 'absent' as const };
  return { status: 'observed' as const, record: resolved.record, fence: before, resourceId };
}
