import { describe, expect, it } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { pairedMemberRelayContext } from '../src/routes/project/comments.js';

const member = { workspaceId: 'w1', workspaceMemberId: 'm1' };
const teamBinding = { workspaceId: 'w1', visibility: 'team', resourceState: 'active' };
const teamContext = {
  workspaceId: 'w1',
  workspaceMemberId: 'm1',
  workspaceType: 'team',
  memberStatus: 'active',
  lifecycleState: 'active',
} as WorkspaceCollabContext;

const verifiedAs = (context: WorkspaceCollabContext | null) => async () => ({ ok: true, context });

describe('pairedMemberRelayContext (Clipper pins relay like every other pin)', () => {
  it('relays as the re-verified member of a Team-shared project', async () => {
    const seen: Record<string, string>[] = [];
    const context = await pairedMemberRelayContext(member, teamBinding, async (headers) => {
      seen.push(headers);
      return { ok: true, context: teamContext };
    });
    expect(context).toBe(teamContext);
    expect(seen).toEqual([{ 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'm1' }]);
  });

  it('keeps the pin local when there is nothing to relay as', async () => {
    // No paired member (unbound project).
    expect(await pairedMemberRelayContext(undefined, teamBinding, verifiedAs(teamContext))).toBeNull();
    // The project is not team-visible, or belongs to another workspace.
    expect(await pairedMemberRelayContext(member, { ...teamBinding, visibility: 'personal' }, verifiedAs(teamContext))).toBeNull();
    expect(await pairedMemberRelayContext(member, { ...teamBinding, workspaceId: 'w2' }, verifiedAs(teamContext))).toBeNull();
    expect(await pairedMemberRelayContext(member, null, verifiedAs(teamContext))).toBeNull();
    // Header-only local mode claims a personal workspace.
    expect(await pairedMemberRelayContext(member, teamBinding,
      verifiedAs({ ...teamContext, workspaceType: 'personal' }))).toBeNull();
  });

  it('keeps the pin local when the member no longer verifies', async () => {
    expect(await pairedMemberRelayContext(member, teamBinding, async () => ({ ok: false }))).toBeNull();
    expect(await pairedMemberRelayContext(member, teamBinding, async () => { throw new Error('directory down'); })).toBeNull();
    expect(await pairedMemberRelayContext(member, teamBinding,
      verifiedAs({ ...teamContext, memberStatus: 'removed' }))).toBeNull();
    expect(await pairedMemberRelayContext(member, teamBinding,
      verifiedAs({ ...teamContext, workspaceMemberId: 'someone-else' }))).toBeNull();
  });
});
