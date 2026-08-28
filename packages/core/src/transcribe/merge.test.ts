import { describe, expect, it } from 'vitest';
import { MIN_RUN_DURATION_MS, mergeRuns, subdivideSpans } from './merge.js';

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

  it('absorbs two consecutive short spans of different languages', () => {
    // When multiple short misdetections sit back to back, iterative filtering
    // ensures each is recognized as noise. First pass removes ru because fr
    // is its neighbor, then fr is recognized against en.
    const runs = mergeRuns([
      span(0, 10_000, 'en'),
      span(10_200, 10_500, 'ru'),
      span(10_700, 11_000, 'fr'),
      span(11_200, 20_000, 'en'),
    ]);
    expect(runs).toEqual([{ startMs: 0, endMs: 20_000, language: 'en' }]);
  });

  it('absorbs two consecutive short spans of the same language', () => {
    // Two short spans of the same language cannot absorb into each other;
    // but iteration exposes each to the surrounding run.
    const runs = mergeRuns([
      span(0, 10_000, 'en'),
      span(10_200, 10_500, 'ru'),
      span(10_700, 11_000, 'ru'),
      span(11_200, 20_000, 'en'),
    ]);
    expect(runs).toEqual([{ startMs: 0, endMs: 20_000, language: 'en' }]);
  });

  it('absorbs three consecutive short spans', () => {
    // Three or more short spans converge over multiple iterations.
    const runs = mergeRuns([
      span(0, 10_000, 'en'),
      span(10_200, 10_500, 'ru'),
      span(10_700, 11_000, 'fr'),
      span(11_200, 11_500, 'de'),
      span(11_700, 12_000, 'ja'),
      span(12_200, 20_000, 'en'),
    ]);
    expect(runs).toEqual([{ startMs: 0, endMs: 20_000, language: 'en' }]);
  });

  it('absorbs a short run between identical neighbours even when a failed chain scan precedes it', () => {
    // When a chain scan fails to qualify (boundaries differ), do not skip
    // the next run. That run may match Rule 1 (short, between identical neighbors).
    // Regression test for skipped evaluation bug.
    const runs = mergeRuns([
      span(0, 10_000, 'en'),
      span(10_200, 10_500, 'ru'),
      span(10_700, 11_000, 'fr'),
      span(11_200, 11_500, 'ru'),
      span(13_000, 20_000, 'de'),
    ]);
    expect(runs).toHaveLength(3);
    expect(runs.map((run) => run.language)).toEqual(['en', 'ru', 'de']);
    // Verify the merged ru run spans both fragments
    const ruRun = runs[1];
    expect(ruRun).toBeDefined();
    expect(ruRun!.startMs).toBe(10_100);
    expect(ruRun!.endMs).toBe(12_250);
  });
});

