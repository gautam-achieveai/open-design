import { describe, expect, it } from 'vitest';
import {
  agentModelIsSelectable,
  defaultAgentModelId,
  effectiveAgentModelChoice,
  effectiveAgentModelId,
} from '../../src/components/agentModelSelection';
import type { AgentInfo } from '../../src/types';

const amrAgent: AgentInfo = {
  id: 'amr',
  name: 'AMR',
  bin: 'amr',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'glm-5', label: 'GLM 5' },
    { id: 'glm-5.1', label: 'GLM 5.1' },
  ],
};

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  available: true,
  version: '1.0.0',
  models: [{ id: 'default', label: 'Default' }],
};

describe('agent model selection', () => {
  it('keeps non-AMR custom model choices unchanged', () => {
    expect(
      effectiveAgentModelChoice(codexAgent, {
        model: 'custom-codex-model',
        reasoning: 'high',
      }),
    ).toEqual({
      model: 'custom-codex-model',
      reasoning: 'high',
    });
  });

  it('leaves a retired saved choice unchanged and never offers its catalogue', () => {
    const choice = { model: 'gpt-5.4-mini', reasoning: 'medium' };
    expect(effectiveAgentModelChoice(amrAgent, choice)).toEqual(choice);
    expect(defaultAgentModelId(amrAgent)).toBeNull();
    expect(agentModelIsSelectable(amrAgent, 'glm-5')).toBe(false);
    expect(agentModelIsSelectable(amrAgent, 'default')).toBe(false);
  });

  it('keeps local custom model selection and rejects an empty id', () => {
    expect(agentModelIsSelectable(codexAgent, 'custom-model')).toBe(true);
    expect(agentModelIsSelectable(codexAgent, '')).toBe(false);
  });
});
