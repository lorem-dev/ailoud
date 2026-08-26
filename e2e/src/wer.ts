// Word error rate: the standard measure for comparing a speech-recognition
// hypothesis against a reference transcript.
//
// A model upgrade or a different quantization shifts whisper's output by a
// word here or there, and its punctuation and capitalization are stylistic
// choices that vary between model sizes. None of that is what the
// end-to-end suite is testing -- it is testing whether the right audio
// reached the right model and the result got stored -- so comparison is by
// word error rate against a normalized form, not string equality.
//
// This file has no dependencies and no I/O: it is a pure function, tested
// under Vitest (see wer.test.ts, picked up by the root vitest config)
// exactly like any other unit in this repo, and reused as-is by the Jest
// end-to-end specs in ../tests/pipeline.spec.ts.

/**
 * Lowercases and strips everything outside letters, digits, and spaces,
 * then splits into words. `\p{L}` and `\p{N}` (not `a-z0-9`) so this does
 * not mangle the Russian fixture's Cyrillic text into nothing.
 */
function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** Levenshtein distance between two word arrays. */
function levenshtein(a: readonly string[], b: readonly string[]): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distances: number[][] = [];
  for (let i = 0; i < rows; i += 1) {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    distances.push(row);
  }
  for (let j = 0; j < cols; j += 1) distances[0]![j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        distances[i]![j] = distances[i - 1]![j - 1]!;
      } else {
        distances[i]![j] =
          1 +
          Math.min(
            distances[i - 1]![j]!, // deletion
            distances[i]![j - 1]!, // insertion
            distances[i - 1]![j - 1]!, // substitution
          );
      }
    }
  }
  return distances[a.length]![b.length]!;
}

/**
 * Word error rate of `hypothesis` against `reference`: the Levenshtein
 * distance between their normalized word arrays, divided by the reference
 * word count. 0 is a perfect match; 1 (or more, for a hypothesis much
 * longer than the reference) is as bad as it gets.
 */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalize(reference);
  const hyp = normalize(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return levenshtein(ref, hyp) / ref.length;
}
