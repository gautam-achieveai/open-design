import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMcpToolCall, TOOL_DEFS } from '../src/mcp.js';

describe('retired local MCP Vela login tools', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not advertise login or login-status tools', () => {
    const names = TOOL_DEFS.map((tool) => tool.name);
    expect(names).not.toContain('start_vela_login');
    expect(names).not.toContain('get_vela_login_status');
  });

  it.each(['start_vela_login', 'get_vela_login_status'])(
    'rejects an older caller of %s without contacting the daemon',
    async (name) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const result = await handleMcpToolCall('http://127.0.0.1:17456', name, {});
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('unknown tool');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
