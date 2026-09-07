import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_CPU_PERCENT, resourceBudget } from './budget.js';

describe('resourceBudget', () => {
  it.each([
    // logical, performance, percent, threads, diarizerThreads
    [10, 8, 90, 7, 6],
    [10, 8, 100, 8, 6],
    [10, 8, 50, 4, 4],
    [10, 8, 10, 1, 1],
    [10, null, 90, 9, 8],
    [2, null, 100, 2, 1],
    [1, null, 90, 1, 1],
  ])(
    'gives %i logical / %s performance at %i%% -> %i threads, %i for the diarizer',
    (logical, performance, maxCpuPercent, threads, diarizerThreads) => {
      const budget = resourceBudget({ logical, performance }, { maxCpuPercent });
      expect(budget.threads).toBe(threads);
      expect(budget.diarizerThreads).toBe(diarizerThreads);
    },
  );

  it('never lets the diarizer reach the thread count measured as catastrophic', () => {
    // The whole reason diarizerThreads exists. On this project's reference
    // machine (8 performance cores) the diarizer at 8 threads is slower than
    // at 1; at 6 it is fastest. No percent may produce the bad number.
    for (let percent = 1; percent <= 100; percent += 1) {
      const budget = resourceBudget({ logical: 10, performance: 8 }, { maxCpuPercent: percent });
      expect(budget.diarizerThreads).toBeLessThanOrEqual(6);
      expect(budget.diarizerThreads).toBeGreaterThanOrEqual(1);
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
      diarizerThreads: 6,
      gpu: true,
    });
  });

  it.each([0, 101, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the default percent rather than throwing on %s',
    (maxCpuPercent) => {
      const fallback = resourceBudget({ logical: 8, performance: null });
      expect(
        resourceBudget({ logical: 8, performance: null }, { maxCpuPercent }),
      ).toEqual(fallback);
      expect(DEFAULT_MAX_CPU_PERCENT).toBe(90);
    },
  );

  it('never answers fewer than one thread, whatever it is given', () => {
    // A zero-thread flag would make every engine refuse to start, which is
    // the one outcome a resource hint must never cause.
    expect(resourceBudget({ logical: 0, performance: 0 }, { maxCpuPercent: 1 }).threads).toBe(1);
    expect(
      resourceBudget({ logical: 0, performance: 0 }, { maxCpuPercent: 1 }).diarizerThreads,
    ).toBe(1);
  });

  it('carries the gpu flag through, defaulting to on', () => {
    expect(resourceBudget({ logical: 8, performance: null }).gpu).toBe(true);
    expect(resourceBudget({ logical: 8, performance: null }, { gpu: false }).gpu).toBe(false);
  });
});
