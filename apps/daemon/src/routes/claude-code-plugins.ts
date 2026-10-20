import type { Express } from 'express';
import type { ClaudeCodePluginsResponse } from '@open-design/contracts';
import { readClaudeCodePlugins } from '../claude-code-plugins.js';

export interface RegisterClaudeCodePluginRoutesDeps {
  /** Claude config dir the daemon's `claude` child would use. */
  resolveConfigDir: () => Promise<string>;
}

// Read-only. Claude Code loads its own plugins when OpenDesign spawns
// `claude`; this endpoint only reports what is installed there.
export function registerClaudeCodePluginRoutes(
  app: Express,
  deps: RegisterClaudeCodePluginRoutesDeps,
): void {
  app.get('/api/claude-code/plugins', async (_req, res) => {
    try {
      const configDir = await deps.resolveConfigDir();
      const body: ClaudeCodePluginsResponse = await readClaudeCodePlugins(configDir);
      res.json(body);
    } catch (err) {
      res.status(500).json({
        error: {
          code: 'claude-code-plugins-read-failed',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });
}
