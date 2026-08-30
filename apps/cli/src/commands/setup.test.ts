import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, Remedy } from '@laud/core';
import { EnvironmentError, VAD_MODEL, findModel } from '@laud/core';
import {
  chooseModel,
  describeAction,
  describePlan,
  formatBytes,
  isInteractive,
  requireConsent,
  resolveModelName,
  runProvisioning,
} from './setup.js';
import type { LaudConfig, LaudPaths } from '../config.js';
import type { CliContext } from '../wiring.js';
import { context } from './testContext.js';

describe('isInteractive', () => {
  it('is false under CI even with a real tty', () => {
    expect(isInteractive({ CI: '1' }, true)).toBe(false);
  });

  it('is false with no CI var but no tty either', () => {
    expect(isInteractive({}, false)).toBe(false);
  });

  it('is true with a tty and no CI var', () => {
    expect(isInteractive({}, true)).toBe(true);
  });

  it('treats an empty CI value as "not set"', () => {
    expect(isInteractive({ CI: '' }, true)).toBe(true);
  });

  it('treats CI=0 as "not CI", per the ci-info/is-ci convention', () => {
    expect(isInteractive({ CI: '0' }, true)).toBe(true);
  });

  it('treats CI=false as "not CI", per the ci-info/is-ci convention', () => {
    expect(isInteractive({ CI: 'false' }, true)).toBe(true);
  });
});

describe('resolveModelName', () => {
  it('uses --model when given', async () => {
    expect(await resolveModelName({ model: 'tiny', interactive: false })).toBe('tiny');
  });

  it('defaults to small when non-interactive and no --model', async () => {
    expect(await resolveModelName({ interactive: false })).toBe('small');
  });

  it('rejects an unknown --model by name', async () => {
    await expect(resolveModelName({ model: 'huge', interactive: false })).rejects.toThrow(/huge/);
  });

  it('prompts when interactive and no --model, returning the picked value', async () => {
    const selectImpl = vi.fn().mockResolvedValue('medium');
    expect(await resolveModelName({ interactive: true, selectImpl })).toBe('medium');
    expect(selectImpl).toHaveBeenCalledOnce();
  });

  it('names the invoking command, not "setup", when the model prompt is cancelled', async () => {
    // Same drift risk as requireConsent above: this message is reachable
    // from `doctor --fix` too (a machine missing only the model, prompted
    // interactively, then cancelled), and must not default to naming the
    // other caller. isCancel is mocked module-wide (see the vi.mock calls
    // below); mockReturnValueOnce reverts to its normal "false" after this
    // one call, so it cannot leak into any other test in this file.
    clack.isCancel.mockReturnValueOnce(true);
    const selectImpl = vi.fn().mockResolvedValue('medium');
    await expect(
      resolveModelName({ interactive: true, selectImpl, commandName: 'doctor' }),
    ).rejects.toThrow(/doctor cancelled/);
  });
});

