import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { EnvironmentError, UsageError, planProvisioning } from '@laud/core';
import { buildProgram, exitCodeFor } from '../program.js';
import { parseConfig } from '../config.js';
import { blocksReadiness } from './setup.js';
import type { CliContext } from '../wiring.js';
import { context } from './testContext.js';
import {
  checkBinary,
  checkDiarizerBinary,
  checkEmbeddingModel,
  checkLanguageModel,
  checkModel,
  checkSegmentationModel,
  checkVadBinary,
  checkVadModel,
  registerDoctor,
  runChecks,
} from './doctor.js';
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

  // --multilingual is opt-in exactly the way --diarize is (see the module
  // comment on checkVadModel), so every branch must carry `optional: true`
  // the same way checkSegmentationModel/checkEmbeddingModel do -- passing,
  // "not configured", and "missing" alike.
  it('is optional on every branch: passing, not configured, and missing', async () => {
    const passing = await checkVadModel('/c', process.execPath);
    const notConfigured = await checkVadModel('/c', null);
    const missing = await checkVadModel('/c', join(dir, 'no-such-vad-model.bin'));
    expect(passing.optional).toBe(true);
    expect(notConfigured.optional).toBe(true);
    expect(missing.optional).toBe(true);
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

  // Mirrors checkVadModel's optional-on-every-branch test: the
  // configured-path-missing branch never reaches checkBinary, so it needs
  // its own assertion rather than relying on the passing-binary case below.
  it('is optional on every branch: passing, not on PATH, and configured path missing', async () => {
    const passing = await checkVadBinary('/c', process.execPath);
    const notOnPath = await checkVadBinary('/c', 'laud-doctor-test-no-such-binary');
    const missingPath = await checkVadBinary('/c', join(dir, 'no-such-vad-binary'));
    expect(passing.optional).toBe(true);
    expect(notOnPath.optional).toBe(true);
    expect(missingPath.optional).toBe(true);
  });
});

describe('checkSegmentationModel', () => {
  it('reports "not configured" when the config key is null', async () => {
    const check = await checkSegmentationModel('/c', null);
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('not configured');
    expect(check.fix).toContain('stt.diarization.segmentationModel');
  });

  it('reports the missing-file message when the configured path does not exist', async () => {
    const missing = join(dir, 'no-such-segmentation-model.onnx');
    const check = await checkSegmentationModel('/c', missing);
    expect(check.ok).toBe(false);
    expect(check.detail).toBe(`missing: ${missing}`);
  });

  it('passes when the configured path exists', async () => {
    const check = await checkSegmentationModel('/c', process.execPath);
    expect(check.ok).toBe(true);
    expect(check.detail).toBe(process.execPath);
  });
});

describe('checkEmbeddingModel', () => {
  it('reports "not configured" when the config key is null', async () => {
    const check = await checkEmbeddingModel('/c', null);
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('not configured');
    expect(check.fix).toContain('stt.diarization.embeddingModel');
  });

  it('reports the missing-file message when the configured path does not exist', async () => {
    const missing = join(dir, 'no-such-embedding-model.onnx');
    const check = await checkEmbeddingModel('/c', missing);
    expect(check.ok).toBe(false);
    expect(check.detail).toBe(`missing: ${missing}`);
  });
});

describe('doctor accepts every language-model choice setup can make', () => {
  // The requirement in one place: whichever engine someone picks -- and
  // "none yet" is one of them -- doctor reports its state but never fails
  // over it. Held today by `optional: true` on each branch and by the runner
  // check being conditional; asserted here so neither can be dropped
  // silently.
  const providers = ['llama-cpp', 'anthropic', 'openai-compatible', 'claude-cli'] as const;

  for (const provider of providers) {
    it(`stays ready with ${provider} unconfigured`, async () => {
      const ctx = context();
      const checks = await runChecks(
        { ...ctx, config: { ...ctx.config, llm: { ...ctx.config.llm, provider } } },
        'linux',
        {},
      );
      const languageChecks = checks.filter((c) => c.name.startsWith('language '));
      expect(languageChecks.length).toBeGreaterThan(0);
      for (const check of languageChecks) expect(blocksReadiness(check)).toBe(false);
    });
  }
});

