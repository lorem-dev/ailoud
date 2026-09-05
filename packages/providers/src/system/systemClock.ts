import type { Clock, Ids } from '@ailoud/core';
import { encodeUlid } from '@ailoud/core';

export class SystemClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

const RANDOM_BYTES = 10;

/**
 * Monotonic ULID generator.
 *
 * `encodeUlid(Date.now(), randomBytes)` alone can invert two ids minted in
 * the same millisecond, since they then differ only by independent random
 * draws. This class remembers the last timestamp and random block; when
 * `Date.now()` has not advanced past it, it reuses that millisecond and
 * increments the previous random block as a big-endian integer instead of
 * drawing fresh randomness, so same-millisecond ids still sort in the order
 * they were generated.
 */
export class UlidIds implements Ids {
  private lastTimeMs = -1;
  private lastRandom = new Uint8Array(RANDOM_BYTES);

  next(): string {
    const now = Date.now();
    if (now > this.lastTimeMs) {
      this.lastTimeMs = now;
      this.lastRandom = randomBytes();
    } else {
      incrementBigEndian(this.lastRandom);
    }
    return encodeUlid(this.lastTimeMs, this.lastRandom);
  }
}

// No return-type annotation: `Uint8Array` unparameterized defaults to the
// wider `Uint8Array<ArrayBufferLike>`, whereas the type TypeScript infers
// here from `crypto.getRandomValues(new Uint8Array(n))` is the narrower
// `Uint8Array<ArrayBuffer>` -- annotating this would widen it right back.
function randomBytes() {
  return crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
}

function incrementBigEndian(bytes: ReturnType<typeof randomBytes>): void {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    const value = bytes[i];
    if (value === undefined) continue;
    if (value === 255) {
      bytes[i] = 0;
      continue;
    }
    bytes[i] = value + 1;
    return;
  }
  // All 80 bits wrapped to zero: would need 2**80 ids minted within a single
  // millisecond, which is not reachable in practice.
}
