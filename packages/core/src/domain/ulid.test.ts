import { describe, expect, it } from 'vitest';
import { encodeUlid } from './ulid.js';

const RANDOM = new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23]);

describe('encodeUlid', () => {
  it('produces 26 Crockford base32 characters', () => {
    const id = encodeUlid(1_700_000_000_000, RANDOM);
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts lexicographically in timestamp order', () => {
    const earlier = encodeUlid(1_700_000_000_000, RANDOM);
    const later = encodeUlid(1_700_000_000_001, RANDOM);
    expect(earlier < later).toBe(true);
  });

  it('is stable for the same inputs', () => {
    expect(encodeUlid(1_700_000_000_000, RANDOM)).toBe(encodeUlid(1_700_000_000_000, RANDOM));
  });

  it('rejects randomness of the wrong length', () => {
    expect(() => encodeUlid(0, new Uint8Array(9))).toThrow(/10 bytes/);
  });
});
