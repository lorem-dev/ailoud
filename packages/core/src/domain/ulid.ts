const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Encode a ULID from a millisecond timestamp and 10 bytes of randomness. */
export function encodeUlid(timestampMs: number, randomness: Uint8Array): string {
  if (randomness.length !== 10) {
    throw new Error(`ULID randomness must be 10 bytes, got ${randomness.length}`);
  }

  let time = '';
  let remaining = timestampMs;
  for (let i = 0; i < 10; i += 1) {
    time = `${ALPHABET[remaining % 32]}${time}`;
    remaining = Math.floor(remaining / 32);
  }

  // 10 bytes -> 80 bits -> 16 base32 characters, read most significant first.
  let bits = 0n;
  for (const byte of randomness) {
    bits = (bits << 8n) | BigInt(byte);
  }
  let random = '';
  for (let i = 0; i < 16; i += 1) {
    random = `${ALPHABET[Number(bits & 31n)]}${random}`;
    bits >>= 5n;
  }

  return `${time}${random}`;
}