describe('subdivideSpans', () => {
  it('passes a span shorter than the window through untouched', () => {
    const spans = [{ startMs: 100, endMs: 4000 }];
    expect(subdivideSpans(spans, 5000)).toEqual(spans);
  });

  it('does not split a span exactly the window length', () => {
    const spans = [{ startMs: 0, endMs: 5000 }];
    expect(subdivideSpans(spans, 5000)).toEqual(spans);
  });

  it('splits a span slightly longer than the window into two', () => {
    const windows = subdivideSpans([{ startMs: 0, endMs: 5001 }], 5000);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.startMs).toBe(0);
    expect(windows[1]!.endMs).toBe(5001);
    expect(windows[0]!.endMs).toBe(windows[1]!.startMs);
  });

  it('splits a long span into equal-ish windows covering it with no gap or overlap', () => {
    const windows = subdivideSpans([{ startMs: 1000, endMs: 14_000 }], 5000);
    expect(windows).toHaveLength(3);
    expect(windows[0]!.startMs).toBe(1000);
    expect(windows.at(-1)!.endMs).toBe(14_000);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]!.startMs).toBe(windows[i - 1]!.endMs);
    }
    for (const w of windows) {
      expect(w.endMs - w.startMs).toBeLessThanOrEqual(5000);
    }
  });

  it('does not leave the last window a sliver', () => {
    // 10001ms over a 5000ms window would be two windows of 5000 and 1 if
    // sliced greedily; equal-ish division keeps both close to half.
    const windows = subdivideSpans([{ startMs: 0, endMs: 10_001 }], 5000);
    expect(windows).toHaveLength(3);
    for (const w of windows) {
      expect(w.endMs - w.startMs).toBeGreaterThan(3000);
    }
  });

  it('leaves multiple spans independent', () => {
    const windows = subdivideSpans(
      [
        { startMs: 0, endMs: 4000 },
        { startMs: 5000, endMs: 16_000 },
      ],
      5000,
    );
    expect(windows[0]).toEqual({ startMs: 0, endMs: 4000 });
    expect(windows.length).toBe(4);
    expect(windows[1]!.startMs).toBe(5000);
    expect(windows.at(-1)!.endMs).toBe(16_000);
  });

  it('splits the ~3.46s bilingual fixture length into two ~1.73s windows at the default window', () => {
    // The regression case: a voice-activity detector returns the whole
    // bilingual fixture as one span because the two clauses have no
    // measurable pause between them. Using the real default window (not a
    // parameter passed by the test) proves the shipped constant, not just
    // the function, does the right thing here.
    const windows = subdivideSpans([{ startMs: 0, endMs: 3460 }]);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.startMs).toBe(0);
    expect(windows.at(-1)!.endMs).toBe(3460);
    for (const w of windows) {
      const duration = w.endMs - w.startMs;
      expect(duration).toBeGreaterThan(1600);
      expect(duration).toBeLessThan(1900);
    }
  });

  it('does not shrink a 2500ms span below the minimum run duration', () => {
    // Regression: equal division into ceil(2500/2000)=2 pieces gives two
    // 1250ms windows, each short enough for mergeRuns to absorb a genuine
    // switch between them as noise. Capping the window count keeps this
    // span whole instead of splitting it into two windows that are too
    // short to trust.
    const windows = subdivideSpans([{ startMs: 0, endMs: 2500 }]);
    expect(windows).toEqual([{ startMs: 0, endMs: 2500 }]);
  });

  it('does not shrink a 4400ms span below the minimum run duration', () => {
    // Regression: equal division into ceil(4400/2000)=3 pieces gives three
    // windows of about 1467ms, each below MIN_RUN_DURATION_MS. Capped to 2
    // windows of 2200ms instead, both above the floor.
    const windows = subdivideSpans([{ startMs: 0, endMs: 4400 }]);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.startMs).toBe(0);
    expect(windows.at(-1)!.endMs).toBe(4400);
    for (const w of windows) {
      expect(w.endMs - w.startMs).toBeGreaterThanOrEqual(MIN_RUN_DURATION_MS);
    }
  });

  it('never returns a window shorter than the minimum run duration, across a sweep of span lengths', () => {
    // The test that would have caught the 2500/4400ms regressions: it does
    // not compare constants to each other, it exercises the function
    // itself, at every duration in the range that matters. For each
    // duration: windows tile the span with no gap or overlap, and every
    // window is at least MIN_RUN_DURATION_MS long unless the whole span
    // (a single window) is itself shorter than that.
    for (let durationMs = 100; durationMs <= 10_000; durationMs += 100) {
      const windows = subdivideSpans([{ startMs: 0, endMs: durationMs }]);

      expect(windows[0]!.startMs).toBe(0);
      expect(windows.at(-1)!.endMs).toBe(durationMs);
      for (let i = 1; i < windows.length; i += 1) {
        expect(windows[i]!.startMs).toBe(windows[i - 1]!.endMs);
      }

      for (const w of windows) {
        const windowDuration = w.endMs - w.startMs;
        const isWholeSpanPassedThrough = windows.length === 1;
        expect(windowDuration >= MIN_RUN_DURATION_MS || isWholeSpanPassedThrough).toBe(true);
      }
    }
  });
});
