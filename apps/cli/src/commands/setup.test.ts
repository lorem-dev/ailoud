import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@laud/core';
import { VAD_MODEL, findModel } from '@laud/core';
import {
  chooseModel,
  describeAction,
  describePlan,
  formatBytes,
  isInteractive,
  requireConsent,
  resolveModelName,
} from './setup.js';

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
const providers = vi.hoisted(() => ({
  detectPackageManager: vi.fn(),
  ffmpegInstallCommand: vi.fn(),
  installWhisper: vi.fn(),
  downloadFile: vi.fn(),
  runInteractive: vi.fn(),
}));

vi.mock('@laud/providers', () => providers);

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
