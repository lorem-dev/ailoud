import { describe, expect, it } from 'vitest';
import { mergeRuns } from './merge.js';

const span = (startMs: number, endMs: number, language: string) => ({
  startMs,
  endMs,
  language,
});

describe('mergeRuns', () => {
  it('returns nothing for no spans', () => {
    expect(mergeRuns([])).toEqual([]);
  });

  it('keeps a single span as one run', () => {
    expect(mergeRuns([span(1000, 5000, 'en')])).toEqual([
      { startMs: 1000, endMs: 5000, language: 'en' },
    ]);
  });

  it('absorbs the gap between two spans of the same language', () => {
    // A pause inside one speaker's sentence must not become a cut: whisper
    // uses preceding context, and a run that starts mid-thought has none.
    expect(mergeRuns([span(0, 2000, 'en'), span(2600, 5000, 'en')])).toEqual([
      { startMs: 0, endMs: 5000, language: 'en' },
    ]);
  });

  it('splits at the midpoint of the gap when the language changes', () => {
    // Neither side may clip the other's first or last word.
    expect(mergeRuns([span(0, 2000, 'en'), span(3000, 5000, 'ru')])).toEqual([
      { startMs: 0, endMs: 2500, language: 'en' },
      { startMs: 2500, endMs: 5000, language: 'ru' },
    ]);
  });

  it('absorbs a short mis-detected span between two runs of one language', () => {
    // Detection on a very short span is unreliable. One bad half-second
    // must not fracture a paragraph into three transcription passes.
    const runs = mergeRuns([
      span(0, 10_000, 'en'),
      span(10_200, 10_800, 'ru'),
      span(11_000, 20_000, 'en'),
    ]);
    expect(runs).toEqual([{ startMs: 0, endMs: 20_000, language: 'en' }]);
  });

  it('keeps a short span when its neighbours disagree with each other', () => {
    // Not a mis-detection between two halves of one language: a genuine
    // three-way switch. Absorbing it would delete a language.
    const runs = mergeRuns([
      span(0, 10_000, 'en'),
      span(10_200, 10_800, 'ru'),
      span(11_000, 20_000, 'de'),
    ]);
    expect(runs).toHaveLength(3);
    expect(runs.map((run) => run.language)).toEqual(['en', 'ru', 'de']);
  });

  it('keeps a switch that lasts longer than the minimum', () => {
    const runs = mergeRuns([
      span(0, 10_000, 'en'),
      span(10_200, 13_000, 'ru'),
      span(13_200, 20_000, 'en'),
    ]);
    expect(runs.map((run) => run.language)).toEqual(['en', 'ru', 'en']);
  });

  it('leaves no gap or overlap between consecutive runs', () => {
    const runs = mergeRuns([span(0, 2000, 'en'), span(3000, 5000, 'ru'), span(9000, 11_000, 'en')]);
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]!.startMs).toBe(runs[i - 1]!.endMs);
    }
  });

  it('starts at the first span and ends at the last', () => {
    // Audio outside any span is silence by the segmenter's reckoning and
    // belongs to no run -- transcribing it is what the segmenter exists to
    // avoid.
    const runs = mergeRuns([span(1500, 2000, 'en'), span(8000, 9000, 'ru')]);
    expect(runs[0]!.startMs).toBe(1500);
    expect(runs.at(-1)!.endMs).toBe(9000);
  });
});
