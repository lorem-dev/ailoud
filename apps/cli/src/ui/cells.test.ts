import { describe, expect, it } from 'vitest';
import { languageLabel, previewCell } from './cells.js';

describe('languageLabel', () => {
  it('joins every language of a code-switched recording', () => {
    expect(languageLabel(['en', 'ru'], 'en')).toBe('en+ru');
  });

  it('falls back to the stored code when no per-segment language was recorded', () => {
    expect(languageLabel([], 'ru')).toBe('ru');
  });

  it('passes a null fallback through, for a recording with no transcript', () => {
    expect(languageLabel([], null)).toBeNull();
  });
});

describe('previewCell', () => {
  it('quotes a sample so trailing whitespace is visible', () => {
    expect(previewCell('hello  ')).toBe('"hello  "');
  });

  it('leaves an absent preview empty rather than rendering empty quotes', () => {
    // A recording imported but not yet transcribed has no sample at all;
    // `""` would claim it has one that happens to be blank.
    expect(previewCell('')).toBe('');
  });

  it('escapes a control character instead of letting it reach the terminal', () => {
    expect(previewCell('a\u001bb')).toBe('"a\\u001bb"');
  });
});
