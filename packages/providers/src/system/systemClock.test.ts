import { describe, expect, it } from 'vitest';
import { UlidIds } from './systemClock.js';

describe('UlidIds', () => {
  it('generates 1000 ids that sort in generation order', () => {
    const ids = new UlidIds();
    const generated = Array.from({ length: 1000 }, () => ids.next());
    const sorted = [...generated].sort();
    // Same-millisecond ids must not be inverted by lexicographic sort: the
    // sorted array must equal the generation order, and every id must be
    // distinct (strictly increasing, not merely non-decreasing).
    expect(sorted).toEqual(generated);
    expect(new Set(generated).size).toBe(generated.length);
  });
});
