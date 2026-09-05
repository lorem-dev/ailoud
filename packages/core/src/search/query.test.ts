import { describe, expect, it } from 'vitest';
import { UsageError } from '../domain/errors.js';
import { toMatchExpression } from './query.js';

describe('toMatchExpression', () => {
  it('quotes each word, so ordinary speech is not read as syntax', () => {
    expect(toMatchExpression('harbor sunrise')).toBe('"harbor" "sunrise"');
  });

  it('survives the punctuation that appears in real transcripts', () => {
    // Passed through raw, every one of these is an FTS5 syntax error.
    for (const query of ["don't", 'C++', 'plan-b', 'a:b', '(hello)', '-five']) {
      expect(() => toMatchExpression(query), query).not.toThrow();
    }
  });

  it('does not let a word that looks like an operator act as one', () => {
    // A transcript saying "this AND that" must be searchable for those words.
    expect(toMatchExpression('this AND that')).toBe('"this" "AND" "that"');
  });

  it('keeps a quoted run together as a phrase', () => {
    expect(toMatchExpression('"before sunrise"')).toBe('"before sunrise"');
  });

  it('combines a phrase with loose words', () => {
    expect(toMatchExpression('"before sunrise" fuel')).toBe('"before sunrise" "fuel"');
  });

  it('keeps a trailing star as a prefix search', () => {
    // Worth far more in an inflected language: гаван* finds every ending
    // without the user having to know them.
    expect(toMatchExpression('гаван*')).toBe('"гаван"*');
  });

  it('allows a prefix search on a phrase', () => {
    expect(toMatchExpression('"у пирса"*')).toBe('"у пирса"*');
  });

  it('escapes a double quote by doubling it', () => {
    expect(toMatchExpression('say"hi')).toBe('"say""hi"');
  });

  it('ignores a stray star with no word in front of it', () => {
    expect(toMatchExpression('fuel *')).toBe('"fuel"');
  });

  it('ignores an empty quoted run', () => {
    expect(toMatchExpression('"" fuel')).toBe('"fuel"');
  });

  it('refuses a query with nothing in it', () => {
    for (const query of ['', '   ', '""']) {
      expect(() => toMatchExpression(query), JSON.stringify(query)).toThrow(UsageError);
    }
  });
});
