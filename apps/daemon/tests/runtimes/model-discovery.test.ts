import { describe, expect, it } from 'vitest';

import {
  antigravityAgentDef,
  parseAntigravityModels,
} from '../../src/runtimes/defs/antigravity.js';
import { parseQoderModels, qoderAgentDef } from '../../src/runtimes/defs/qoder.js';

describe('Antigravity live model discovery', () => {
  it('parses account-specific slug/display-label rows and ignores status prose', () => {
    expect(parseAntigravityModels([
      'Fetching available models...',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-4-argon-high\tGemini 4 Argon (High)',
      'claude-sonnet-5-5\tClaude Sonnet 5.5 (Thinking)',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    ].join('\n'))).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'Gemini 3.8 Flash (High)', label: 'Gemini 3.8 Flash (High)' },
      { id: 'Gemini 4 Argon (High)', label: 'Gemini 4 Argon (High)' },
      { id: 'Claude Sonnet 5.5 (Thinking)', label: 'Claude Sonnet 5.5 (Thinking)' },
    ]);
    expect(antigravityAgentDef.listModels?.args).toEqual(['models']);
    expect(antigravityAgentDef.fallbackModels.map((model) => model.id)).toEqual(['default']);
  });

  it('accepts legacy labels and stable slugs but fails closed without a model', () => {
    expect(parseAntigravityModels('Gemini 3.8 Flash (Medium)')).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'Gemini 3.8 Flash (Medium)', label: 'Gemini 3.8 Flash (Medium)' },
    ]);
    expect(parseAntigravityModels('gemini-3.8-flash-low')).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'gemini-3.8-flash-low', label: 'gemini-3.8-flash-low' },
    ]);
    expect(parseAntigravityModels('Fetching available models...\nAuthentication required')).toBeNull();
    expect(parseAntigravityModels('')).toBeNull();
  });
});

describe('Qoder live model discovery', () => {
  it('parses the current account catalog and preserves model names', () => {
    expect(parseQoderModels([
      'MODEL',
      'auto',
      'ultimate',
      'Qwen3.8-Max',
      'Kimi-K3',
      'DeepSeek-V4-Pro',
      'Qwen3.8-Max',
    ].join('\n'))).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'auto', label: 'auto' },
      { id: 'ultimate', label: 'ultimate' },
      { id: 'Qwen3.8-Max', label: 'Qwen3.8-Max' },
      { id: 'Kimi-K3', label: 'Kimi-K3' },
      { id: 'DeepSeek-V4-Pro', label: 'DeepSeek-V4-Pro' },
    ]);
    expect(qoderAgentDef.listModels?.args).toEqual(['--list-models']);
  });

  it('accepts value/label TSV and rejects headers, errors, and empty output', () => {
    expect(parseQoderModels('MODEL\nqwen3.8-max\tQwen3.8-Max')).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'qwen3.8-max', label: 'Qwen3.8-Max' },
    ]);
    expect(parseQoderModels('MODEL')).toBeNull();
    expect(parseQoderModels('Authentication required\nFailed to fetch models')).toBeNull();
  });
});
