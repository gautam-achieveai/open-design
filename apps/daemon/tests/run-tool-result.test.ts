import { describe, expect, it } from 'vitest';
import { enrichRunToolResult, fitRunAgentText, runAgentText } from '../src/services/run-tool-result.js';

describe('shared stdio/HTTP run delivery formatting', () => {
  it('keeps a continuous prefix without splitting a surrogate or appending later chunks', () => {
    const text = runAgentText([
      { event: 'agent', data: { type: 'text_delta', delta: 'a😀' } },
      { event: 'agent', data: { type: 'text_delta', delta: 'z' } },
    ], 2);
    expect(text).toEqual({ message: 'a', truncated: true });
  });

  it('uses legacy entry only when no authoritative validation is present', () => {
    const options = { daemonBaseUrl: 'http://127.0.0.1:1234', webBaseUrl: 'http://127.0.0.1:4321', legacyEntryFile: 'index.html' };
    const status = { id: 'r', projectId: 'p', conversationId: 'c', status: 'succeeded' };
    expect(enrichRunToolResult(status, options)).toMatchObject({ artifactRef: { projectId: 'p', entryFile: 'index.html' } });
    const invalid = enrichRunToolResult({ ...status, deliverableValid: false, deliverableValidation: 'entry_missing' }, options);
    expect(invalid).not.toHaveProperty('previewUrl'); expect(invalid).not.toHaveProperty('artifactRef');
  });

  it('fits only agent text and refuses to drop oversized mandatory errors', () => {
    const source = { id: 'r', status: 'succeeded', error: 'stable', agentMessage: '😀'.repeat(100), artifactRef: { projectId: 'p', entryFile: 'index.html' } };
    const result = fitRunAgentText(source, value => JSON.stringify(value).length <= 200);
    expect(result).toMatchObject({ id: 'r', status: 'succeeded', error: 'stable', artifactRef: source.artifactRef, agentMessageTruncated: true });
    expect(String(result?.agentMessage)).toMatch(/^(?:😀)*$/u);
    expect(fitRunAgentText(source, () => false)).toBeNull();
  });
});