describe('checkLanguageModel', () => {
  const llm = (overrides: Record<string, unknown>) =>
    ({ ...parseConfig(null).llm, ...overrides }) as ReturnType<typeof parseConfig>['llm'];

  it('is optional no matter which provider is selected or how it fails', async () => {
    // The point of the whole check: summarize is opt-in, and someone who only
    // transcribes must not carry a red doctor for a feature they never use.
    const providers = ['llama-cpp', 'anthropic', 'openai-compatible', 'claude-cli'] as const;
    for (const provider of providers) {
      const check = await checkLanguageModel(
        '/c',
        llm({
          provider,
          claudeCli: { binary: 'laud-no-such-cli', model: 'sonnet', contextTokens: 1 },
        }),
        {},
        'linux',
      );
      expect(check.optional, provider).toBe(true);
    }
  });

  it('asks for a local model when llama.cpp has none configured', async () => {
    const check = await checkLanguageModel('/c', llm({ provider: 'llama-cpp' }), {}, 'linux');
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('not configured');
    expect(check.fix).toContain('llm.llamaCpp.model');
    expect(check.remedy).toEqual({ kind: 'download-llm-model' });
  });

  it('reports the missing-file message when the configured GGUF is gone', async () => {
    const missing = join(dir, 'no-such-model.gguf');
    const check = await checkLanguageModel(
      '/c',
      llm({
        provider: 'llama-cpp',
        llamaCpp: { ...parseConfig(null).llm.llamaCpp, binary: process.execPath, model: missing },
      }),
      {},
      'linux',
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toBe(`missing: ${missing}`);
    expect(check.remedy).toEqual({ kind: 'download-llm-model' });
  });

  it('passes when the local runner and the model are both there', async () => {
    const check = await checkLanguageModel(
      '/c',
      llm({
        provider: 'llama-cpp',
        llamaCpp: {
          ...parseConfig(null).llm.llamaCpp,
          binary: process.execPath,
          model: process.execPath,
        },
      }),
      {},
      'linux',
    );
    expect(check.ok).toBe(true);
    expect(check.detail).toContain(process.execPath);
  });

  it('wants a key for a hosted endpoint, and says keys never live in the config file', async () => {
    const check = await checkLanguageModel('/c', llm({ provider: 'anthropic' }), {}, 'linux');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('no API key');
    expect(check.fix).toContain('ANTHROPIC_API_KEY');
    expect(check.fix).toMatch(/never from \/c/);
  });

  it('accepts either the shared variable or the vendor one', async () => {
    const shared = await checkLanguageModel(
      '/c',
      llm({ provider: 'anthropic' }),
      { LAUD_LLM_API_KEY: 'k' },
      'linux',
    );
    expect(shared.ok).toBe(true);
    const vendor = await checkLanguageModel(
      '/c',
      llm({ provider: 'openai-compatible' }),
      { OPENAI_API_KEY: 'k' },
      'linux',
    );
    expect(vendor.ok).toBe(true);
  });

  it('does not report the key as set when the variable is empty', async () => {
    // An exported-but-blank variable is the classic half-configured shell,
    // and calling it "key set" would send the user looking somewhere else.
    const check = await checkLanguageModel(
      '/c',
      llm({ provider: 'anthropic' }),
      { ANTHROPIC_API_KEY: '' },
      'linux',
    );
    expect(check.detail).not.toContain('key set');
  });

  it('does not demand a key from a local OpenAI-compatible server', async () => {
    // Ollama and llama-server want no credential; insisting on one would make
    // doctor wrong for the setup that needs it least.
    const check = await checkLanguageModel(
      '/c',
      llm({
        provider: 'openai-compatible',
        openaiCompatible: {
          ...parseConfig(null).llm.openaiCompatible,
          baseUrl: 'http://localhost:11434/v1',
        },
      }),
      {},
      'linux',
    );
    expect(check.ok).toBe(true);
  });

  it('checks only that the Claude CLI runs, never spending money to verify the subscription', async () => {
    const check = await checkLanguageModel(
      '/c',
      llm({
        provider: 'claude-cli',
        claudeCli: { ...parseConfig(null).llm.claudeCli, binary: process.execPath },
      }),
      {},
      'linux',
    );
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('via subscription');
  });

  it('names the config key to switch away when the Claude CLI is absent', async () => {
    const check = await checkLanguageModel(
      '/c',
      llm({
        provider: 'claude-cli',
        claudeCli: { ...parseConfig(null).llm.claudeCli, binary: 'laud-no-such-claude' },
      }),
      {},
      'linux',
    );
    expect(check.ok).toBe(false);
    expect(check.fix).toContain('llm.provider');
    expect(check.remedy).toEqual({ kind: 'install-llm' });
  });
});

describe('checkDiarizerBinary', () => {
  it('reports "not found on PATH" for a bare binary name that is not installed', async () => {
    const check = await checkDiarizerBinary('/c', 'laud-doctor-test-no-such-binary');
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('not found on PATH');
  });

  it('reports the configured path does not exist when it contains a separator', async () => {
    const missing = join(dir, 'no-such-diarizer-binary');
    const check = await checkDiarizerBinary('/c', missing);
    expect(check.ok).toBe(false);
    expect(check.detail).toBe(`configured path does not exist: ${missing}`);
  });

  it('passes for a real, executable binary', async () => {
    const check = await checkDiarizerBinary('/c', process.execPath);
    expect(check.ok).toBe(true);
  });

  it('sends every platform to "laud setup", never to brew -- sherpa-onnx has no brew route', async () => {
    const missing = join(dir, 'no-such-diarizer-binary');
    const darwin = await checkDiarizerBinary('/c', missing, 'darwin');
    const linux = await checkDiarizerBinary('/c', missing, 'linux');
    expect(darwin.fix).not.toContain('brew');
    expect(darwin.fix).toContain('laud setup');
    expect(linux.fix).toContain('laud setup');
  });

  it('names "laud setup" exactly once on the platforms it applies to', async () => {
    // The fix text used to hardcode the command AND interpolate the hint,
    // which renders as 'run "laud setup" (laud setup)'.
    const missing = join(dir, 'no-such-diarizer-binary');
    const darwin = await checkDiarizerBinary('/c', missing, 'darwin');
    expect(darwin.fix?.match(/laud setup/g)).toHaveLength(1);
  });

  it('never points a win32 user at "laud setup", which refuses Windows', async () => {
    // installHint's own comment: setup refuses to provision Windows, so
    // sending the user there is a circle -- run setup, be told setup cannot
    // help, run doctor, be told to run setup. The Windows route is the
    // manual one, and windowsManualSteps now covers the diarizer.
    const missing = join(dir, 'no-such-diarizer-binary');
    const win32 = await checkDiarizerBinary('/c', missing, 'win32');
    expect(win32.fix).not.toContain('laud setup');
    expect(win32.fix).toContain('install it by hand');
    expect(win32.fix).toContain('README.md');
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

  it('asks for the local runner AND the model, so one setup provisions both', async () => {
    // A single check carries a single remedy, so folding the runner into the
    // model check made setup download two gigabytes and leave no llama-cli to
    // run it -- and never mention the install on the consent screen.
    vi.stubEnv('PATH', '');
    try {
      const checks = await runChecks(context(), 'linux');
      expect(checks.find((c) => c.name === 'language runner')?.remedy).toEqual({
        kind: 'install-llm',
      });
      expect(checks.find((c) => c.name === 'language model')?.remedy).toEqual({
        kind: 'download-llm-model',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not check a local runner a hosted provider will never use', async () => {
    const ctx = context();
    const hosted = {
      ...ctx,
      config: { ...ctx.config, llm: { ...ctx.config.llm, provider: 'anthropic' as const } },
    };
    const checks = await runChecks(hosted, 'linux');
    expect(checks.map((c) => c.name)).not.toContain('language runner');
  });

  it('checks the diarizer binary and both its models, unconditionally, with the right remedies', async () => {
    // testContext.ts's default context() leaves diarization unconfigured
    // (schema defaults), so all three checks fail here and each must carry
    // the remedy that would actually fix it -- the same unconditional shape
    // as the whisper/VAD pair, since setup provisions the full toolkit
    // whether or not --diarize has ever been used.
    vi.stubEnv('PATH', '');
    try {
      const checks = await runChecks(context(), 'linux');
      expect(checks.find((c) => c.name === 'diarizer binary')?.remedy).toEqual({
        kind: 'install-diarizer',
      });
      expect(checks.find((c) => c.name === 'diarization segmentation model')?.remedy).toEqual({
        kind: 'download-diarization-model',
        slot: 'segmentation',
      });
      expect(checks.find((c) => c.name === 'diarization embedding model')?.remedy).toEqual({
        kind: 'download-diarization-model',
        slot: 'embedding',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports the vad binary and vad model as optional, each with the right remedy', async () => {
    // testContext.ts's default context() leaves the VAD pair unconfigured
    // (schema defaults), so both checks fail here -- same shape as the
    // diarizer test above, now that --multilingual gets the same treatment
    // --diarize does.
    vi.stubEnv('PATH', '');
    try {
      const checks = await runChecks(context(), 'linux');
      const vadBinary = checks.find((c) => c.name === 'vad binary');
      const vadModel = checks.find((c) => c.name === 'vad model');
      expect(vadBinary?.optional).toBe(true);
      expect(vadBinary?.remedy).toEqual({ kind: 'install-whisper' });
      expect(vadModel?.optional).toBe(true);
      expect(vadModel?.remedy).toEqual({ kind: 'download-model', slot: 'vad' });
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
    // The diarizer binary and its two models are checked unconditionally now
    // (runChecks), so "every check passes" needs these present too, exactly
    // like the whisper/vad pair above.
    await writeFile(join(scopedDir, 'seg-model.bin'), 'fake segmentation model', 'utf8');
    await writeFile(join(scopedDir, 'emb-model.bin'), 'fake embedding model', 'utf8');
    await writeFile(join(scopedDir, 'llm-model.gguf'), 'fake language model', 'utf8');
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
          diarization: {
            binary: process.execPath,
            segmentationModel: join(scopedDir, 'seg-model.bin'),
            embeddingModel: join(scopedDir, 'emb-model.bin'),
            threshold: 0.6,
            threads: 4,
          },
        },
        llm: {
          ...parseConfig(null).llm,
          llamaCpp: {
            ...parseConfig(null).llm.llamaCpp,
            // Configured like the whisper and diarization models above, so
            // "every check passes" is actually true. Leaving it null made the
            // optional language-model check fail and contribute a remedy,
            // which is correct behaviour and the wrong fixture.
            binary: process.execPath,
            model: join(scopedDir, 'llm-model.gguf'),
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

  it('still plans a failing OPTIONAL check -- setup provisioning the diarizer is the point of collectRemedies not filtering on optional', async () => {
    await writeFakeBinary('ffmpeg');
    await writeFakeBinary('ffprobe');
    vi.stubEnv('PATH', binDir);
    try {
      const unconfiguredDiarizer: CliContext = {
        ...healthyContext(),
        config: {
          ...healthyContext().config,
          stt: {
            ...healthyContext().config.stt,
            diarization: {
              binary: 'sherpa-onnx-offline-speaker-diarization',
              segmentationModel: null,
              embeddingModel: null,
              threshold: 0.6,
              threads: 4,
            },
          },
          llm: parseConfig(null).llm,
        },
      };
      const checks = await runChecks(unconfiguredDiarizer, 'linux');
      const diarizerChecks = checks.filter((c) => c.name.includes('diariz'));
      expect(diarizerChecks.every((c) => c.ok === false && c.optional === true)).toBe(true);
      expect(
        planProvisioning(collectRemedies(checks), { modelName: 'small' }).map((a) => a.kind),
      ).toEqual(expect.arrayContaining(['install-diarizer', 'download-diarization-model']));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/**
 * A machine where absolutely everything is healthy except the diarizer,
 * which was never set up -- the exact "opt-in feature not configured yet"
 * shape `Check.optional` exists for. Drives the real CLI (buildProgram),
 * not runChecks directly, because the defect this guards against is in
 * registerDoctor's own exit-code decision, not in runChecks' output.
 */
describe('doctor: an unconfigured optional feature does not mean "not ready"', () => {
  let dataDir: string;
  let binDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'laud-optional-check-test-'));
    binDir = join(dataDir, 'bin');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(dataDir, 'media'), { recursive: true });
    await writeFile(join(dataDir, 'model.bin'), 'fake model', 'utf8');
    await writeFile(join(dataDir, 'vad-model.bin'), 'fake vad model', 'utf8');
    for (const name of ['ffmpeg', 'ffprobe']) {
      const scriptPath = join(binDir, name);
      await writeFile(scriptPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(scriptPath, 0o755);
    }
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Healthy everywhere except diarization, which is left at its schema defaults (unconfigured). */
  function almostHealthyContext(): CliContext & { lines: string[] } {
    return {
      ...context(),
      paths: {
        configFile: join(dataDir, 'config.yaml'),
        dataDir,
        dbFile: join(dataDir, 'laud.db'),
        mediaRoot: join(dataDir, 'media'),
      },
      config: {
        stt: {
          provider: 'whisper-cpp',
          whisperCpp: {
            binary: process.execPath,
            model: join(dataDir, 'model.bin'),
            vadBinary: process.execPath,
            vadModel: join(dataDir, 'vad-model.bin'),
          },
          diarization: {
            binary: 'sherpa-onnx-offline-speaker-diarization',
            segmentationModel: null,
            embeddingModel: null,
            threshold: 0.6,
            threads: 4,
          },
        },
        llm: parseConfig(null).llm,
      },
    };
  }

  it('doctor exits 0 when only the diarizer (optional) is unconfigured', async () => {
    vi.stubEnv('PATH', binDir);
    try {
      const ctx = almostHealthyContext();
      // No .catch/.rejects wrapper: if registerDoctor threw here (the
      // defect being fixed), this await would reject and fail the test on
      // its own -- the same "resolves cleanly" idiom the rest of this
      // suite uses for a genuinely healthy machine.
      await buildProgram(ctx).parseAsync(['node', 'laud', 'doctor']);
      // The failing checks are still reported -- optional means "not
      // fatal", not "hidden".
      expect(ctx.lines.some((line) => line.includes('diarizer binary'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('doctor still exits 3 when a non-optional check fails, even with the diarizer unconfigured too', async () => {
    // No PATH stub here -- binDir is never added, so ffmpeg/ffprobe (both
    // mandatory) fail alongside the still-unconfigured (optional) diarizer.
    // A single failing mandatory check must still be fatal.
    vi.stubEnv('PATH', '');
    try {
      const ctx = almostHealthyContext();
      const error: unknown = await buildProgram(ctx)
        .parseAsync(['node', 'laud', 'doctor'])
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(EnvironmentError);
      expect(exitCodeFor(error)).toBe(3);
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
    // Diarizer models, present for the same reason as their whisper/vad
    // counterparts: "everything healthy except the database" now needs the
    // diarizer healthy too, since runChecks checks it unconditionally.
    await writeFile(join(corruptDir, 'seg-model.bin'), 'fake segmentation model', 'utf8');
    await writeFile(join(corruptDir, 'emb-model.bin'), 'fake embedding model', 'utf8');
    await writeFile(join(corruptDir, 'llm-model.gguf'), 'fake language model', 'utf8');
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
          diarization: {
            binary: process.execPath,
            segmentationModel: join(corruptDir, 'seg-model.bin'),
            embeddingModel: join(corruptDir, 'emb-model.bin'),
            threshold: 0.6,
            threads: 4,
          },
        },
        llm: {
          ...parseConfig(null).llm,
          llamaCpp: {
            ...parseConfig(null).llm.llamaCpp,
            // Configured, so the database really is the ONLY failing check.
            // Left null, the optional language-model check contributes a
            // remedy, provisioning finds work to do, and the run stops at the
            // consent prompt before it ever reaches the un-fixable report
            // this describe block is about.
            binary: process.execPath,
            model: join(corruptDir, 'llm-model.gguf'),
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

  it('doctor --fix does not print the failing checks a second time', async () => {
    // `doctor --fix` already rendered the full check list via ui.checks()
    // before reaching runProvisioning; its own unfixable-checks report used
    // to repeat the same "FAILED database -- ..." plus fix line right
    // after. ui.checks renders the status column as "FAIL  " (padded), so
    // a line starting with the literal word "FAILED" can only have come
    // from the second, now-suppressed listing.
    const { lines } = await runCommand(['doctor', '--fix']);
    expect(lines.filter((line) => line.startsWith('FAILED')).length).toBe(0);
    expect(lines.filter((line) => line.includes('Back up')).length).toBe(1);
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

/**
 * The Windows guard lives in runProvisioning (the shared engine) now, not
 * in registerSetup, precisely so `doctor --fix` inherits it too. Before
 * this fix, `laud doctor --fix --yes` on win32 built a plan, took consent,
 * downloaded the transcription model and the VAD model (up to 1.6 GB), and
 * only then failed both installs and exited non-zero. registerDoctor is
 * called directly (not through buildProgram) so `platform` can be pinned to
 * 'win32' without a real Windows box, mirroring the equivalent
 * "laud setup on Windows" test in setup.test.ts.
 */
describe('doctor --fix on Windows', () => {
  it('refuses immediately, downloading nothing and building no plan', async () => {
    const ctx = context();
    const program = new Command();
    program.exitOverride();
    registerDoctor(program, ctx, 'win32');

    const error: unknown = await program
      .parseAsync(['node', 'laud', 'doctor', '--fix', '--yes'])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentError);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/laud doctor cannot provision Windows/);
    const output = ctx.lines.join('\n');
    expect(output).toContain('laud doctor does not provision Windows');
    expect(output).toContain('README.md');
    // Refused before collectRemedies/planProvisioning ever ran: none of the
    // plan-only output (the download total, the exact command lines) appears.
    expect(output).not.toContain('Total download');
    expect(output).not.toContain('Runs:');
  });
});
