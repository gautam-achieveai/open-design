import path from 'node:path';
import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

const QODER_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

/** Parse Qoder's MODEL header plus one model name per line, or value/label TSV. */
export function parseQoderModels(stdout: string): RuntimeModelOption[] | null {
  const out: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>([DEFAULT_MODEL_OPTION.id]);
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line === 'MODEL') continue;
    const columns = line.split('\t').map((column) => column.trim());
    const id = columns[0] ?? '';
    if (!QODER_MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: columns[1] || id });
  }
  return out.length > 1 ? out : null;
}

export const qoderAgentDef = {
    id: 'qoder',
    name: 'Qoder CLI',
    bin: 'qodercli',
    versionArgs: ['--version'],
    listModels: {
      args: ['--list-models'],
      timeoutMs: 15_000,
      parse: parseQoderModels,
    },
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      { id: 'lite', label: 'Lite' },
      { id: 'efficient', label: 'Efficient' },
      { id: 'auto', label: 'Auto' },
      { id: 'performance', label: 'Performance' },
      { id: 'ultimate', label: 'Ultimate' },
    ],
    // Qoder print mode exits after the turn. Deliver the composed prompt via
    // stdin to avoid argv length limits, while using stream-json so the daemon
    // can surface text and usage incrementally. `--yolo` is Qoder's documented
    // non-interactive approval flag, and `-w` selects the workspace.
    // Authentication remains Qoder CLI-owned: users can rely on persisted
    // `qodercli login` state, or launch the daemon with
    // QODER_PERSONAL_ACCESS_TOKEN for automation. Do not add that token to
    // static adapter env; unlike Gemini's workspace trust flag it is a user
    // secret and already flows through the inherited process environment.
    buildArgs: (
      _prompt,
      imagePaths,
      extraAllowedDirs = [],
      options = {},
      runtimeContext = {},
    ) => {
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--yolo',
      ];
      if (runtimeContext.cwd) {
        args.push('-w', runtimeContext.cwd);
      }
      if (options.model && options.model !== 'default') {
        args.push('--model', options.model);
      }
      const dirs = (extraAllowedDirs || []).filter(
        (d) => typeof d === 'string' && path.isAbsolute(d),
      );
      const attachments = (imagePaths || []).filter(
        (p) => typeof p === 'string' && path.isAbsolute(p),
      );
      for (const d of dirs) args.push('--add-dir', d);
      for (const p of attachments) args.push('--attachment', p);
      return args;
    },
    promptViaStdin: true,
    streamFormat: 'qoder-stream-json',
} satisfies RuntimeAgentDef;
