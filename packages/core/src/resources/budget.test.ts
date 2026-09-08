import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_CPU_PERCENT, resourceBudget } from './budget.js';

describe('resourceBudget', () => {
  it.each([
    // logical, performance, percent, threads, cappedThreads
    [10, 8, 90, 7, 6],
    [10, 8, 100, 8, 6],
    [10, 8, 50, 4, 4],
    [10, 8, 10, 1, 1],
    [10, null, 90, 9, 6],
    [16, null, 90, 14, 6],
    [64, null, 90, 58, 6],
    [2, null, 100, 2, 2],
    [1, null, 90, 1, 1],
    [4, null, 0, 4, 4],
  ])(
    'gives %i logical / %s performance at %i%% -> %i threads, %i for the capped engines',
    (logical, performance, maxCpuPercent, threads, cappedThreads) => {
      const budget = resourceBudget({ logical, performance }, { maxCpuPercent });
      expect(budget.threads).toBe(threads);
      expect(budget.cappedThreads).toBe(cappedThreads);
    },
  );

  it('never lets the diarizer or the VAD reach the thread count measured as catastrophic', () => {
    // The whole reason cappedThreads exists. On this project's reference
    // machine (8 performance cores) both the diarizer and the VAD segmenter
    // are slower at 8 threads than at 1; at 6 each is fastest. No percent may
    // produce the bad number.
    for (let percent = 1; percent <= 100; percent += 1) {
      const budget = resourceBudget({ logical: 10, performance: 8 }, { maxCpuPercent: percent });
      expect(budget.cappedThreads).toBeLessThanOrEqual(6);
      expect(budget.cappedThreads).toBeGreaterThanOrEqual(1);
    }
  });

  it('never lets cappedThreads exceed 6, on any plausible machine shape', () => {
    // The defect this locks against: an earlier revision capped cappedThreads
    // relative to the machine's size (`base - 2`), which stopped binding at
    // all above ~16 logical cores -- exactly the shape most non-Apple-Silicon
    // servers have, since `performance` is null everywhere except darwin. The
    // table-driven test above only ever swept one topology (10/8), which is
    // exactly why that defect survived review.
    const logicalCounts = [1, 2, 4, 8, 10, 16, 32, 64, 128];
    for (const logical of logicalCounts) {
      for (const performance of [null, Math.max(1, Math.round(logical * 0.75))]) {
        for (let percent = 1; percent <= 100; percent += 1) {
          const budget = resourceBudget({ logical, performance }, { maxCpuPercent: percent });
          expect(budget.cappedThreads).toBeLessThanOrEqual(6);
          expect(budget.cappedThreads).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('prefers performance cores over logical ones when the split is known', () => {
    // Efficiency cores make whisper.cpp slower, not faster: every layer waits
    // for its slowest thread.
    expect(resourceBudget({ logical: 10, performance: 8 }, { maxCpuPercent: 100 }).threads).toBe(8);
  });

  it('defaults to 90 percent with no options at all', () => {
    expect(resourceBudget({ logical: 10, performance: 8 })).toEqual({
      threads: 7,
      cappedThreads: 6,
      gpu: true,
    });
  });

  it.each([0, 101, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the default percent rather than throwing on %s',
    (maxCpuPercent) => {
      const fallback = resourceBudget({ logical: 8, performance: null });
      expect(resourceBudget({ logical: 8, performance: null }, { maxCpuPercent })).toEqual(
        fallback,
      );
      expect(DEFAULT_MAX_CPU_PERCENT).toBe(90);
    },
  );

  it('never answers fewer than one thread, whatever it is given', () => {
    // A zero-thread flag would make every engine refuse to start, which is
    // the one outcome a resource hint must never cause.
    expect(resourceBudget({ logical: 0, performance: 0 }, { maxCpuPercent: 1 }).threads).toBe(1);
    expect(resourceBudget({ logical: 0, performance: 0 }, { maxCpuPercent: 1 }).cappedThreads).toBe(
      1,
    );
  });

  it('carries the gpu flag through, defaulting to on', () => {
    expect(resourceBudget({ logical: 8, performance: null }).gpu).toBe(true);
    expect(resourceBudget({ logical: 8, performance: null }, { gpu: false }).gpu).toBe(false);
  });
});
