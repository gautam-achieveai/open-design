import { describe, expect, it } from 'vitest';
import { parseWorkspaceCollabContext, resolveWorkspaceSettingsUrl } from '../../src/collab/workspace-context.js';

describe('retired Cloud settings links', () => {
  it.each([undefined, 'https://web.example/settings', 'https://web.example/settings?workspaceId=other', 'not-a-url'])('does not expose a legacy settings link: %s', (explicit) => {
    expect(resolveWorkspaceSettingsUrl('ws-1', explicit, {
      OD_VELA_WEB_URL: 'https://web.example',
      OPEN_DESIGN_AMR_PROFILE: 'prod',
      OD_VELA_WEB_URLS: JSON.stringify({ prod: 'https://web.example', test: 'https://test.example' }),
    }, { OPEN_DESIGN_AMR_PROFILE: 'test' })).toBeUndefined();
  });

  it('retains the explicit Personal identity without a Cloud console link', () => {
    const context = parseWorkspaceCollabContext({
      workspaceId: 'ws-personal', workspaceType: 'personal', workspaceMemberId: 'wm-owner',
      role: 'owner', memberStatus: 'active', lifecycleState: 'active',
      workspaceSettingsUrl: 'https://web.example/settings',
    });
    expect(context).toMatchObject({ workspaceId: 'ws-personal', workspaceType: 'personal', workspaceMemberId: 'wm-owner' });
    expect(context?.workspaceSettingsUrl).toBeUndefined();
  });
});
