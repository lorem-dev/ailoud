import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentError, UsageError, planProvisioning } from '@laud/core';
import { buildProgram, exitCodeFor } from '../program.js';
import type { CliContext } from '../wiring.js';
import { context } from './testContext.js';
import { checkBinary, checkModel, checkVadBinary, checkVadModel, runChecks } from './doctor.js';
import { collectRemedies } from './setup.js';

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

/**
 * `doctor --fix` (registerDoctor, apps/cli/src/commands/doctor.ts) builds
 * its remedy list the same way registerSetup does: filter runChecks' output
 * down to the checks that failed, then flatMap their `remedy`. These tests
 * exercise that filter end to end against real checks -- a fake whisper
 * and vad binary (process.execPath, which always exists and exits 0 on
 * --help, so PATH does not matter for those two) plus real files for the
 * model, vad model, and media root -- so that the only check left free to
 * vary is ffmpeg/ffprobe, which runChecks looks up on PATH by literal name
 * rather than through config. planProvisioning is exercised directly
 * (rather than the private remedy-filtering line in doctor.ts) because it
 * is the part both callers share and the part a "--fix installs everything,
 * not just what failed" regression would actually break.
 */
describe('doctor --fix scope: remedies come only from failing checks', () => {
  let scopedDir: string;
  let binDir: string;

  beforeEach(async () => {
    scopedDir = await mkdtemp(join(tmpdir(), 'laud-doctor-fix-test-'));
    binDir = join(scopedDir, 'bin');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(scopedDir, 'media'), { recursive: true });
    await writeFile(join(scopedDir, 'model.bin'), 'fake model', 'utf8');
    await writeFile(join(scopedDir, 'vad-model.bin'), 'fake vad model', 'utf8');
  });

  afterEach(async () => {
    await rm(scopedDir, { recursive: true, force: true });
  });

  /** Writes an executable stand-in for `name` (ffmpeg or ffprobe) that always exits 0. */
  async function writeFakeBinary(name: string): Promise<void> {
    const scriptPath = join(binDir, name);
    await writeFile(scriptPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(scriptPath, 0o755);
  }

  function healthyContext(): CliContext {
    return {
      ...context(),
      paths: {
        configFile: join(scopedDir, 'config.yaml'),
        dataDir: scopedDir,
        dbFile: join(scopedDir, 'laud.db'),
        mediaRoot: join(scopedDir, 'media'),
      },
      config: {
        stt: {
          provider: 'whisper-cpp',
          whisperCpp: {
            binary: process.execPath,
            model: join(scopedDir, 'model.bin'),
            vadBinary: process.execPath,
            vadModel: join(scopedDir, 'vad-model.bin'),
          },
        },
      },
    };
  }

  it('plans nothing when every check passes', async () => {
    await writeFakeBinary('ffmpeg');
    await writeFakeBinary('ffprobe');
    // PATH is set to exactly binDir, not binDir-plus-the-real-PATH: appending
    // the real PATH would let a genuinely installed ffmpeg on this machine
    // paper over a missing fake and make the "missing" half of this pair
    // (below) pass for the wrong reason.
    vi.stubEnv('PATH', binDir);
    try {
      const checks = await runChecks(healthyContext(), 'linux');
      expect(planProvisioning(collectRemedies(checks), { modelName: 'small' })).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('plans only the failing checks, not everything', async () => {
    // ffprobe is present (so its check passes) but ffmpeg is not: only
    // ffmpeg is genuinely missing, the way it would be on a machine where
    // some other tool already pulled in ffprobe as a transitive dependency.
    await writeFakeBinary('ffprobe');
    vi.stubEnv('PATH', binDir);
    try {
      const checks = await runChecks(healthyContext(), 'linux');
      expect(checks.find((c) => c.name === 'ffmpeg')?.ok).toBe(false);
      expect(checks.find((c) => c.name === 'ffprobe')?.ok).toBe(true);
      expect(planProvisioning(collectRemedies(checks), { modelName: 'small' })).toEqual([
        { kind: 'install-ffmpeg' },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/**
 * Drives `doctor --fix` through the real CLI action (registerDoctor, via
 * buildProgram), not just the remedy-filtering line inside it. Every test
 * above this one calls `runChecks`/`planProvisioning` directly and would
 * stay green even if registerDoctor's own call to `runProvisioning` fell
 * back to naming "setup" -- which is exactly what shipped in the first cut
 * of this file: `runProvisioning`'s shared consent guard hard-coded "laud
 * setup needs confirmation", so `laud doctor --fix` in CI reported an error
 * about a command nobody ran. Only a test that goes through the real
 * action, the way a CI job actually invokes it, can catch that.
 */
describe('doctor --fix: the real CLI action', () => {
  it('names doctor, not setup, in the no-terminal consent guard', async () => {
    // context() (testContext.ts) is unconfigured, so at least one check --
    // the media root -- fails and produces a remedy; runProvisioning would
    // otherwise short-circuit with "already in place" before ever reaching
    // the guard this test is about. No TTY is stubbed: the test runner's
    // own process already has none, which is exactly the unattended-CI case
    // this guard exists for.
    const ctx = context();
    const error: unknown = await buildProgram(ctx)
      .parseAsync(['node', 'laud', 'doctor', '--fix'])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/laud doctor needs confirmation/);
    expect(message).not.toMatch(/laud setup/);
  });
});

/**
 * A corrupt database is the one failing check with no remedy: `--fix` never
 * deletes user data, so its repair stays a human's job (design section 3).
 * That made it the state where the three entry points could disagree --
 * `doctor` exited 3 while `doctor --fix` on the identical library printed
 * "Everything laud needs is already in place" and exited 0, and `setup`,
 * which never prints the checks, printed that one false sentence and
 * nothing else. All three must refuse.
 */
describe('a corrupt database: every entry point must refuse', () => {
  let corruptDir: string;
  let binDir: string;

  beforeEach(async () => {
    corruptDir = await mkdtemp(join(tmpdir(), 'laud-corrupt-db-test-'));
    binDir = join(corruptDir, 'bin');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(corruptDir, 'media'), { recursive: true });
    await writeFile(join(corruptDir, 'model.bin'), 'fake model', 'utf8');
    await writeFile(join(corruptDir, 'vad-model.bin'), 'fake vad model', 'utf8');
    for (const name of ['ffmpeg', 'ffprobe']) {
      const scriptPath = join(binDir, name);
      await writeFile(scriptPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(scriptPath, 0o755);
    }
  });

  afterEach(async () => {
    await rm(corruptDir, { recursive: true, force: true });
  });

  /** Everything healthy except the database, which reports itself malformed. */
  function corruptContext(): CliContext & { lines: string[] } {
    const ctx = context();
    // Shadows the prototype method with an own property; the store is
    // otherwise the real in-memory fake.
    Object.defineProperty(ctx.store, 'integrityCheck', {
      value: () => 'malformed database schema',
      configurable: true,
    });
    return {
      ...ctx,
      paths: {
        configFile: join(corruptDir, 'config.yaml'),
        dataDir: corruptDir,
        dbFile: join(corruptDir, 'laud.db'),
        mediaRoot: join(corruptDir, 'media'),
      },
      config: {
        stt: {
          provider: 'whisper-cpp',
          whisperCpp: {
            binary: process.execPath,
            model: join(corruptDir, 'model.bin'),
            vadBinary: process.execPath,
            vadModel: join(corruptDir, 'vad-model.bin'),
          },
        },
      },
    };
  }

  async function runCommand(argv: readonly string[]): Promise<{
    error: unknown;
    lines: readonly string[];
  }> {
    vi.stubEnv('PATH', binDir);
    try {
      const ctx = corruptContext();
      const error: unknown = await buildProgram(ctx)
        .parseAsync(['node', 'laud', ...argv])
        .catch((caught: unknown) => caught);
      return { error, lines: ctx.lines };
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it('doctor exits non-zero', async () => {
    const { error } = await runCommand(['doctor']);
    expect(error).toBeInstanceOf(EnvironmentError);
  });

  it('doctor --fix exits non-zero on the same state, instead of claiming success', async () => {
    const { error, lines } = await runCommand(['doctor', '--fix']);
    expect(error).toBeInstanceOf(EnvironmentError);
    expect(lines.join('\n')).not.toContain('Everything laud needs is already in place.');
  });

  it('setup exits non-zero and names the check it cannot repair, with its fix text', async () => {
    const { error, lines } = await runCommand(['setup']);
    expect(error).toBeInstanceOf(EnvironmentError);
    const output = lines.join('\n');
    expect(output).not.toContain('Everything laud needs is already in place.');
    expect(output).toContain('database');
    expect(output).toContain('Back up');
  });

  it('all three exit with the same code', async () => {
    const codes: number[] = [];
    for (const argv of [['doctor'], ['doctor', '--fix'], ['setup']]) {
      const { error } = await runCommand(argv);
      codes.push(exitCodeFor(error));
    }
    expect(codes).toEqual([3, 3, 3]);
  });
});
