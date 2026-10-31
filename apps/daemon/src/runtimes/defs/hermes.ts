import { detectAcpModels, DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const hermesAgentDef = {
    id: 'hermes',
    name: 'Hermes',
    bin: 'hermes',
    versionArgs: ['--version'],
    fetchModels: async (resolvedBin, env) =>
      detectAcpModels({
        bin: resolvedBin,
        args: ['acp', '--accept-hooks'],
        env,
        timeoutMs: 15_000,
        defaultModelOption: DEFAULT_MODEL_OPTION,
      }),
    // Used only when `fetchModels` (which calls `hermes acp` to enumerate
    // the user's actually-installed providers) fails — e.g. Hermes isn't on
    // PATH yet. The list doubles as discovery hints in the model picker so a
    // user who hasn't installed Hermes still sees what becomes available
    // after `hermes auth add xai-oauth` (xAI · SuperGrok subscription) or
    // `hermes auth add openai` (Codex). Reference: https://x.ai/news/grok-hermes.
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      // xAI Grok — available via SuperGrok OAuth (`hermes auth add xai-oauth`)
      // or XAI_API_KEY in `~/.hermes/.env`.
      { id: 'grok-4.7', label: 'grok-4.7 (xAI)' },
      // OpenAI Codex.
      {
        id: 'openai-codex:gpt-6.1-sol',
        label: 'gpt-6.1-sol (openai-codex:gpt-6.1-sol)',
      },
      {
        id: 'openai-codex:gpt-6-astra',
        label: 'gpt-6-astra (openai-codex:gpt-6-astra)',
      },
      {
        id: 'openai-codex:gpt-6-luna',
        label: 'gpt-6-luna (openai-codex:gpt-6-luna)',
      },
    ],
    buildArgs: () => ['acp', '--accept-hooks'],
    streamFormat: 'acp-json-rpc',
    mcpDiscovery: 'mature-acp',
    externalMcpInjection: 'acp-merge',
} satisfies RuntimeAgentDef;
