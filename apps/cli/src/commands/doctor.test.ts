import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { context } from './testContext.js';
import { checkBinary, checkModel, checkVadBinary, checkVadModel, runChecks } from './doctor.js';

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

  it('gives different fix text on darwin and linux, and never suggests brew on linux', async () => {
    const missing = join(dir, 'no-such-vad-binary');
    const darwin = await checkVadBinary('/c', missing, 'darwin');
    const linux = await checkVadBinary('/c', missing, 'linux');
    expect(darwin.fix).not.toBe(linux.fix);
    expect(linux.fix).not.toContain('brew');
  });
});

describe('checkBinary', () => {
  it('attaches the given remedy to a failing check', async () => {
    const check = await checkBinary(
      'thing',
      'laud-doctor-test-no-such-binary',
      ['--help'],
      'install it',
      undefined,
      { kind: 'install-ffmpeg' },
    );
    expect(check.ok).toBe(false);
    expect(check.remedy).toEqual({ kind: 'install-ffmpeg' });
  });

  it('attaches no remedy to a passing check', async () => {
    // node is guaranteed present in the test environment and exits 0 on
    // --version, unlike ffmpeg or whisper-cli which this suite cannot
    // assume are installed.
    const check = await checkBinary('node', 'node', ['--version'], 'install it', undefined, {
      kind: 'install-ffmpeg',
    });
    expect(check.ok).toBe(true);
    expect(check.remedy).toBeUndefined();
  });
});

describe('checkModel', () => {
  it('attaches the given remedy to a failing check', async () => {
    const check = await checkModel('/c', null, {
      kind: 'download-model',
      slot: 'transcription',
    });
    expect(check.ok).toBe(false);
    expect(check.remedy).toEqual({ kind: 'download-model', slot: 'transcription' });
  });

  it('attaches no remedy to a passing check', async () => {
    // process.execPath is a real file guaranteed to exist on disk, so the
    // access() check this exercises succeeds without needing a fixture.
    const check = await checkModel('/c', process.execPath, {
      kind: 'download-model',
      slot: 'transcription',
    });
    expect(check.ok).toBe(true);
    expect(check.remedy).toBeUndefined();
  });
});

describe('runChecks', () => {
  it('gives Linux users apt for ffmpeg, and never attaches a remedy to the database check', async () => {
    // Cleared so the ffmpeg check fails deterministically -- otherwise this
    // test's result would depend on whether ffmpeg happens to be installed
    // on the machine running the suite, and the fix text this test reads
    // is only present on a failing check. vi.stubEnv/unstubAllEnvs (rather
    // than a manual save/restore) is what keeps this safe if the file is
    // ever run with concurrent tests.
    vi.stubEnv('PATH', '');
    try {
      const checks = await runChecks(context(), 'linux');
      expect(checks.find((c) => c.name === 'ffmpeg')?.fix).toBe('sudo apt-get install ffmpeg');
      expect(checks.find((c) => c.name === 'database')?.remedy).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
