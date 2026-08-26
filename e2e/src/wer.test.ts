import { describe, expect, it } from 'vitest';
import { wordErrorRate } from './wer.js';

describe('wordErrorRate', () => {
  it('is zero for identical text', () => {
    expect(wordErrorRate('the quick brown fox', 'the quick brown fox')).toBe(0);
  });

  it('ignores case and punctuation', () => {
    expect(wordErrorRate('The quick, brown fox!', 'the quick brown fox')).toBe(0);
  });

  it('counts one substitution in four words as 0.25', () => {
    expect(wordErrorRate('the quick brown fox', 'the quick brown cat')).toBeCloseTo(0.25);
  });

  it('counts a deletion', () => {
    expect(wordErrorRate('the quick brown fox', 'the quick fox')).toBeCloseTo(0.25);
  });

  it('counts an insertion', () => {
    expect(wordErrorRate('the quick fox', 'the quick brown fox')).toBeCloseTo(1 / 3);
  });

  it('is 1 when the hypothesis is empty', () => {
    expect(wordErrorRate('the quick brown fox', '')).toBe(1);
  });

  it('is 0 when both reference and hypothesis are empty', () => {
    expect(wordErrorRate('', '')).toBe(0);
  });

  // Cyrillic words below are written as \u escapes, not literal
  // characters, so this source file -- like all source in this repo --
  // stays ASCII-only. The escapes still decode to real Cyrillic strings at
  // runtime, so this genuinely exercises the \p{L} branch of normalize()
  // on non-Latin text. (Transliteration: "segodnya khoroshaya pogoda" =
  // "today [is] good weather"; "plokhaya" = "bad".)
  it('does not strip Cyrillic letters as punctuation', () => {
    const upper =
      '\u0421\u0435\u0433\u043e\u0434\u043d\u044f \u0445\u043e\u0440\u043e\u0448\u0430\u044f \u043f\u043e\u0433\u043e\u0434\u0430';
    const lower =
      '\u0441\u0435\u0433\u043e\u0434\u043d\u044f \u0445\u043e\u0440\u043e\u0448\u0430\u044f \u043f\u043e\u0433\u043e\u0434\u0430';
    expect(wordErrorRate(upper, lower)).toBe(0);
  });

  it('is sensitive to a Cyrillic substitution', () => {
    const reference =
      '\u0441\u0435\u0433\u043e\u0434\u043d\u044f \u0445\u043e\u0440\u043e\u0448\u0430\u044f \u043f\u043e\u0433\u043e\u0434\u0430';
    const hypothesis =
      '\u0441\u0435\u0433\u043e\u0434\u043d\u044f \u043f\u043b\u043e\u0445\u0430\u044f \u043f\u043e\u0433\u043e\u0434\u0430';
    expect(wordErrorRate(reference, hypothesis)).toBeCloseTo(1 / 3);
  });
});
