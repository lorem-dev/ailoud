import { describe, expect, it } from 'vitest';
import { apiKeyFrom } from './apiKey.js';

describe('apiKeyFrom', () => {
  it('prefers the laud-specific key over the shared vendor one', () => {
    expect(
      apiKeyFrom({ LAUD_LLM_API_KEY: 'mine', OPENAI_API_KEY: 'shared' }, 'OPENAI_API_KEY'),
    ).toBe('mine');
  });

  it('falls back to the vendor variable', () => {
    expect(apiKeyFrom({ ANTHROPIC_API_KEY: 'k' }, 'ANTHROPIC_API_KEY')).toBe('k');
  });

  it('reads only the vendor variable it was asked for', () => {
    expect(apiKeyFrom({ OPENAI_API_KEY: 'k' }, 'ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('treats an exported-but-blank variable as absent', () => {
    // Otherwise doctor reports "key set" while every request comes back 401.
    expect(apiKeyFrom({ ANTHROPIC_API_KEY: '' }, 'ANTHROPIC_API_KEY')).toBeUndefined();
    expect(apiKeyFrom({ ANTHROPIC_API_KEY: '  ' }, 'ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('falls through a blank laud key to a real vendor key', () => {
    expect(apiKeyFrom({ LAUD_LLM_API_KEY: '', ANTHROPIC_API_KEY: 'k' }, 'ANTHROPIC_API_KEY')).toBe(
      'k',
    );
  });

  it('returns undefined when nothing is set', () => {
    expect(apiKeyFrom({}, 'OPENAI_API_KEY')).toBeUndefined();
  });
});
