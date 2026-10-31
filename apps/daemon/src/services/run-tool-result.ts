import { buildProjectRawFileUrl } from '@open-design/contracts';
import { DEFAULT_AMR_RECHARGE_URL } from '../integrations/vela-errors.js';

type RecordValue = Record<string, unknown>;
export const RUN_RECHARGE_HINT = 'OpenDesign Cloud paused this logical run because the account balance is insufficient. Preserve the brief and project, show rechargeUrl to the user, and do not switch modes. After the user confirms the top-up, call start_run once with the exact original payload, the same requestId, and resume:true; OpenDesign Cloud will resume the existing run and billing operation. Do not expose internal runtime or tool identifiers.';

function textPrefix(text: string, count: number): string {
  let end = Math.max(0, count);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

/** Same text_delta convention as the stdio events endpoint, with an explicit bound. */
export function runAgentText(events: readonly { event: string; data?: unknown }[], maxChars = 16_000) {
  let message = '', truncated = false;
  for (const event of events) {
    const data = event.data as { type?: unknown; delta?: unknown } | null;
    if (event.event !== 'agent' || data?.type !== 'text_delta' || typeof data.delta !== 'string') continue;
    if (truncated) break;
    const next = textPrefix(data.delta, maxChars - message.length);
    message += next;
    truncated ||= next.length < data.delta.length;
  }
  return { message: message || null, truncated };
}

function studioUrl(base: string | null, project: unknown, conversation: unknown, entry: string | null): string | null {
  if (!base || typeof project !== 'string' || !project || typeof conversation !== 'string' || !conversation) return null;
  const root = `${base}/projects/${encodeURIComponent(project)}/conversations/${encodeURIComponent(conversation)}`;
  return entry ? `${root}/files/${entry.split('/').filter(Boolean).map(encodeURIComponent).join('/')}` : root;
}

/** Delivery formatting shared by stdio and daemon HTTP MCP; no I/O or authority policy. */
export function enrichRunToolResult(status: RecordValue, options: {
  daemonBaseUrl: string; webBaseUrl: string | null; agentMessage?: string | null;
  agentMessageTruncated?: boolean; legacyEntryFile?: string | null;
}): RecordValue {
  const success = status.status === 'succeeded' && typeof status.projectId === 'string' && Boolean(status.projectId);
  const authoritative = typeof status.deliverableValid === 'boolean' || typeof status.deliverableValidation === 'string';
  const entry = success && status.deliverableValid === true && status.deliverableValidation === 'valid' && typeof status.deliverableEntryFile === 'string'
    ? status.deliverableEntryFile : success && !authoritative ? options.legacyEntryFile ?? null : null;
  const studio = studioUrl(options.webBaseUrl, status.projectId, status.conversationId, entry);
  const result: RecordValue = { ...status };
  if (studio) result.studioUrl = studio;
  if (!success) {
    if (status.failureAction === 'recharge') { result.rechargeUrl = DEFAULT_AMR_RECHARGE_URL; result.hint = RUN_RECHARGE_HINT; }
    if (typeof status.eventsLogPath === 'string' && status.eventsLogPath) {
      if (status.failureAction !== 'recharge') result.hint = 'Run still in flight. Tail eventsLogPath in your own shell (e.g. `tail -n 50 -f "' + status.eventsLogPath + '"`) to see live text_delta / tool_use events from the inner agent — that is your in-flight progress signal. Keep polling get_run every 30–60s; do not cancel because file mtimes look static, that is the agent thinking between writes.';
      if (studio) result.hint = String(result.hint) + ` While the run is in flight, studioUrl can be used as an optional workspace progress link — render it as \`[Watch progress in OpenDesign studio](${studio})\` if you choose to show it. This URL is valid for the current OpenDesign runtime; call get_run again after OpenDesign restarts.`;
    }
    return result;
  }
  const preview = entry ? buildProjectRawFileUrl(options.daemonBaseUrl, status.projectId as string, entry) : null;
  if (preview && entry) Object.assign(result, { previewUrl: preview, entryFile: entry,
    artifactRef: { projectId: status.projectId, entryFile: entry }, previewUrlLifetime: 'current_daemon_session' });
  if (studio) result.studioUrlLifetime = 'current_daemon_session';
  if (options.agentMessage) {
    result.agentMessage = textPrefix(options.agentMessage, 16_000);
    if (options.agentMessage.length > 16_000 || options.agentMessageTruncated) result.agentMessageTruncated = true;
  } else if (options.agentMessageTruncated) result.agentMessageTruncated = true;
  result.hint = preview
    ? `Run finished. artifactRef is the durable project/file identity. previewUrl and studioUrl are browser links for the current OpenDesign runtime only; if either stops working after OpenDesign restarts, call get_run again with this runId to obtain current links. Render previewUrl as a clickable link now. agentMessage carries the inner agent's explanation; show it alongside the link. Call get_artifact({ project: "${status.projectId}" }) when you need the source files — always pass project explicitly; omitting it falls back to the active project, which may differ. eventsLogPath, when present, holds the full inner-agent event log for forensics.`
    : 'Run finished but produced no files. The inner agent\'s output is in agentMessage — relay it to the user verbatim. Most often this is a clarifying question (e.g. a <question-form>) you should answer by calling start_run again with a more specific prompt or a chosen plugin. When studioUrl is present, show it as a clickable markdown link (`[Open OpenDesign studio](STUDIO_URL)`) so the user can navigate to the OD page that shows the chat history — never render it as inline code. eventsLogPath, when present, holds the full event log if you need to inspect what happened.';
  return result;
}

/** Trim only agent text; mandatory identity/status/link/error fields stay intact. */
export function fitRunAgentText(data: RecordValue, fits: (value: RecordValue) => boolean): RecordValue | null {
  if (fits(data)) return data;
  if (typeof data.agentMessage !== 'string') return null;
  const result = { ...data, agentMessage: '', agentMessageTruncated: true };
  if (!fits(result)) return null;
  let low = 0, high = data.agentMessage.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    result.agentMessage = textPrefix(data.agentMessage, mid);
    if (fits(result)) low = mid; else high = mid - 1;
  }
  result.agentMessage = textPrefix(data.agentMessage, low);
  return result;
}
