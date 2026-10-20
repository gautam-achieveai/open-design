import { describe, expect, it } from 'vitest';

import {
  AGENT_CONFIGURATION_DIRECTIVE,
  AGENT_CONFIGURATION_PRIORITY_ITEM,
  AGENT_CONFIGURATION_TRUST_RULE,
} from '@open-design/contracts';

import { SLIM_DESIGN_CRAFT, SLIM_REFINEMENT_RULES } from '../../src/prompts/core-slim.js';
import { composeSystemPrompt } from '../../src/prompts/system.js';

/**
 * Two promises the prompt makes to a developer driving OpenDesign through
 * their own agent CLI:
 *
 * 1. Their agent configuration (CLAUDE.md / AGENTS.md, installed skills) is
 *    followed, not read as untrusted file content, on every legacy head:
 *    slim, classic, Ask, and media. API/BYOK runs (text_artifact) have no
 *    agent CLI and stay untouched.
 * 2. Build mode swaps the design-artifact charter for the builder charter
 *    while keeping OpenDesign's UX craft and refinement loop.
 */
const filesystem = { metadata: { kind: 'prototype' as const }, executionProfile: 'filesystem' as const };
const textArtifact = { metadata: { kind: 'prototype' as const }, executionProfile: 'text_artifact' as const };

describe('the user’s own agent configuration', () => {
  it('slim filesystem runs rank it in the priority list and trust it', () => {
    const prompt = composeSystemPrompt({ ...filesystem, promptCoreVariant: 'slim' });
    expect(prompt).toContain(`3. ${AGENT_CONFIGURATION_PRIORITY_ITEM}`);
    expect(prompt).toContain(AGENT_CONFIGURATION_TRUST_RULE);
  });

  it('classic, Ask, and media filesystem heads carry the directive block', () => {
    for (const input of [
      filesystem,
      { ...filesystem, promptCoreVariant: 'slim' as const, sessionMode: 'chat' as const },
      { ...filesystem, metadata: { kind: 'image' as const } },
    ]) {
      expect(composeSystemPrompt(input)).toContain(AGENT_CONFIGURATION_DIRECTIVE);
    }
  });

  it('text-artifact runs never mention it', () => {
    for (const variant of ['classic', 'slim'] as const) {
      const prompt = composeSystemPrompt({ ...textArtifact, promptCoreVariant: variant });
      expect(prompt).not.toContain(AGENT_CONFIGURATION_PRIORITY_ITEM);
      expect(prompt).not.toContain(AGENT_CONFIGURATION_TRUST_RULE);
    }
  });
});

describe('Build mode', () => {
  const build = composeSystemPrompt({ ...filesystem, promptCoreVariant: 'slim', sessionMode: 'build' });

  it('leads with the builder charter and its product-manager role', () => {
    expect(build.startsWith('# OpenDesign Build Charter')).toBe(true);
    expect(build).toContain('product manager with full-stack engineering and design experience');
    expect(build).toContain(AGENT_CONFIGURATION_PRIORITY_ITEM);
    expect(build).toContain(AGENT_CONFIGURATION_TRUST_RULE);
  });

  it('keeps OpenDesign’s UX craft, refinement rules, and clarification form', () => {
    expect(build).toContain(SLIM_DESIGN_CRAFT);
    expect(build).toContain(SLIM_REFINEMENT_RULES);
    expect(build).toContain('## Structured clarification on any turn');
  });

  it('drops the design-artifact contract and direction library', () => {
    for (const heading of [
      '# OpenDesign Charter',
      '## Requirements Clarification Phase',
      '## Artifact Design Phase',
      '## Technical Contract',
      '## Direction library',
      '## Semantic output file names',
    ]) {
      expect(build).not.toContain(heading);
    }
  });

  it('is the same on the classic core: Build has one charter', () => {
    const classicBuild = composeSystemPrompt({ ...filesystem, sessionMode: 'build' });
    expect(classicBuild.startsWith('# OpenDesign Build Charter')).toBe(true);
  });

  it('falls back to the design charter when no agent CLI runs the turn', () => {
    const prompt = composeSystemPrompt({ ...textArtifact, promptCoreVariant: 'slim', sessionMode: 'build' });
    expect(prompt).not.toContain('# OpenDesign Build Charter');
  });
});
