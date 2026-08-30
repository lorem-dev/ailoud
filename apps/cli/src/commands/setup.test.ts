import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@laud/core';
import {
  EMBEDDING_MODEL,
  EnvironmentError,
  SEGMENTATION_MODEL,
  VAD_MODEL,
  findModel,
} from '@laud/core';
import {
  chooseModel,
  collectRemedies,
  describeAction,
  describePlan,
  formatBytes,
  isInteractive,
  planNeedsPackageManager,
  requireConsent,
  resolveModelName,
  runProvisioning,
  unfixableChecks,
} from './setup.js';
import type { PlanEnvironment } from './setup.js';
import type { PackageManager } from '@laud/providers';
import type { Remedy } from '@laud/core';
import type * as Providers from '@laud/providers';
import type { LaudConfig, LaudPaths } from '../config.js';
import type { CliContext } from '../wiring.js';
import type { Check } from '../ui/index.js';
import { context } from './testContext.js';
import { Command } from 'commander';
import { registerSetup } from './setup.js';

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
      { kind: 'install-diarizer' },
      { kind: 'download-model', slot: 'transcription', model: smallModel },
      { kind: 'download-model', slot: 'vad', model: VAD_MODEL },
      { kind: 'download-diarization-model', slot: 'segmentation', model: SEGMENTATION_MODEL },
      { kind: 'download-diarization-model', slot: 'embedding', model: EMBEDDING_MODEL },
    ];
    expect(actions.map(describeAction)).toEqual([
      'Create directory /data/media',
      'Install ffmpeg',
      'Install whisper.cpp',
      'Install the sherpa-onnx diarizer',
      `Download the small transcription model (${formatBytes(smallModel.bytes)})`,
      `Download the silero-v5.1.2 vad model (${formatBytes(VAD_MODEL.bytes)})`,
      `Download the ${SEGMENTATION_MODEL.name} segmentation model (${formatBytes(SEGMENTATION_MODEL.bytes)})`,
      `Download the ${EMBEDDING_MODEL.name} embedding model (${formatBytes(EMBEDDING_MODEL.bytes)})`,
    ]);
  });

  const apt: PlanEnvironment = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/data',
    manager: 'apt-get',
  };
  const brew: PlanEnvironment = {
    platform: 'darwin',
    arch: 'arm64',
    dataDir: '/data',
    manager: 'brew',
  };

  it('appends the total download size as the last line', () => {
    const actions: readonly Action[] = [
      { kind: 'install-ffmpeg' },
      { kind: 'download-model', slot: 'transcription', model: smallModel },
    ];
    const lines = describePlan(actions, apt);
    expect(lines.at(-1)).toBe(`Total download: ${formatBytes(smallModel.bytes)}`);
  });

  it('reports a total of 0 bytes when nothing downloads', () => {
    const lines = describePlan([{ kind: 'install-ffmpeg' }], apt);
    expect(lines.at(-1)).toBe('Total download: 0 MB');
  });

  it('spells out the sudo commands "Install ffmpeg" stands for, before consent', () => {
    // Design section 5.5: sudo is never invoked silently, and the exact
    // command appears in the plan. "Install ffmpeg" alone told a Debian user
    // nothing about the root password prompt they were agreeing to.
    const lines = describePlan([{ kind: 'install-ffmpeg' }], apt);
    expect(lines).toContain('Install ffmpeg');
    expect(lines).toContain('  Runs: sudo apt-get update');
    expect(lines).toContain('  Runs: sudo apt-get install -y ffmpeg');
  });

  it('spells out brew install ffmpeg on macOS', () => {
    expect(describePlan([{ kind: 'install-ffmpeg' }], brew)).toContain(
      '  Runs: brew install ffmpeg',
    );
  });

  it('spells out brew install whisper-cpp on macOS', () => {
    expect(describePlan([{ kind: 'install-whisper' }], brew)).toContain(
      '  Runs: brew install whisper-cpp',
    );
  });

  it('names the tarball and where it lands for the Linux whisper route', () => {
    const lines = describePlan([{ kind: 'install-whisper' }], apt);
    expect(lines.some((line) => line.includes('whisper-bin-ubuntu-x64.tar.gz'))).toBe(true);
    expect(lines.some((line) => line.includes(join('/data', 'whisper')))).toBe(true);
  });

  it('says so in the plan when no package manager was found, rather than at execution time', () => {
    const lines = describePlan([{ kind: 'install-ffmpeg' }], { ...apt, manager: null });
    expect(lines.some((line) => line.includes('No supported package manager'))).toBe(true);
  });

  it('reports an unsupported CPU architecture as a plan line, not by throwing', () => {
    const lines = describePlan([{ kind: 'install-whisper' }], { ...apt, arch: 'ia32' });
    expect(lines.some((line) => line.includes('ia32'))).toBe(true);
  });

  it('names the sherpa-onnx tarball and where it lands, on both supported platforms', () => {
    const linuxLines = describePlan([{ kind: 'install-diarizer' }], apt);
    expect(
      linuxLines.some((line) => line.includes('sherpa-onnx') && line.includes('.tar.bz2')),
    ).toBe(true);
    expect(linuxLines.some((line) => line.includes(join('/data', 'sherpa')))).toBe(true);

    const macLines = describePlan([{ kind: 'install-diarizer' }], brew);
    expect(macLines.some((line) => line.includes('.tar.bz2'))).toBe(true);
    // No brew route exists for the diarizer -- unlike install-whisper on
    // macOS above, this must never claim to run brew.
    expect(macLines.some((line) => line.includes('brew'))).toBe(false);
  });

  it('reports an unsupported diarizer platform/CPU as a plan line, not by throwing', () => {
    const lines = describePlan([{ kind: 'install-diarizer' }], { ...apt, arch: 'ia32' });
    expect(lines.some((line) => line.includes('ia32'))).toBe(true);
  });

  it('shows no commands under a diarization model download, matching download-model', () => {
    expect(
      describePlan(
        [{ kind: 'download-diarization-model', slot: 'embedding', model: EMBEDDING_MODEL }],
        apt,
      ),
    ).toEqual([
      `Download the ${EMBEDDING_MODEL.name} embedding model (${formatBytes(EMBEDDING_MODEL.bytes)})`,
      `Total download: ${formatBytes(EMBEDDING_MODEL.bytes)}`,
    ]);
  });
});

