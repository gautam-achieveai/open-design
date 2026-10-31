import { describe, expect, it } from 'vitest';

import {
  IMAGE_MODELS,
  MEDIA_PROVIDERS,
  canonicalMediaModelId,
  findMediaModel,
} from '../../src/media/models.js';

describe('image model defaults', () => {
  it('does not silently select a replacement paid image provider', () => {
    expect(IMAGE_MODELS.filter((model) => model.default).map((model) => model.id)).toEqual([]);
    expect(MEDIA_PROVIDERS.some((provider) => provider.id === 'vela')).toBe(false);
    expect(IMAGE_MODELS.some((model) => model.provider === 'codex')).toBe(false);
  });

  it.each(['vela/gpt-image-2', 'codex-gpt-image-2', 'nano-banana', 'nano-banana-2'])('rejects retired media choice %s without retargeting it', (id) => {
    expect(canonicalMediaModelId(id)).toBe(id);
    expect(findMediaModel(id)).toBeNull();
  });

  it('preserves explicit OpenAI BYOK model selection', () => {
    expect(canonicalMediaModelId('gpt-image-2')).toBe('gpt-image-2');
    expect(findMediaModel('gpt-image-2')?.provider).toBe('openai');
  });
});
