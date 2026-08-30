import { describe, expect, it } from 'vitest';
import type { Segment } from '../domain/model.js';
import { summarizeLanguages } from './languages.js';

function segment(partial: Partial<Segment>): Segment {
  return {
    id: 'seg',
    transcriptId: 't',
    idx: 0,
    startMs: 0,
    endMs: 1000,
    text: '',
    speaker: null,
    language: null,
    ...partial,
  };
}

describe('summarizeLanguages', () => {
  it('returns the single language of a monolingual transcript', () => {
    expect(summarizeLanguages([segment({ language: 'en' })])).toEqual(['en']);
  });

  it('lists every language present, not just the dominant one', () => {
    const segments = [
      segment({ idx: 0, startMs: 0, endMs: 1680, language: 'en' }),
      segment({ idx: 1, startMs: 1730, endMs: 3410, language: 'ru' }),
    ];
    expect(summarizeLanguages(segments)).toEqual(['en', 'ru']);
  });

  it('orders by total spoken duration, not by first appearance', () => {
    const segments = [
      segment({ idx: 0, startMs: 0, endMs: 500, language: 'en' }),
      segment({ idx: 1, startMs: 500, endMs: 4000, language: 'ru' }),
    ];
    expect(summarizeLanguages(segments)).toEqual(['ru', 'en']);
  });

  it('sums a language spread across several separated runs', () => {
    const segments = [
      segment({ idx: 0, startMs: 0, endMs: 1000, language: 'en' }),
      segment({ idx: 1, startMs: 1000, endMs: 2500, language: 'ru' }),
      segment({ idx: 2, startMs: 2500, endMs: 3600, language: 'en' }),
    ];
    // en totals 2100 ms across two runs, ru 1500 ms in one.
    expect(summarizeLanguages(segments)).toEqual(['en', 'ru']);
  });

  it('breaks a duration tie by first appearance', () => {
    const segments = [
      segment({ idx: 0, startMs: 0, endMs: 1000, language: 'ru' }),
      segment({ idx: 1, startMs: 1000, endMs: 2000, language: 'en' }),
    ];
    expect(summarizeLanguages(segments)).toEqual(['ru', 'en']);
  });

  it('skips segments with no language rather than inventing a placeholder', () => {
    const segments = [
      segment({ idx: 0, language: null }),
      segment({ idx: 1, startMs: 1000, endMs: 2000, language: 'en' }),
    ];
    expect(summarizeLanguages(segments)).toEqual(['en']);
  });

  it('returns nothing when no segment records a language', () => {
    expect(summarizeLanguages([segment({ language: null })])).toEqual([]);
  });

  it('returns nothing for no segments', () => {
    expect(summarizeLanguages([])).toEqual([]);
  });

  it('does not let a negative-duration segment reorder the result', () => {
    const segments = [
      segment({ idx: 0, startMs: 0, endMs: 3000, language: 'en' }),
      segment({ idx: 1, startMs: 3000, endMs: 1000, language: 'en' }),
      segment({ idx: 2, startMs: 3000, endMs: 4000, language: 'ru' }),
    ];
    expect(summarizeLanguages(segments)).toEqual(['en', 'ru']);
  });
});
