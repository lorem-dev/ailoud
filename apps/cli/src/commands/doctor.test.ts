import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkVadBinary, checkVadModel } from './doctor.js';

// A real temporary directory, not a string literal path: this guarantees
// the "missing" paths below genuinely do not exist on disk, rather than
// relying on a made-up path that happens not to collide with anything.
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'laud-doctor-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkVadModel', () => {
  it('reports "not configured" when the config key is null', async () => {
    const check = await checkVadModel('/c', null);
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('not configured');
  });

  it('reports the missing-file message when the configured path does not exist', async () => {
    const missing = join(dir, 'no-such-vad-model.bin');
    const check = await checkVadModel('/c', missing);
    expect(check.ok).toBe(false);
    expect(check.detail).toBe(`missing: ${missing}`);
  });
});

describe('checkVadBinary', () => {
  it('reports "not found on PATH" for a bare binary name that is not installed', async () => {
    const check = await checkVadBinary('/c', 'laud-doctor-test-no-such-binary');
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('not found on PATH');
  });

  it('reports the configured path does not exist when it contains a separator', async () => {
    const missing = join(dir, 'no-such-vad-binary');
    const check = await checkVadBinary('/c', missing);
    expect(check.ok).toBe(false);
    expect(check.detail).toBe(`configured path does not exist: ${missing}`);
  });
});