describe('planNeedsPackageManager', () => {
  it('is true for an ffmpeg install on any platform', () => {
    expect(planNeedsPackageManager([{ kind: 'install-ffmpeg' }], 'linux')).toBe(true);
  });

  it('is true for a whisper install on macOS, where brew does the work', () => {
    expect(planNeedsPackageManager([{ kind: 'install-whisper' }], 'darwin')).toBe(true);
  });

  it('is false for a whisper install on Linux, which uses the release tarball', () => {
    expect(planNeedsPackageManager([{ kind: 'install-whisper' }], 'linux')).toBe(false);
  });

  it('is false for a download-only plan, so no probe runs for nothing', () => {
    const model = findModel('tiny')!;
    expect(
      planNeedsPackageManager([{ kind: 'download-model', slot: 'transcription', model }], 'linux'),
    ).toBe(false);
  });

  it('is false for install-diarizer on every platform -- sherpa-onnx has no package-manager route', () => {
    expect(planNeedsPackageManager([{ kind: 'install-diarizer' }], 'linux')).toBe(false);
    expect(planNeedsPackageManager([{ kind: 'install-diarizer' }], 'darwin')).toBe(false);
  });
});

describe('collectRemedies / unfixableChecks', () => {
  const checks: readonly Check[] = [
    { name: 'ffmpeg', ok: true, detail: 'fine' },
    { name: 'ffprobe', ok: false, detail: 'gone', remedy: { kind: 'install-ffmpeg' } },
    { name: 'database', ok: false, detail: 'integrity_check: corrupt', fix: 'Back it up.' },
  ];

  it('takes remedies only from the checks that failed', () => {
    expect(collectRemedies(checks)).toEqual([{ kind: 'install-ffmpeg' }]);
  });

  it('separates out the failing checks that carry no remedy', () => {
    expect(unfixableChecks(checks).map((c) => c.name)).toEqual(['database']);
  });

  it('counts a passing check with no remedy as neither', () => {
    const passing: readonly Check[] = [{ name: 'config file', ok: true, detail: 'present' }];
    expect(collectRemedies(passing)).toEqual([]);
    expect(unfixableChecks(passing)).toEqual([]);
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
  installWhisper: vi.fn(),
  installSherpa: vi.fn(),
  downloadFile: vi.fn(),
  runInteractive: vi.fn(),
  run: vi.fn(),
}));

// Only the I/O is faked. The command builders (ffmpegInstallCommands,
// whisperInstallCommands, formatInstallCommand, whisperTarballUrl) stay real,
// because the plan text tests below assert on the exact command lines a user
// would be shown -- a mocked builder would let those pass while the real
// consent plan said something else entirely.
vi.mock('@laud/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof Providers>()),
  ...providers,
}));

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

  function deps(
    interactive: boolean,
    overrides: {
      platform?: NodeJS.Platform;
      manager?: PackageManager | null;
    } = {},
  ): {
    platform: NodeJS.Platform;
    arch: string;
    dataDir: string;
    manager: PackageManager | null;
    interactive: boolean;
    onStep: (message: string) => void;
    steps: string[];
  } {
    const steps: string[] = [];
    return {
      platform: overrides.platform ?? 'linux',
      arch: 'x64',
      dataDir,
      manager: overrides.manager ?? null,
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

  it('reports the directory as failed, not created, when it exists but is unwritable', async () => {
    // createContext already mkdirs the media root before any command runs,
    // so the only way checkMediaRoot fails is on writability -- where mkdir
    // no-ops and the old code still reported "created <path>".
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const target = join(dataDir, 'readonly');
    await mkdir(target);
    await chmod(target, 0o500);
    try {
      const result = await executePlan([{ kind: 'create-directory', path: target }], deps(true));
      expect(result.outcomes[0]!.ok).toBe(false);
      expect(result.outcomes[0]!.detail).toMatch(/cannot write to it/);
      expect(result.outcomes[0]!.detail).toContain(target);
    } finally {
      await chmod(target, 0o700);
    }
  });

  it('does not claim to have created a directory that was already there', async () => {
    const target = join(dataDir, 'already');
    await mkdir(target);
    const result = await executePlan([{ kind: 'create-directory', path: target }], deps(true));
    expect(result.outcomes[0]!.ok).toBe(true);
    expect(result.outcomes[0]!.detail).not.toMatch(/created/);
  });

  it('reports install-ffmpeg as failed, without running anything, when no package manager is found', async () => {
    const result = await executePlan([{ kind: 'install-ffmpeg' }], deps(true, { manager: null }));
    expect(result.outcomes[0]!.ok).toBe(false);
    expect(result.outcomes[0]!.detail).toMatch(/no supported package manager/);
    expect(providers.runInteractive).not.toHaveBeenCalled();
  });

  it('skips a sudo-needing ffmpeg install non-interactively instead of running it', async () => {
    const result = await executePlan(
      [{ kind: 'install-ffmpeg' }],
      deps(false, { manager: 'apt-get' }),
    );
    expect(result.outcomes[0]!.ok).toBe(false);
    expect(result.outcomes[0]!.detail).toMatch(/sudo apt-get install -y ffmpeg/);
    expect(providers.runInteractive).not.toHaveBeenCalled();
  });

  it('skips even a sudo-free brew install non-interactively, because brew can prompt too', async () => {
    // The guard used to key off needsSudo, which is false for brew -- so a
    // macOS CI job hit `brew install ffmpeg`, brew asked about the Xcode
    // command line tools, and runInteractive (no timeout, by design) waited
    // until the job itself timed out.
    const result = await executePlan(
      [{ kind: 'install-ffmpeg' }],
      deps(false, { platform: 'darwin', manager: 'brew' }),
    );
    expect(result.outcomes[0]!.ok).toBe(false);
    expect(result.outcomes[0]!.detail).toMatch(/brew install ffmpeg/);
    expect(providers.runInteractive).not.toHaveBeenCalled();
  });

  it('refuses the macOS whisper install non-interactively as well', async () => {
    providers.installWhisper.mockResolvedValue({
      kind: 'skipped',
      commands: ['brew install whisper-cpp'],
    });
    const result = await executePlan(
      [{ kind: 'install-whisper' }],
      deps(false, { platform: 'darwin', manager: 'brew' }),
    );
    expect(result.outcomes[0]!.ok).toBe(false);
    expect(result.outcomes[0]!.detail).toMatch(/brew install whisper-cpp/);
    expect(providers.installWhisper).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: false }),
    );
  });

  it('refreshes the apt package lists before installing ffmpeg', async () => {
    // Without it, a container-fresh /var/lib/apt/lists makes apt-get install
    // exit 100 with nothing the user can act on.
    providers.runInteractive.mockResolvedValue(0);
    const d = deps(true, { manager: 'apt-get' });
    const result = await executePlan([{ kind: 'install-ffmpeg' }], d);
    expect(providers.runInteractive.mock.calls.map((call) => call[1])).toEqual([
      ['apt-get', 'update'],
      ['apt-get', 'install', '-y', 'ffmpeg'],
    ]);
    expect(result.outcomes[0]!.ok).toBe(true);
  });

  it('does not let a failing apt-get update block the install that follows', async () => {
    providers.runInteractive.mockResolvedValueOnce(100).mockResolvedValueOnce(0);
    const result = await executePlan(
      [{ kind: 'install-ffmpeg' }],
      deps(true, { manager: 'apt-get' }),
    );
    expect(providers.runInteractive).toHaveBeenCalledTimes(2);
    expect(result.outcomes[0]!.ok).toBe(true);
  });

  it('names the command that failed, not just its exit code', async () => {
    providers.runInteractive.mockResolvedValueOnce(0).mockResolvedValueOnce(100);
    const result = await executePlan(
      [{ kind: 'install-ffmpeg' }],
      deps(true, { manager: 'apt-get' }),
    );
    expect(result.outcomes[0]!.ok).toBe(false);
    expect(result.outcomes[0]!.detail).toBe(
      '"sudo apt-get install -y ffmpeg" exited with code 100',
    );
  });

  it('runs a non-sudo ffmpeg install and reports success', async () => {
    providers.runInteractive.mockResolvedValue(0);
    const result = await executePlan(
      [{ kind: 'install-ffmpeg' }],
      deps(true, { platform: 'darwin', manager: 'brew' }),
    );
    expect(result.outcomes[0]).toEqual({
      action: { kind: 'install-ffmpeg' },
      ok: true,
      detail: 'ffmpeg installed',
    });
  });

  it('collects the whisper binary paths into config updates when installWhisper returns them', async () => {
    providers.installWhisper.mockResolvedValue({
      kind: 'installed',
      paths: {
        binary: '/data/whisper/whisper-cli',
        vadBinary: '/data/whisper/whisper-vad-speech-segments',
      },
    });
    const result = await executePlan([{ kind: 'install-whisper' }], deps(true));
    expect(result.outcomes[0]!.ok).toBe(true);
    expect(result.updates).toEqual({
      binary: '/data/whisper/whisper-cli',
      vadBinary: '/data/whisper/whisper-vad-speech-segments',
    });
  });

  it('leaves config updates empty when whisper landed on PATH', async () => {
    providers.installWhisper.mockResolvedValue({ kind: 'installed', paths: null });
    const result = await executePlan([{ kind: 'install-whisper' }], deps(true));
    expect(result.outcomes[0]).toEqual({
      action: { kind: 'install-whisper' },
      ok: true,
      detail: 'installed on PATH',
    });
    expect(result.updates).toEqual({});
  });

  it('collects the sherpa-onnx binary path into config updates', async () => {
    providers.installSherpa.mockResolvedValue(
      '/data/sherpa/v1.13.6/bin/sherpa-onnx-offline-speaker-diarization',
    );
    const result = await executePlan([{ kind: 'install-diarizer' }], deps(true));
    expect(result.outcomes[0]!.ok).toBe(true);
    expect(result.updates).toEqual({
      diarizerBinary: '/data/sherpa/v1.13.6/bin/sherpa-onnx-offline-speaker-diarization',
    });
  });

  it('installs the diarizer with no terminal, unlike install-ffmpeg and install-whisper', async () => {
    // installSherpa never calls runInteractive (see sherpaInstall.ts: only a
    // download and a non-interactive `tar`), so unlike the two branches
    // above, there is nothing here for `interactive: false` to block.
    providers.installSherpa.mockResolvedValue(
      '/data/sherpa/bin/sherpa-onnx-offline-speaker-diarization',
    );
    const result = await executePlan([{ kind: 'install-diarizer' }], deps(false));
    expect(result.outcomes[0]!.ok).toBe(true);
    expect(providers.installSherpa).toHaveBeenCalledOnce();
    expect(providers.runInteractive).not.toHaveBeenCalled();
  });

  it('catches a thrown error from installSherpa as a failed outcome, not a rejection', async () => {
    providers.installSherpa.mockRejectedValue(
      new Error('no prebuilt sherpa-onnx diarizer is published for macOS x64'),
    );
    const result = await executePlan([{ kind: 'install-diarizer' }], deps(true));
    expect(result.outcomes[0]).toEqual({
      action: { kind: 'install-diarizer' },
      ok: false,
      detail: 'no prebuilt sherpa-onnx diarizer is published for macOS x64',
    });
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

  it('records both diarization model paths under their own config keys, not collapsed together', async () => {
    providers.downloadFile.mockResolvedValue(undefined);
    const result = await executePlan(
      [{ kind: 'download-diarization-model', slot: 'embedding', model: EMBEDDING_MODEL }],
      deps(true),
    );
    expect(result.outcomes[0]!.ok).toBe(true);
    expect(result.updates).toEqual({
      embeddingModel: join(dataDir, 'models', EMBEDDING_MODEL.file),
    });
    // A bare file, like every model above it in this file -- downloadFile is
    // called with the final target directly, not with some intermediate
    // archive path.
    expect(providers.downloadFile).toHaveBeenCalledWith(
      EMBEDDING_MODEL.url,
      join(dataDir, 'models', EMBEDDING_MODEL.file),
      expect.anything(),
    );
  });

  it('extracts the segmentation model out of its archive, discarding the rest of the tarball', async () => {
    // SEGMENTATION_MODEL.url points at a .tar.bz2 (see catalogue.ts); the
    // executor must download the ARCHIVE, run `tar`, then move just the
    // wanted member into place -- never call downloadFile with the final
    // target path directly, which is the bare-file branch's job.
    providers.downloadFile.mockResolvedValue(undefined);
    providers.run.mockImplementation(async (_command: string, args: readonly string[]) => {
      const extractDir = args[3] as string;
      await mkdir(extractDir, { recursive: true });
      await writeFile(join(extractDir, 'model.onnx'), 'fake pyannote segmentation model', 'utf8');
      return { code: 0, stdout: '', stderr: '' };
    });

    const result = await executePlan(
      [{ kind: 'download-diarization-model', slot: 'segmentation', model: SEGMENTATION_MODEL }],
      deps(true),
    );

    expect(result.outcomes[0]!.ok).toBe(true);
    const target = join(dataDir, 'models', SEGMENTATION_MODEL.file);
    expect(result.updates).toEqual({ segmentationModel: target });
    expect(await readFile(target, 'utf8')).toBe('fake pyannote segmentation model');
    // downloadFile's target was the archive, not the final model path.
    expect(providers.downloadFile).toHaveBeenCalledWith(
      SEGMENTATION_MODEL.url,
      `${target}.tar.bz2`,
      expect.anything(),
    );
    expect(providers.run).toHaveBeenCalledWith('tar', [
      '-xjf',
      `${target}.tar.bz2`,
      '-C',
      `${target}.extracted`,
      '--strip-components=1',
    ]);
    // The archive and the scratch extraction directory are both cleaned up
    // -- laud has no use for model.int8.onnx or anything else in there.
    await expect(stat(`${target}.tar.bz2`)).rejects.toThrow();
    await expect(stat(`${target}.extracted`)).rejects.toThrow();
  });

  it('reports a failed tar extraction as a failed outcome, not a rejection', async () => {
    providers.downloadFile.mockResolvedValue(undefined);
    providers.run.mockResolvedValue({ code: 2, stdout: '', stderr: 'bzip2: data error' });
    const result = await executePlan(
      [{ kind: 'download-diarization-model', slot: 'segmentation', model: SEGMENTATION_MODEL }],
      deps(true),
    );
    expect(result.outcomes[0]!.ok).toBe(false);
    expect(result.outcomes[0]!.detail).toMatch(/bzip2: data error/);
  });

  it('does not let one failing action abandon the rest of the plan', async () => {
    // manager: null makes install-ffmpeg fail without spawning anything.
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

  // Diarization is pre-configured and healthy here, deliberately: the final
  // re-check inside runProvisioning runs the REAL runChecks (see the
  // describe-level comment above), which now includes the diarizer binary
  // and its two models unconditionally. This suite's `checks` fixtures only
  // ever carry whisper/vad remedies, so if the diarizer checks were left
  // failing, the "everything succeeded" tests below would start failing
  // their own final check for a reason that has nothing to do with what
  // they exist to test. `process.execPath` stands in for both model paths
  // the same way it stands in for a binary elsewhere in this file: a real
  // file guaranteed to exist, whose content nothing here reads.
  const badConfig: LaudConfig = {
    stt: {
      provider: 'whisper-cpp',
      whisperCpp: {
        binary: 'whisper-cli',
        model: null,
        vadBinary: 'whisper-vad-speech-segments',
        vadModel: null,
      },
      diarization: {
        binary: 'sherpa-onnx-offline-speaker-diarization',
        segmentationModel: process.execPath,
        embeddingModel: process.execPath,
        threshold: 0.6,
      },
    },
  };

  /** A failing check carrying `remedy`, shaped the way runChecks would emit it. */
  function failing(name: string, remedy: Remedy): Check {
    return { name, ok: false, detail: 'missing', fix: `fix ${name} by hand`, remedy };
  }

  function provisioningContext(config: LaudConfig): CliContext & { lines: string[] } {
    // Reuses testContext.ts's fakes for everything runChecks/runProvisioning
    // do not care about here (store, fs, audio, clock, ids), but points
    // `paths` at a real throwaway directory: checkModel, checkVadModel, and
    // checkMediaRoot all call node:fs directly, so they need real files to
    // see real state changes.
    return { ...context(), paths, config };
  }

  /**
   * Writes real diarization paths into the config FILE, not just `badConfig`
   * (the in-memory object). runProvisioning's final re-check re-reads the
   * config from disk (readCurrentConfig), not from the context it was
   * handed, so `badConfig.stt.diarization` alone is invisible to it -- on an
   * empty file, parseConfig's own schema defaults (null paths) would apply
   * instead, and the tests below that call this only care about the
   * whisper/vad stale-config bug, not about provisioning the diarizer too.
   */
  async function seedDiarizationConfig(): Promise<void> {
    await mkdir(dirname(paths.configFile), { recursive: true });
    await writeFile(
      paths.configFile,
      `stt:\n  diarization:\n    segmentationModel: ${process.execPath}\n    embeddingModel: ${process.execPath}\n`,
      'utf8',
    );
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
    await seedDiarizationConfig();
    const ctx = provisioningContext(badConfig);
    const checks: readonly Check[] = [
      failing('whisper model', { kind: 'download-model', slot: 'transcription' }),
      failing('vad model', { kind: 'download-model', slot: 'vad' }),
    ];

    await expect(runProvisioning(ctx, { yes: true }, checks, 'linux')).resolves.toBeUndefined();

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
    const checks: readonly Check[] = [
      failing('whisper model', { kind: 'download-model', slot: 'transcription' }),
      failing('vad model', { kind: 'download-model', slot: 'vad' }),
    ];

    await expect(runProvisioning(ctx, { yes: true }, checks, 'linux')).rejects.toThrow(
      EnvironmentError,
    );

    // The transcription model succeeded and must be on disk in the config
    // even though the run, as a whole, still failed.
    const written = await readFile(paths.configFile, 'utf8');
    expect(written).toMatch(/model:/);
    expect(written).not.toMatch(/vadModel:/);
  });

  it('prompts nothing, writes nothing, and returns cleanly on an already-healthy machine', async () => {
    // Healthy means every check passed -- so context()'s already-configured
    // default config is used as-is here.
    const ctx = provisioningContext(context().config);
    const checks: readonly Check[] = [{ name: 'database', ok: true, detail: 'fine' }];

    await expect(runProvisioning(ctx, {}, checks, 'linux')).resolves.toBeUndefined();

    expect(clack.confirm).not.toHaveBeenCalled();
    expect(providers.downloadFile).not.toHaveBeenCalled();
    expect(providers.installWhisper).not.toHaveBeenCalled();
    await expect(stat(paths.configFile)).rejects.toThrow();
    expect(ctx.lines.at(-1)).toBe('Everything laud needs is already in place.');
  });

  it('refuses, rather than reporting success, when every failing check is un-fixable', async () => {
    // The corrupt-database check deliberately carries no remedy: its repair
    // is "back up, then delete", which is destructive and belongs to a
    // human. That used to reach the same "Everything laud needs is already
    // in place" as a genuinely healthy machine, so `doctor --fix` exited 0
    // on a library `doctor` had just exited 3 over.
    const ctx = provisioningContext(context().config);
    const checks: readonly Check[] = [
      { name: 'ffmpeg', ok: true, detail: 'ffmpeg version 7' },
      {
        name: 'database',
        ok: false,
        detail: 'integrity_check: malformed',
        fix: 'Back up /d/laud.db, then delete it.',
      },
    ];

    await expect(runProvisioning(ctx, { yes: true }, checks, 'linux')).rejects.toThrow(
      EnvironmentError,
    );

    const output = ctx.lines.join('\n');
    expect(output).toContain('database');
    expect(output).toContain('Back up /d/laud.db, then delete it.');
    expect(output).not.toContain('Everything laud needs is already in place.');
    expect(providers.downloadFile).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('still says everything is in place when nothing failed at all', async () => {
    const ctx = provisioningContext(context().config);
    const checks: readonly Check[] = [
      { name: 'ffmpeg', ok: true, detail: 'ffmpeg version 7' },
      { name: 'database', ok: true, detail: 'integrity_check: ok' },
    ];

    await expect(runProvisioning(ctx, { yes: true }, checks, 'linux')).resolves.toBeUndefined();
    expect(ctx.lines.at(-1)).toBe('Everything laud needs is already in place.');
  });

  it('prints the exact sudo command line before it asks for consent', async () => {
    // Design section 5.5: sudo is never invoked silently, and the exact
    // command appears in the plan. Asserted against what had been written at
    // the moment consent was requested, not afterwards, because "the plan
    // named it eventually" is not consent.
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const originalCi = process.env['CI'];
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    delete process.env['CI'];
    try {
      providers.detectPackageManager.mockResolvedValue('apt-get');
      const ctx = provisioningContext(context().config);
      let shownAtConsent: readonly string[] = [];
      clack.confirm.mockImplementation(async () => {
        shownAtConsent = [...ctx.lines];
        return false; // decline: nothing must run
      });

      // Declining consent still exits non-zero: the environment is exactly
      // as not-ready as it was before asking. Dedicated coverage of that
      // behavior is the next test below.
      await expect(
        runProvisioning(ctx, {}, [failing('ffmpeg', { kind: 'install-ffmpeg' })], 'linux'),
      ).rejects.toThrow(EnvironmentError);

      expect(shownAtConsent).toContain('Install ffmpeg');
      expect(shownAtConsent).toContain('  Runs: sudo apt-get update');
      expect(shownAtConsent).toContain('  Runs: sudo apt-get install -y ffmpeg');
      expect(providers.runInteractive).not.toHaveBeenCalled();
      expect(ctx.lines.at(-1)).toBe('Nothing was changed.');
    } finally {
      if (isTtyDescriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdin, 'isTTY', isTtyDescriptor);
      if (originalCi === undefined) delete process.env['CI'];
      else process.env['CI'] = originalCi;
    }
  });

  it('exits non-zero on declined consent instead of reporting success on a still-broken environment', async () => {
    // Same false-success shape as the un-fixable-checks case above (see
    // "refuses, rather than reporting success, when every failing check is
    // un-fixable"): declining consent repairs nothing, so an environment
    // where plain `doctor` exits 3 must not come out of `doctor --fix` or
    // `setup` reporting success just because the user said no.
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const originalCi = process.env['CI'];
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    delete process.env['CI'];
    try {
      providers.detectPackageManager.mockResolvedValue('apt-get');
      clack.confirm.mockResolvedValue(false);
      const ctx = provisioningContext(context().config);
      const checks: readonly Check[] = [failing('ffmpeg', { kind: 'install-ffmpeg' })];

      await expect(runProvisioning(ctx, {}, checks, 'linux')).rejects.toThrow(EnvironmentError);

      expect(ctx.lines.at(-1)).toBe('Nothing was changed.');
      expect(providers.runInteractive).not.toHaveBeenCalled();
      expect(providers.downloadFile).not.toHaveBeenCalled();
    } finally {
      if (isTtyDescriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdin, 'isTTY', isTtyDescriptor);
      if (originalCi === undefined) delete process.env['CI'];
      else process.env['CI'] = originalCi;
    }
  });

  it('does not probe for a package manager when the plan needs none', async () => {
    providers.downloadFile.mockImplementation(async (_url: string, target: string) => {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'dummy-model-bytes');
    });
    await seedDiarizationConfig();
    const ctx = provisioningContext(badConfig);
    const checks: readonly Check[] = [
      failing('whisper model', { kind: 'download-model', slot: 'transcription' }),
      failing('vad model', { kind: 'download-model', slot: 'vad' }),
    ];

    await runProvisioning(ctx, { yes: true }, checks, 'linux');
    expect(providers.detectPackageManager).not.toHaveBeenCalled();
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
      const checks: readonly Check[] = [
        failing('whisper model', { kind: 'download-model', slot: 'transcription' }),
      ];

      // The final re-check still fails here (the vad model is untouched by
      // this remedy list), which is not what this test is about: it only
      // cares about the consent/action ordering and call count, so a
      // trailing EnvironmentError from that re-check is expected and ignored.
      await runProvisioning(ctx, {}, checks, 'linux').catch(() => {});

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

describe('laud setup on Windows', () => {
  beforeEach(() => {
    // The mocks are shared across this file; this block asserts on what was
    // NOT called, so it has to start from a clean count.
    for (const fn of Object.values(providers)) fn.mockReset();
    for (const fn of Object.values(clack)) fn.mockReset();
  });

  it('prints the manual steps and exits non-zero without planning or downloading anything', async () => {
    // Section 3 of the design: setup detects Windows and prints manual
    // instructions. It used to build a plan, take consent, download both
    // models, fail both installs, and only then exit 3.
    const ctx = context();
    const program = new Command();
    program.exitOverride();
    registerSetup(program, ctx, 'win32');

    const error: unknown = await program
      .parseAsync(['node', 'laud', 'setup', '--yes'])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentError);
    const output = ctx.lines.join('\n');
    expect(output).toContain('does not provision Windows');
    expect(output).toContain('README.md');
    expect(providers.downloadFile).not.toHaveBeenCalled();
    expect(providers.installWhisper).not.toHaveBeenCalled();
    expect(providers.detectPackageManager).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
  });
});
