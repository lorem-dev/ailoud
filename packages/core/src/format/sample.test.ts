import { describe, expect, it } from 'vitest';
import { quoteSample, truncateSample } from './sample.js';

describe('truncateSample', () => {
  it('leaves text that already fits untouched, with no ellipsis', () => {
    expect(truncateSample('short', 10)).toBe('short');
    expect(truncateSample('exactly10!', 10)).toBe('exactly10!');
  });

  it('marks text that was cut', () => {
    expect(truncateSample('abcdefghijk', 5)).toBe('abcde...');
  });

  it('counts code points, not UTF-16 units, so a surrogate pair is never split', () => {
    // Four astral-plane characters: a naive slice(0, 2) would cut one in half
    // and emit a lone surrogate.
    const emoji = '\u{1F600}\u{1F601}\u{1F602}\u{1F603}';
    const cut = truncateSample(emoji, 2);
    expect(cut).toBe('\u{1F600}\u{1F601}...');
    expect(Array.from(cut)).toHaveLength(5);
  });

  it('handles a zero limit and empty text', () => {
    expect(truncateSample('abc', 0)).toBe('...');
    expect(truncateSample('', 5)).toBe('');
  });
});

describe('quoteSample', () => {
  it('wraps plain text in double quotes', () => {
    expect(quoteSample('hello')).toBe('"hello"');
  });

  it('makes an empty sample distinguishable from a missing one', () => {
    expect(quoteSample('')).toBe('""');
  });

  it('keeps whitespace visible at the edges', () => {
    expect(quoteSample('  padded  ')).toBe('"  padded  "');
  });

  it('escapes the quote and the backslash, without double-escaping', () => {
    expect(quoteSample('a "quoted" word')).toBe('"a \\"quoted\\" word"');
    expect(quoteSample('back\\slash')).toBe('"back\\\\slash"');
    // The backslash produced by escaping a quote must not itself be escaped.
    expect(quoteSample('"')).toBe('"\\""');
  });

  it('escapes the whitespace controls by name', () => {
    expect(quoteSample('a\nb\tc\rd')).toBe('"a\\nb\\tc\\rd"');
  });

  it('escapes an ANSI escape character rather than emitting it', () => {
    // A transcript carrying this would otherwise recolour the rest of the
    // terminal session when the preview was printed.
    expect(quoteSample('\u001b[31mred')).toBe('"\\u001b[31mred"');
  });

  it('escapes other C0 controls and DEL', () => {
    expect(quoteSample('\u0000')).toBe('"\\u0000"');
    expect(quoteSample('\u0007')).toBe('"\\u0007"');
    expect(quoteSample('\u007f')).toBe('"\\u007f"');
  });

  it('leaves non-Latin scripts alone', () => {
    // Escaping these would make a multilingual transcript unreadable, which
    // is the opposite of the point.
    expect(quoteSample('Привет, 世界')).toBe('"Привет, 世界"');
  });
});