describe('chooseModel', () => {
  it('does not prompt when no remedy needs a transcription model download', async () => {
    const selectImpl = vi.fn().mockResolvedValue('medium');
    const name = await chooseModel({
      remedies: [{ kind: 'install-ffmpeg' }],
      interactive: true,
      selectImpl,
    });
    expect(name).toBe('small');
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('does not prompt for the vad model slot either', async () => {
    const selectImpl = vi.fn().mockResolvedValue('medium');
    const name = await chooseModel({
      remedies: [{ kind: 'download-model', slot: 'vad' }],
      interactive: true,
      selectImpl,
    });
    expect(name).toBe('small');
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('prompts when a transcription-model download is in the plan', async () => {
    const selectImpl = vi.fn().mockResolvedValue('medium');
    const name = await chooseModel({
      remedies: [{ kind: 'download-model', slot: 'transcription' }],
      interactive: true,
      selectImpl,
    });
    expect(name).toBe('medium');
    expect(selectImpl).toHaveBeenCalledOnce();
  });

  it('still honors an explicit --model without prompting', async () => {
    const selectImpl = vi.fn().mockResolvedValue('medium');
    const name = await chooseModel({
      model: 'tiny',
      remedies: [{ kind: 'download-model', slot: 'transcription' }],
      interactive: true,
      selectImpl,
    });
    expect(name).toBe('tiny');
    expect(selectImpl).not.toHaveBeenCalled();
  });
});

describe('requireConsent', () => {
  it('passes when --yes is given, without prompting', async () => {
    let prompted = false;
    const confirmImpl = async (): Promise<boolean> => {
      prompted = true;
      return true;
    };
    expect(await requireConsent({ yes: true, interactive: true, confirmImpl })).toBe(true);
    expect(prompted).toBe(false);
  });

  it('refuses non-interactively without --yes rather than hanging', async () => {
    await expect(requireConsent({ yes: false, interactive: false })).rejects.toThrow(/--yes/);
  });

  it('defaults the guard message to "setup" when no commandName is given', async () => {
    await expect(requireConsent({ yes: false, interactive: false })).rejects.toThrow(
      /laud setup needs confirmation/,
    );
  });

  it('names the invoking command, not "setup", when doctor --fix is the caller', async () => {
    // This is the exact bug the shared-engine design exists to prevent, just
    // in the copy rather than the logic: `doctor --fix` and `setup` share
    // this one guard, so a CI job running `doctor --fix` must not be told
    // that `setup` needs confirmation -- a command it never ran.
    await expect(
      requireConsent({ yes: false, interactive: false, commandName: 'doctor' }),
    ).rejects.toThrow(/laud doctor needs confirmation/);
  });

  it('asks when interactive and returns the answer', async () => {
    const confirmImpl = async (): Promise<boolean> => false;
    expect(await requireConsent({ yes: false, interactive: true, confirmImpl })).toBe(false);
  });
});

describe('formatBytes', () => {
  it('renders sub-GB sizes in MB', () => {
    expect(formatBytes(147_951_465)).toBe('148 MB');
  });

  it('renders GB-and-up sizes in GB with one decimal', () => {
    expect(formatBytes(1_533_763_059)).toBe('1.5 GB');
  });
});

describe('describeAction / describePlan', () => {
  const smallModel = findModel('small')!;

  it('describes every action kind on its own line', () => {
    const actions: readonly Action[] = [
      { kind: 'create-directory', path: '/data/media' },
      { kind: 'install-ffmpeg' },
      { kind: 'install-whisper' },
      { kind: 'download-model', slot: 'transcription', model: smallModel },
      { kind: 'download-model', slot: 'vad', model: VAD_MODEL },
    ];
    expect(actions.map(describeAction)).toEqual([
      'Create directory /data/media',
      'Install ffmpeg',
      'Install whisper.cpp',
      `Download the small transcription model (${formatBytes(smallModel.bytes)})`,
      `Download the silero-v5.1.2 vad model (${formatBytes(VAD_MODEL.bytes)})`,
    ]);
  });

  it('appends the total download size as the last line', () => {
    const actions: readonly Action[] = [
      { kind: 'install-ffmpeg' },
      { kind: 'download-model', slot: 'transcription', model: smallModel },
    ];
    const lines = describePlan(actions);
    expect(lines.at(-1)).toBe(`Total download: ${formatBytes(smallModel.bytes)}`);
    expect(lines).toHaveLength(3);
  });

  it('reports a total of 0 bytes when nothing downloads', () => {
    const lines = describePlan([{ kind: 'install-ffmpeg' }]);
    expect(lines.at(-1)).toBe('Total download: 0 MB');
  });
});

// executePlan outcome accounting -- mocked providers, no real download,
// package-manager invocation, or network request. Only create-directory
// touches real disk, and only under a throwaway temp directory.
//
// `run` is also mocked here (rather than left real): runProvisioning's
// integration tests below drive the real `runChecks` from doctor.ts, which
// calls `run()` for every binary check (ffmpeg, ffprobe, whisper, vad). A
// real spawn would make those tests depend on what happens to be on the
// machine's PATH; the config-driven checks (model, vad model) are the ones
// those tests actually care about; the binary checks are held fixed at "ok".
const providers = vi.hoisted(() => ({
  detectPackageManager: vi.fn(),
  ffmpegInstallCommand: vi.fn(),
  installWhisper: vi.fn(),
  downloadFile: vi.fn(),
  runInteractive: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@laud/providers', () => providers);

// Mocked so runProvisioning's consent test can control the answer and count
// the calls without a real terminal. Every other test in this file passes
// an explicit confirmImpl/selectImpl override, which takes precedence over
// this mock, so it does not change their behavior.
const clack = vi.hoisted(() => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  select: vi.fn(),
}));

vi.mock('@clack/prompts', () => clack);

const { executePlan } = await import('../provisionRunner.js');

describe('executePlan', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'laud-setup-test-'));
    for (const fn of Object.values(providers)) fn.mockReset();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function deps(interactive: boolean): {
    platform: NodeJS.Platform;
    arch: string;
    dataDir: string;
    interactive: boolean;
    onStep: (message: string) => void;
    steps: string[];
  } {
    const steps: string[] = [];
    return {
      platform: 'linux',
      arch: 'x64',
      dataDir,
      interactive,
      onStep: (message: string) => steps.push(message),
      steps,
    };
  }

  it('creates the directory a create-directory action names', async () => {
    const target = join(dataDir, 'media');
    const result = await executePlan([{ kind: 'create-directory', path: target }], deps(true));
    expect(result.outcomes).toEqual([
      { action: { kind: 'create-directory', path: target }, ok: true, detail: `created ${target}` },
    ]);
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it('reports install-ffmpeg as failed, without running anything, when no package manager is found', async () => {
    providers.detectPackageManager.mockResolvedValue(null);
    const result = await executePlan([{ kind: 'install-ffmpeg' }], deps(true));
    expect(result.outcomes[0]!.ok).toBe(false);
    expect(result.outcomes[0]!.detail).toMatch(/no supported package manager/);
    expect(providers.runInteractive).not.toHaveBeenCalled();
  });

  it('skips a sudo-needing ffmpeg install non-interactively instead of running it', async () => {
    providers.detectPackageManager.mockResolvedValue('apt-get');
    providers.ffmpegInstallCommand.mockReturnValue({
      command: 'sudo',
      args: ['apt-get', 'install', '-y', 'ffmpeg'],
      needsSudo: true,
    });
    const result = await executePlan([{ kind: 'install-ffmpeg' }], deps(false));
    expect(result.outcomes[0]!.ok).toBe(false);
    expect(result.outcomes[0]!.detail).toMatch(/sudo apt-get install -y ffmpeg/);
    expect(providers.runInteractive).not.toHaveBeenCalled();
  });

  it('runs a non-sudo ffmpeg install and reports success', async () => {
    providers.detectPackageManager.mockResolvedValue('brew');
    providers.ffmpegInstallCommand.mockReturnValue({
      command: 'brew',
      args: ['install', 'ffmpeg'],
      needsSudo: false,
    });
    providers.runInteractive.mockResolvedValue(0);
    const result = await executePlan([{ kind: 'install-ffmpeg' }], deps(false));
    expect(result.outcomes[0]).toEqual({
      action: { kind: 'install-ffmpeg' },
      ok: true,
      detail: 'ffmpeg installed',
    });
  });

  it('collects the whisper binary paths into config updates when installWhisper returns them', async () => {
    providers.installWhisper.mockResolvedValue({
      binary: '/data/whisper/whisper-cli',
      vadBinary: '/data/whisper/whisper-vad-speech-segments',
    });
    const result = await executePlan([{ kind: 'install-whisper' }], deps(true));
    expect(result.outcomes[0]!.ok).toBe(true);
    expect(result.updates).toEqual({
      binary: '/data/whisper/whisper-cli',
      vadBinary: '/data/whisper/whisper-vad-speech-segments',
    });
  });

  it('leaves config updates empty when installWhisper returns null (already on PATH)', async () => {
    providers.installWhisper.mockResolvedValue(null);
    const result = await executePlan([{ kind: 'install-whisper' }], deps(true));
    expect(result.outcomes[0]).toEqual({
      action: { kind: 'install-whisper' },
      ok: true,
      detail: 'installed on PATH',
    });
    expect(result.updates).toEqual({});
  });

  it('records the downloaded model path under the right config key per slot', async () => {
    providers.downloadFile.mockResolvedValue(undefined);
    const model = findModel('small')!;
    const result = await executePlan(
      [
        { kind: 'download-model', slot: 'transcription', model },
        { kind: 'download-model', slot: 'vad', model: VAD_MODEL },
      ],
      deps(true),
    );
    expect(result.outcomes.every((o) => o.ok)).toBe(true);
    expect(result.updates).toEqual({
      model: join(dataDir, 'models', model.file),
      vadModel: join(dataDir, 'models', VAD_MODEL.file),
    });
  });

  it('does not let one failing action abandon the rest of the plan', async () => {
    providers.detectPackageManager.mockResolvedValue(null); // install-ffmpeg fails
    providers.downloadFile.mockResolvedValue(undefined); // download-model succeeds
    const model = findModel('small')!;
    const result = await executePlan(
      [{ kind: 'install-ffmpeg' }, { kind: 'download-model', slot: 'transcription', model }],
      deps(true),
    );
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]!.ok).toBe(false);
    expect(result.outcomes[1]!.ok).toBe(true);
    expect(result.updates).toEqual({ model: join(dataDir, 'models', model.file) });
  });

  it('catches a thrown error from a provider call as a failed outcome, not a rejection', async () => {
    providers.installWhisper.mockRejectedValue(new Error('tar exited with code 1'));
    const result = await executePlan([{ kind: 'install-whisper' }], deps(true));
    expect(result.outcomes[0]).toEqual({
      action: { kind: 'install-whisper' },
      ok: false,
      detail: 'tar exited with code 1',
    });
  });
});

// runProvisioning integration tests -- these drive the real executePlan,
// writeConfigUpdates, and runChecks (only @laud/providers and @clack/prompts
// are mocked, per the module-level vi.mock calls above). They exist because
// every other test in this file targets a sub-function in isolation, which
// is exactly how the previous bug survived: runChecks re-reading the config
// context.config was built from at process startup, so a fully successful
// setup still failed its own final check. Only a test that actually calls
// runProvisioning and lets it write to and re-read a real config file can
// catch that.
describe('runProvisioning', () => {
  let tmp: string;
  let paths: LaudPaths;

  const badConfig: LaudConfig = {
    stt: {
      provider: 'whisper-cpp',
      whisperCpp: {
        binary: 'whisper-cli',
        model: null,
        vadBinary: 'whisper-vad-speech-segments',
        vadModel: null,
      },
    },
  };

  function provisioningContext(config: LaudConfig): CliContext & { lines: string[] } {
    // Reuses testContext.ts's fakes for everything runChecks/runProvisioning
    // do not care about here (store, fs, audio, clock, ids), but points
    // `paths` at a real throwaway directory: checkModel, checkVadModel, and
    // checkMediaRoot all call node:fs directly, so they need real files to
    // see real state changes.
    return { ...context(), paths, config };
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'laud-provisioning-test-'));
    paths = {
      configFile: join(tmp, 'config.yaml'),
      dataDir: join(tmp, 'data'),
      dbFile: join(tmp, 'data', 'laud.db'),
      mediaRoot: join(tmp, 'data', 'media'),
    };
    await mkdir(paths.mediaRoot, { recursive: true });
    for (const fn of Object.values(providers)) fn.mockReset();
    for (const fn of Object.values(clack)) fn.mockReset();
    clack.isCancel.mockReturnValue(false);
    // Held fixed at "ok": these tests are about the model/config checks,
    // not about whether ffmpeg or whisper-cli happen to be on this machine.
    providers.run.mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('exits without throwing when every action succeeds and the config file ends up healthy (regression test for the stale-config bug)', async () => {
    providers.downloadFile.mockImplementation(async (_url: string, target: string) => {
      // Stands in for the real download: writes something checkModel and
      // checkVadModel can find on disk at the path the action will record.
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'dummy-model-bytes');
    });
    const ctx = provisioningContext(badConfig);
    const remedies: readonly Remedy[] = [
      { kind: 'download-model', slot: 'transcription' },
      { kind: 'download-model', slot: 'vad' },
    ];

    await expect(runProvisioning(ctx, { yes: true }, remedies, 'linux')).resolves.toBeUndefined();

    const written = await readFile(paths.configFile, 'utf8');
    expect(written).toMatch(/model:/);
  });

  it('still writes the config updates that did succeed, still re-checks, and still throws on a partial failure', async () => {
    providers.downloadFile.mockImplementation(async (_url: string, target: string) => {
      if (target.includes('silero')) throw new Error('network down');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'dummy-model-bytes');
    });
    const ctx = provisioningContext(badConfig);
    const remedies: readonly Remedy[] = [
      { kind: 'download-model', slot: 'transcription' },
      { kind: 'download-model', slot: 'vad' },
    ];

    await expect(runProvisioning(ctx, { yes: true }, remedies, 'linux')).rejects.toThrow(
      EnvironmentError,
    );

    // The transcription model succeeded and must be on disk in the config
    // even though the run, as a whole, still failed.
    const written = await readFile(paths.configFile, 'utf8');
    expect(written).toMatch(/model:/);
    expect(written).not.toMatch(/vadModel:/);
  });

  it('prompts nothing, writes nothing, and returns cleanly on an already-healthy machine', async () => {
    // Healthy means the caller (registerSetup, filtering doctor's checks)
    // found nothing to fix, i.e. passed no remedies -- so context()'s
    // already-configured default config is used as-is here.
    const ctx = provisioningContext(context().config);

    await expect(runProvisioning(ctx, {}, [], 'linux')).resolves.toBeUndefined();

    expect(clack.confirm).not.toHaveBeenCalled();
    expect(providers.downloadFile).not.toHaveBeenCalled();
    expect(providers.installWhisper).not.toHaveBeenCalled();
    await expect(stat(paths.configFile)).rejects.toThrow();
    expect(ctx.lines.at(-1)).toBe('Everything laud needs is already in place.');
  });

  it('asks for consent exactly once, before any action runs, and only proceeds once it is given', async () => {
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const originalCi = process.env['CI'];
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    delete process.env['CI'];
    try {
      const order: string[] = [];
      // Interactive and a transcription-model download is in the plan, so
      // chooseModel opens the model picker before consent is asked at all;
      // give it an answer so that prompt does not block the one under test.
      clack.select.mockResolvedValue('small');
      clack.confirm.mockImplementation(async () => {
        order.push('consent');
        return true;
      });
      providers.downloadFile.mockImplementation(async (_url: string, target: string) => {
        order.push('action');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'dummy-model-bytes');
      });
      const ctx = provisioningContext(badConfig);
      const remedies: readonly Remedy[] = [{ kind: 'download-model', slot: 'transcription' }];

      // The final re-check still fails here (the vad model is untouched by
      // this remedy list), which is not what this test is about: it only
      // cares about the consent/action ordering and call count, so a
      // trailing EnvironmentError from that re-check is expected and ignored.
      await runProvisioning(ctx, {}, remedies, 'linux').catch(() => {});

      expect(clack.confirm).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['consent', 'action']);
    } finally {
      if (isTtyDescriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdin, 'isTTY', isTtyDescriptor);
      if (originalCi === undefined) delete process.env['CI'];
      else process.env['CI'] = originalCi;
    }
  });
});
