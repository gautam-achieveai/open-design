import type { ClaudeCodePluginsResponse } from '@open-design/contracts';

export type ClaudeCodePluginsLoad =
  | { ok: true; data: ClaudeCodePluginsResponse }
  | { ok: false; message: string };

/**
 * Read-only inventory of the user's Claude Code plugins
 * (GET /api/claude-code/plugins; `od plugin list --source claude-code` reads
 * the same endpoint). Failures come back as `{ ok: false }` so the panel can
 * show them instead of rendering an empty list.
 */
export async function fetchClaudeCodePlugins(): Promise<ClaudeCodePluginsLoad> {
  let resp: Response;
  try {
    resp = await fetch('/api/claude-code/plugins');
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: { message?: unknown } | string };
      const detail = typeof body.error === 'string' ? body.error : body.error?.message;
      if (typeof detail === 'string' && detail) message = `${message}: ${detail}`;
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    return { ok: false, message };
  }
  try {
    return { ok: true, data: (await resp.json()) as ClaudeCodePluginsResponse };
  } catch (err) {
    return { ok: false, message: `Invalid response: ${err instanceof Error ? err.message : String(err)}` };
  }
}
