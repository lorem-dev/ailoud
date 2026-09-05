import { describe, expect, it } from 'vitest';
import { isHostedLlm, withoutTrailingSlashes } from './llmHost.js';

describe('isHostedLlm', () => {
  it('recognises the two hosted APIs', () => {
    expect(isHostedLlm('https://api.openai.com/v1')).toBe(true);
    expect(isHostedLlm('https://api.anthropic.com')).toBe(true);
  });

  it('is not fooled by a host that merely starts with one', () => {
    // The defect this replaced: `startsWith('https://api.openai.com')` and
    // `/api\.(openai|anthropic)\.com/` both said yes to these, and the part
    // of a hostname that decides where a request goes is the end of it.
    expect(isHostedLlm('https://api.openai.com.example.net/v1')).toBe(false);
    expect(isHostedLlm('https://api.anthropic.com.example.net')).toBe(false);
  });

  it('is not fooled by the name appearing elsewhere in the URL', () => {
    expect(isHostedLlm('https://example.net/?upstream=api.openai.com')).toBe(false);
    expect(isHostedLlm('https://example.net/api.openai.com')).toBe(false);
  });

  it('treats a local server as not hosted', () => {
    expect(isHostedLlm('http://localhost:11434/v1')).toBe(false);
    expect(isHostedLlm('http://127.0.0.1:8080')).toBe(false);
  });

  it('ignores case in the hostname, as DNS does', () => {
    expect(isHostedLlm('https://API.OpenAI.com/v1')).toBe(true);
  });

  it('says no to something that is not a URL', () => {
    // Reported as a configuration error elsewhere. Calling it hosted here
    // would demand an API key for a value that cannot address anything.
    expect(isHostedLlm('api.openai.com')).toBe(false);
    expect(isHostedLlm('')).toBe(false);
  });
});

describe('withoutTrailingSlashes', () => {
  it('strips one slash and many', () => {
    expect(withoutTrailingSlashes('https://x.test/')).toBe('https://x.test');
    expect(withoutTrailingSlashes('https://x.test/v1///')).toBe('https://x.test/v1');
  });

  it('leaves a value with none alone', () => {
    expect(withoutTrailingSlashes('https://x.test/v1')).toBe('https://x.test/v1');
  });

  it('handles a value that is only slashes without backtracking', () => {
    // The reason this is a loop and not `replace(/\/+$/, '')`.
    expect(withoutTrailingSlashes('/'.repeat(50_000))).toBe('');
  });
});
