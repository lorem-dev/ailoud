import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Action } from '@ailoud/core';
import { MemFs } from '@ailoud/core/testing';
import {
  EMBEDDING_MODEL,
  EnvironmentError,
  SEGMENTATION_MODEL,
  UsageError,
  VAD_MODEL,
  findModel,
} from '@ailoud/core';
import {
  blocksReadiness,
  chooseModel,
  collectRemedies,
  completionsPlanLines,
  describeAction,
  describePlan,
  formatBytes,
  isInteractive,
  configuredModelName,
  isSwitchingModel,
  planNeedsPackageManager,
  requireConsent,
  resolveCompletionsShells,
  resolveModelName,
  runProvisioning,
  unfixableChecks,
} from './setup.js';
import type { PlanEnvironment } from './setup.js';
import type { PackageManager } from '@ailoud/providers';
import type { Remedy } from '@ailoud/core';
import type * as Providers from '@ailoud/providers';
import type { AiloudConfig, AiloudPaths } from '../config.js';
import type { CliContext } from '../wiring.js';
import type { Check } from '../ui/index.js';
import { context } from './testContext.js';
import { parseConfig } from '../config.js';
import { Command } from 'commander';
import { registerSetup } from './setup.js';
import { registerDoctor, runChecks } from './doctor.js';
import { SHELL_TARGETS } from '../completions/shells.js';

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

  it('raises a UsageError naming the valid models for an unknown --model', async () => {
    await expect(resolveModelName({ model: 'huge', interactive: false })).rejects.toThrow(
      UsageError,
    );
    await expect(resolveModelName({ model: 'huge', interactive: false })).rejects.toThrow(
      /tiny, base, small, medium, large-v3-turbo/,
    );
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

  it('falls back to defaultModel, not small, non-interactively with no --model', async () => {
    // The regression this guards: a reinstall of a healthy, non-default
    // model with no --model given used to fall through to "small"
    // regardless of what had been running.
    expect(await resolveModelName({ interactive: false, defaultModel: 'medium' })).toBe('medium');
  });

  it('still honors an explicit --model over defaultModel', async () => {
    expect(
      await resolveModelName({ model: 'tiny', interactive: false, defaultModel: 'medium' }),
    ).toBe('tiny');
  });

  it('opens the interactive picker on defaultModel, not small', async () => {
    const selectImpl = vi.fn().mockResolvedValue('medium');
    await resolveModelName({ interactive: true, selectImpl, defaultModel: 'medium' });
    expect(selectImpl).toHaveBeenCalledWith(expect.objectContaining({ initialValue: 'medium' }));
  });

  it('falls back to small when there is no defaultModel either', async () => {
    expect(await resolveModelName({ interactive: false })).toBe('small');
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

  it('forwards defaultModel through to resolveModelName, non-interactively', async () => {
    const name = await chooseModel({
      remedies: [{ kind: 'download-model', slot: 'transcription' }],
      interactive: false,
      defaultModel: 'medium',
    });
    expect(name).toBe('medium');
  });

  it('opens the picker on defaultModel when one is given', async () => {
    const selectImpl = vi.fn().mockResolvedValue('medium');
    await chooseModel({
      remedies: [{ kind: 'download-model', slot: 'transcription' }],
      interactive: true,
      selectImpl,
      defaultModel: 'medium',
    });
    expect(selectImpl).toHaveBeenCalledWith(expect.objectContaining({ initialValue: 'medium' }));
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
      /ailoud setup needs confirmation/,
    );
  });

  it('names the invoking command, not "setup", when doctor --fix is the caller', async () => {
    // This is the exact bug the shared-engine design exists to prevent, just
    // in the copy rather than the logic: `doctor --fix` and `setup` share
    // this one guard, so a CI job running `doctor --fix` must not be told
    // that `setup` needs confirmation -- a command it never ran.
    await expect(
      requireConsent({ yes: false, interactive: false, commandName: 'doctor' }),
    ).rejects.toThrow(/ailoud doctor needs confirmation/);
  });

  it('asks when interactive and returns the answer', async () => {
    const confirmImpl = async (): Promise<boolean> => false;
    expect(await requireConsent({ yes: false, interactive: true, confirmImpl })).toBe(false);
  });
});

describe('resolveCompletionsShells', () => {
  const zsh = SHELL_TARGETS.find((target) => target.shell === 'zsh')!;
  const bash = SHELL_TARGETS.find((target) => target.shell === 'bash')!;
  let announce: Mock;

  beforeEach(() => {
    for (const fn of Object.values(clack)) fn.mockReset();
    clack.isCancel.mockReturnValue(false);
    announce = vi.fn();
  });

  it('honours --completions without prompting', async () => {
    expect(await resolveCompletionsShells({ completions: true }, true, [zsh], announce)).toEqual([
      zsh,
    ]);
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('honours --no-completions without prompting', async () => {
    expect(await resolveCompletionsShells({ completions: false }, true, [zsh], announce)).toEqual(
      [],
    );
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('installs nothing for --yes alone, even while interactive: --yes only means "do not prompt"', async () => {
    // Same rule, for the same reason, as resolveAllowShell on mcp install:
    // resolving an unasked question as yes would append lines to a user's
    // shell startup file in CI on the strength of a flag that says nothing
    // about shell configuration.
    expect(await resolveCompletionsShells({ yes: true }, true, [zsh], announce)).toEqual([]);
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('does not prompt, and installs nothing, when no shell was detected', async () => {
    expect(await resolveCompletionsShells({}, true, [], announce)).toEqual([]);
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('does not prompt non-interactively either, with neither flag given', async () => {
    expect(await resolveCompletionsShells({}, false, [zsh], announce)).toEqual([]);
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('asks when interactive with neither flag given, and returns the detected shells on yes', async () => {
    clack.confirm.mockResolvedValue(true);
    expect(await resolveCompletionsShells({}, true, [zsh], announce)).toEqual([zsh]);
    expect(clack.confirm).toHaveBeenCalledOnce();
  });

  it('names the shells it will act on, not all three', async () => {
    // The question used to read "(bash, zsh, fish)" and then install the
    // DETECTED set without saying which -- on a stock macOS box that meant
    // editing ~/.zshrc and creating a ~/.bashrc the user never had.
    clack.confirm.mockResolvedValue(true);
    await resolveCompletionsShells({}, true, [zsh, bash], announce);
    const { message } = clack.confirm.mock.calls[0]![0] as { message: string };
    expect(message).toContain('Zsh, Bash');
    expect(message).not.toContain('fish');
  });

  it('shows what will be written before asking, and only when it asks', async () => {
    clack.confirm.mockResolvedValue(true);
    await resolveCompletionsShells({}, true, [zsh], announce);
    expect(announce).toHaveBeenCalledOnce();
    // Before, so the user can read it while answering.
    expect(announce.mock.invocationCallOrder[0]!).toBeLessThan(
      clack.confirm.mock.invocationCallOrder[0]!,
    );

    announce.mockClear();
    await resolveCompletionsShells({ completions: true }, true, [zsh], announce);
    await resolveCompletionsShells({ yes: true }, true, [zsh], announce);
    await resolveCompletionsShells({}, false, [zsh], announce);
    expect(announce).not.toHaveBeenCalled();
  });

  it('installs nothing when the offer is declined', async () => {
    clack.confirm.mockResolvedValue(false);
    expect(await resolveCompletionsShells({}, true, [zsh], announce)).toEqual([]);
  });

  it('installs nothing when the offer is cancelled', async () => {
    clack.confirm.mockResolvedValue(undefined);
    clack.isCancel.mockReturnValueOnce(true);
    expect(await resolveCompletionsShells({}, true, [zsh], announce)).toEqual([]);
  });
});

describe('completionsPlanLines', () => {
  const places = { home: '/home/u', configHome: '/home/u/.config', userDataDir: '/home/u/.ailoud' };

  it('says "create" for a startup file the user does not have', async () => {
    // The case the offer used to hide: a stock macOS box has .zshrc and
    // .bash_profile, so answering yes CREATED a ~/.bashrc that had never
    // existed. The user should read that before answering, not after.
    const fs = new MemFs({});
    await fs.writeTextFile('/home/u/.zshrc', '');
    const bash = SHELL_TARGETS.find((target) => target.shell === 'bash')!;
    const zsh = SHELL_TARGETS.find((target) => target.shell === 'zsh')!;
    const lines = await completionsPlanLines(fs, [bash, zsh], places);
    expect(lines).toContain('  Bash: create /home/u/.bashrc');
    expect(lines).toContain('  Zsh: edit /home/u/.zshrc');
  });

  it('lists no startup file for fish, which needs none', async () => {
    const fish = SHELL_TARGETS.find((target) => target.shell === 'fish')!;
    const lines = await completionsPlanLines(new MemFs({}), [fish], places);
    expect(lines).toEqual(['  Fish: create /home/u/.config/fish/completions/ailoud.fish']);
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
    configFile: '/config/ailoud.yaml',
  };
  const brew: PlanEnvironment = {
    platform: 'darwin',
    arch: 'arm64',
    dataDir: '/data',
    manager: 'brew',
    configFile: '/config/ailoud.yaml',
  };

  it('names where the choice lands and what it still needs, before consent', () => {
    // Someone whose only remaining step is "export a key" should learn that
    // while deciding, not the first time summarize refuses.
    const lines = describePlan([{ kind: 'set-llm-provider', provider: 'anthropic' }], apt);
    expect(lines[0]).toContain("Claude through Anthropic's API");
    expect(lines.join('\n')).toContain('/config/ailoud.yaml');
    expect(lines.join('\n')).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('names the chosen model in the plan, not just the provider', () => {
    const lines = describePlan(
      [{ kind: 'set-llm-provider', provider: 'anthropic', model: 'claude-opus-5' }],
      apt,
    );
    expect(lines.join('\n')).toContain('claude-opus-5');
  });

  it('says ailoud will not install Claude Code for the subscription route', () => {
    const lines = describePlan([{ kind: 'set-llm-provider', provider: 'claude-cli' }], brew);
    expect(lines.join('\n')).toMatch(/does not install it/);
  });

  it('adds nothing to the download total, since it downloads nothing', () => {
    const lines = describePlan([{ kind: 'set-llm-provider', provider: 'openai-compatible' }], apt);
    expect(lines.join('\n')).toContain('Total download: 0 MB');
  });

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

  it('is true for install-llm on macOS, where brew does the work', () => {
    // Without this, the manager is never probed, so the plan prints the
    // tarball route while the runner actually shells out to brew -- consent
    // given for something other than what runs.
    expect(planNeedsPackageManager([{ kind: 'install-llm' }], 'darwin')).toBe(true);
  });

  it('is false for install-llm on Linux, which uses the release tarball', () => {
    expect(planNeedsPackageManager([{ kind: 'install-llm' }], 'linux')).toBe(false);
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

  describe('with an optional check failing', () => {
    const withOptional: readonly Check[] = [
      { name: 'ffmpeg', ok: true, detail: 'fine' },
      {
        name: 'diarizer binary',
        ok: false,
        detail: 'not found on PATH',
        remedy: { kind: 'install-diarizer' },
        optional: true,
      },
    ];

    it('blocksReadiness is false for it, even though it failed', () => {
      expect(withOptional.map(blocksReadiness)).toEqual([false, false]);
    });

    it('still contributes its remedy to collectRemedies -- setup provisioning it is the point', () => {
      expect(collectRemedies(withOptional)).toEqual([{ kind: 'install-diarizer' }]);
    });

    it('is never counted as unfixable, remedy or not', () => {
      const noRemedy: readonly Check[] = [
        { name: 'diarizer binary', ok: false, detail: 'gone', optional: true },
      ];
      expect(unfixableChecks(withOptional)).toEqual([]);
      expect(unfixableChecks(noRemedy)).toEqual([]);
    });
  });

  describe('blocksReadiness', () => {
    it('is true for a failing, non-optional check', () => {
      expect(blocksReadiness({ name: 'ffmpeg', ok: false, detail: 'gone' })).toBe(true);
    });

    it('is false for a passing check, optional or not', () => {
      expect(blocksReadiness({ name: 'ffmpeg', ok: true, detail: 'fine' })).toBe(false);
      expect(blocksReadiness({ name: 'diarizer', ok: true, detail: 'fine', optional: true })).toBe(
        false,
      );
    });
  });
});

describe('collectRemedies with a scope', () => {
  const passingFfmpeg: Check = {
    name: 'ffmpeg',
    ok: true,
    detail: 'fine',
    remedy: { kind: 'install-ffmpeg' },
  };
  const passingConfigFile: Check = { name: 'config file', ok: true, detail: 'present' };
  const failingFfprobe: Check = {
    name: 'ffprobe',
    ok: false,
    detail: 'gone',
    remedy: { kind: 'install-ffmpeg' },
  };
  const passingTranscriptionModel: Check = {
    name: 'whisper model',
    ok: true,
    detail: '/data/models/ggml-small.bin',
    remedy: { kind: 'download-model', slot: 'transcription' },
  };
  const passingVadModel: Check = {
    name: 'vad model',
    ok: true,
    detail: '/data/models/ggml-silero-v5.1.2.bin',
    remedy: { kind: 'download-model', slot: 'vad' },
    optional: true,
  };

  it('is unchanged with no scope at all: only failing checks contribute', () => {
    const checks = [passingFfmpeg, passingConfigFile, failingFfprobe];
    expect(collectRemedies(checks)).toEqual([{ kind: 'install-ffmpeg' }]);
  });

  it('is unchanged with an empty scope object', () => {
    const checks = [passingFfmpeg, passingConfigFile, failingFfprobe];
    expect(collectRemedies(checks, {})).toEqual([{ kind: 'install-ffmpeg' }]);
  });

  it('force takes remedies from passing checks too, but still skips checks that carry none', () => {
    const checks = [passingFfmpeg, passingConfigFile, failingFfprobe];
    // passingConfigFile has no remedy at all, so it contributes nothing even
    // though force takes every passing check's remedy: there is none to take.
    expect(collectRemedies(checks, { force: true })).toEqual([
      { kind: 'install-ffmpeg' },
      { kind: 'install-ffmpeg' },
    ]);
  });

  it('switchingModel takes the passing transcription download-model remedy, and nothing else that was passing', () => {
    const checks = [passingTranscriptionModel, passingVadModel, passingFfmpeg];
    expect(collectRemedies(checks, { switchingModel: true })).toEqual([
      { kind: 'download-model', slot: 'transcription' },
    ]);
  });

  it('switchingModel still takes every failing check too, same as no scope', () => {
    const checks = [passingTranscriptionModel, failingFfprobe];
    expect(collectRemedies(checks, { switchingModel: true })).toEqual([
      { kind: 'download-model', slot: 'transcription' },
      { kind: 'install-ffmpeg' },
    ]);
  });
});

describe('isSwitchingModel', () => {
  it('is false when the configured file is the model already named', () => {
    expect(isSwitchingModel('small', '/data/models/ggml-small.bin')).toBe(false);
  });

  it('is true when a different model is named', () => {
    expect(isSwitchingModel('medium', '/data/models/ggml-small.bin')).toBe(true);
  });

  it('compares by filename, so a configured path in an unusual directory still matches', () => {
    expect(isSwitchingModel('small', '/some/unusual/path/ggml-small.bin')).toBe(false);
    expect(isSwitchingModel('medium', '/some/unusual/path/ggml-small.bin')).toBe(true);
  });

  it('is false with no --model at all', () => {
    expect(isSwitchingModel(undefined, '/data/models/ggml-small.bin')).toBe(false);
  });

  it('is false with nothing configured yet, regardless of --model', () => {
    expect(isSwitchingModel('small', null)).toBe(false);
  });

  it('treats an unrecognized name as a switch, leaving the actual validation to resolveModelName', () => {
    expect(isSwitchingModel('huge', '/data/models/ggml-small.bin')).toBe(true);
  });
});

describe('configuredModelName', () => {
  it('names the catalogue entry matching the configured path', () => {
    expect(configuredModelName('/data/models/ggml-medium.bin')).toBe('medium');
  });

  it('matches by filename, so an unusual directory still resolves', () => {
    expect(configuredModelName('/some/unusual/path/ggml-medium.bin')).toBe('medium');
  });

  it('is undefined with nothing configured', () => {
    expect(configuredModelName(null)).toBeUndefined();
  });

  it('is undefined for a path matching no catalogue entry', () => {
    expect(configuredModelName('/data/models/not-a-real-model.bin')).toBeUndefined();
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
  // Mocked even though no existing test needs it, so that a real regression
  // in the --force / substitute-remedy distinction (see doctor.ts's
  // checkLanguageModel) fails an assertion instead of attempting a real
  // brew-install/download of llama.cpp from inside a unit test.
  installLlama: vi.fn(),
  downloadFile: vi.fn(),
  runInteractive: vi.fn(),
  run: vi.fn(),
}));

// Only the I/O is faked. The command builders (ffmpegInstallCommands,
// whisperInstallCommands, formatInstallCommand, whisperTarballUrl) stay real,
// because the plan text tests below assert on the exact command lines a user
// would be shown -- a mocked builder would let those pass while the real
// consent plan said something else entirely.
vi.mock('@ailoud/providers', async (importOriginal) => ({
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
    dataDir = await mkdtemp(join(tmpdir(), 'ailoud-setup-test-'));
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
    // -- ailoud has no use for model.int8.onnx or anything else in there.
    await expect(stat(`${target}.tar.bz2`)).rejects.toThrow();
    await expect(stat(`${target}.extracted`)).rejects.toThrow();
  });

  it('clears archive junk a killed earlier run left behind, instead of stepping over it', async () => {
    // The window: rename() has moved the member into place, and the process
    // dies before the two rm()s. The next run sees a finished target, skips
    // the whole branch, and ~20 MB sits in models/ with nothing that will
    // ever remove it.
    providers.downloadFile.mockResolvedValue(undefined);
    const target = join(dataDir, 'models', SEGMENTATION_MODEL.file);
    await mkdir(join(dataDir, 'models'), { recursive: true });
    await writeFile(target, 'the model, already extracted by the killed run', 'utf8');
    await writeFile(`${target}.tar.bz2`, 'orphaned archive', 'utf8');
    await mkdir(`${target}.extracted`, { recursive: true });
    await writeFile(join(`${target}.extracted`, 'model.int8.onnx'), 'orphaned member', 'utf8');

    const result = await executePlan(
      [{ kind: 'download-diarization-model', slot: 'segmentation', model: SEGMENTATION_MODEL }],
      deps(true),
    );

    expect(result.outcomes[0]!.ok).toBe(true);
    await expect(stat(`${target}.tar.bz2`)).rejects.toThrow();
    await expect(stat(`${target}.extracted`)).rejects.toThrow();
    // The finished model is still the one on disk: the cleanup must not cost
    // a re-download, and must not touch the target itself.
    expect(await readFile(target, 'utf8')).toBe('the model, already extracted by the killed run');
    expect(providers.downloadFile).not.toHaveBeenCalled();
    expect(providers.run).not.toHaveBeenCalled();
  });

  it('leaves the archive behind for nobody: a failed tar is collected by the next run', async () => {
    // The other leak of the same scratch space -- the FailureError thrown on
    // a bad tar exits past the removals. The retry has to clear it, and does
    // so through the same up-front cleanup.
    providers.downloadFile.mockResolvedValue(undefined);
    const target = join(dataDir, 'models', SEGMENTATION_MODEL.file);
    providers.run.mockImplementation(async (_command: string, args: readonly string[]) => {
      const extractDir = args[3] as string;
      await mkdir(extractDir, { recursive: true });
      await writeFile(join(extractDir, 'junk'), 'partial extraction', 'utf8');
      return { code: 2, stdout: '', stderr: 'bzip2: data error' };
    });
    await mkdir(join(dataDir, 'models'), { recursive: true });
    await writeFile(`${target}.tar.bz2`, 'half-written archive', 'utf8');

    const failed = await executePlan(
      [{ kind: 'download-diarization-model', slot: 'segmentation', model: SEGMENTATION_MODEL }],
      deps(true),
    );
    expect(failed.outcomes[0]!.ok).toBe(false);
    // Left behind by the throw, as designed -- and collected on the retry.
    await expect(stat(`${target}.extracted`)).resolves.toBeDefined();

    providers.run.mockImplementation(async (_command: string, args: readonly string[]) => {
      const extractDir = args[3] as string;
      await mkdir(extractDir, { recursive: true });
      await writeFile(join(extractDir, 'model.onnx'), 'fake pyannote segmentation model', 'utf8');
      return { code: 0, stdout: '', stderr: '' };
    });
    const retried = await executePlan(
      [{ kind: 'download-diarization-model', slot: 'segmentation', model: SEGMENTATION_MODEL }],
      deps(true),
    );
    expect(retried.outcomes[0]!.ok).toBe(true);
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
describe('executePlan: set-llm-provider', () => {
  it('records the chosen provider as a config update', async () => {
    // The action spawns nothing, so its whole effect is this update. Left
    // unhandled, the plan named it, the user consented to it, and nothing
    // happened -- the switch had no exhaustiveness guard to catch that.
    const result = await executePlan([{ kind: 'set-llm-provider', provider: 'anthropic' }], {
      platform: 'linux',
      arch: 'x64',
      dataDir: '/nonexistent',
      manager: null,
      interactive: false,
      onStep: () => {},
    });
    expect(result.updates).toEqual({ llmProvider: 'anthropic' });
  });

  it('reports an outcome, so the run does not look like it skipped the action', async () => {
    const result = await executePlan([{ kind: 'set-llm-provider', provider: 'claude-cli' }], {
      platform: 'linux',
      arch: 'x64',
      dataDir: '/nonexistent',
      manager: null,
      interactive: false,
      onStep: () => {},
    });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]!.ok).toBe(true);
  });

  it('writes the model into the block that provider reads', async () => {
    // "sonnet" is a Claude Code alias, "claude-sonnet-5" an API id, "gpt-4o"
    // neither: a model id only means something inside its own block.
    const cases = [
      ['anthropic', 'llmAnthropicModel'],
      ['openai-compatible', 'llmOpenaiModel'],
      ['claude-cli', 'llmClaudeCliModel'],
    ] as const;
    for (const [provider, key] of cases) {
      const result = await executePlan([{ kind: 'set-llm-provider', provider, model: 'm' }], {
        platform: 'linux',
        arch: 'x64',
        dataDir: '/nonexistent',
        manager: null,
        interactive: false,
        onStep: () => {},
      });
      expect(result.updates, provider).toEqual({ llmProvider: provider, [key]: 'm' });
    }
  });

  it('downloads nothing', async () => {
    for (const fn of Object.values(providers)) fn.mockReset();
    await executePlan([{ kind: 'set-llm-provider', provider: 'openai-compatible' }], {
      platform: 'linux',
      arch: 'x64',
      dataDir: '/nonexistent',
      manager: null,
      interactive: false,
      onStep: () => {},
    });
    for (const fn of Object.values(providers)) expect(fn).not.toHaveBeenCalled();
  });
});

// runProvisioning integration tests -- these drive the real executePlan,
// writeConfigUpdates, and runChecks (only @ailoud/providers and @clack/prompts
// are mocked, per the module-level vi.mock calls above). They exist because
// every other test in this file targets a sub-function in isolation, which
// is exactly how the previous bug survived: runChecks re-reading the config
// context.config was built from at process startup, so a fully successful
// setup still failed its own final check. Only a test that actually calls
// runProvisioning and lets it write to and re-read a real config file can
// catch that.
describe('runProvisioning', () => {
  let tmp: string;
  let paths: AiloudPaths;

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
  const badConfig: AiloudConfig = {
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
        threads: 4,
      },
    },
    llm: parseConfig(null).llm,
    update: parseConfig(null).update,
  };

  /** A failing check carrying `remedy`, shaped the way runChecks would emit it. */
  function failing(name: string, remedy: Remedy): Check {
    return { name, ok: false, detail: 'missing', fix: `fix ${name} by hand`, remedy };
  }

  function provisioningContext(config: AiloudConfig): CliContext & { lines: string[] } {
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
    tmp = await mkdtemp(join(tmpdir(), 'ailoud-provisioning-test-'));
    paths = {
      configFile: join(tmp, 'config.yaml'),
      configHome: tmp,
      dataDir: join(tmp, 'data'),
      dbFile: join(tmp, 'data', 'ailoud.db'),
      mediaRoot: join(tmp, 'data', 'media'),
      jobsDir: join(tmp, 'data', 'jobs'),
      isProjectLibrary: false,
      userDataDir: join(tmp, 'data'),
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
    // The MANDATORY download is the one that fails here. It used to be the
    // VAD model, but the VAD checks are optional now -- a failing optional
    // check does not mean ailoud cannot run, so it can no longer stand in for
    // "the run as a whole failed". The whisper model is genuinely required,
    // so it is what this case turns on.
    providers.downloadFile.mockImplementation(async (url: string, target: string) => {
      if (url.includes('ggml-small') || url.includes('ggml-base')) {
        throw new Error('network down');
      }
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

    // The VAD model succeeded and must be recorded in the config even though
    // the run, as a whole, still failed on the mandatory one.
    const written = await readFile(paths.configFile, 'utf8');
    expect(written).toMatch(/vadModel:/);
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
    expect(ctx.lines.at(-1)).toBe('Everything ailoud needs is already in place.');
  });

  it('refuses, rather than reporting success, when every failing check is un-fixable', async () => {
    // The corrupt-database check deliberately carries no remedy: its repair
    // is "back up, then delete", which is destructive and belongs to a
    // human. That used to reach the same "Everything ailoud needs is already
    // in place" as a genuinely healthy machine, so `doctor --fix` exited 0
    // on a library `doctor` had just exited 3 over.
    const ctx = provisioningContext(context().config);
    const checks: readonly Check[] = [
      { name: 'ffmpeg', ok: true, detail: 'ffmpeg version 7' },
      {
        name: 'database',
        ok: false,
        detail: 'integrity_check: malformed',
        fix: 'Back up /d/ailoud.db, then delete it.',
      },
    ];

    await expect(runProvisioning(ctx, { yes: true }, checks, 'linux')).rejects.toThrow(
      EnvironmentError,
    );

    const output = ctx.lines.join('\n');
    expect(output).toContain('database');
    expect(output).toContain('Back up /d/ailoud.db, then delete it.');
    expect(output).not.toContain('Everything ailoud needs is already in place.');
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
    expect(ctx.lines.at(-1)).toBe('Everything ailoud needs is already in place.');
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
      // Now routed through `ui.warn` (declining consent is a "nothing
      // happened" outcome), which PlainUi renders with its "warning: "
      // marker prefix.
      expect(ctx.lines.at(-1)).toBe('warning: Nothing was changed.');
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

      // Now routed through `ui.warn` (declining consent is a "nothing
      // happened" outcome), which PlainUi renders with its "warning: "
      // marker prefix.
      expect(ctx.lines.at(-1)).toBe('warning: Nothing was changed.');
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

  it('does not throw when only optional (diarizer) checks are red, even though provisioning them fails too', async () => {
    // Whisper/vad are genuinely healthy -- real files, written to the real
    // config FILE (not just badConfig's in-memory object) so the final
    // re-check sees them as configured. Diarization is left unmentioned, so
    // it defaults to unconfigured. The diarizer install/downloads are then
    // made to fail for real (network down): the point of this test is that
    // an optional check staying red, even after provisioning tried and
    // failed to fix it, must not make setup throw.
    const modelPath = join(tmp, 'model.bin');
    const vadModelPath = join(tmp, 'vad-model.bin');
    await writeFile(modelPath, 'fake model', 'utf8');
    await writeFile(vadModelPath, 'fake vad model', 'utf8');
    await mkdir(dirname(paths.configFile), { recursive: true });
    await writeFile(
      paths.configFile,
      `stt:\n  whisperCpp:\n    model: ${modelPath}\n    vadModel: ${vadModelPath}\n`,
      'utf8',
    );
    providers.installSherpa.mockRejectedValue(new Error('network down'));
    providers.downloadFile.mockRejectedValue(new Error('network down'));

    const ctx = provisioningContext(badConfig);
    const checks: readonly Check[] = [
      {
        name: 'diarizer binary',
        ok: false,
        detail: 'not found on PATH',
        fix: 'run ailoud setup',
        remedy: { kind: 'install-diarizer' },
        optional: true,
      },
      {
        name: 'diarization segmentation model',
        ok: false,
        detail: 'not configured',
        fix: 'run ailoud setup',
        remedy: { kind: 'download-diarization-model', slot: 'segmentation' },
        optional: true,
      },
      {
        name: 'diarization embedding model',
        ok: false,
        detail: 'not configured',
        fix: 'run ailoud setup',
        remedy: { kind: 'download-diarization-model', slot: 'embedding' },
        optional: true,
      },
    ];

    await expect(runProvisioning(ctx, { yes: true }, checks, 'linux')).resolves.toBeUndefined();
  });

  describe('--force', () => {
    it('does nothing extra without it: a passing check plans nothing, same as before this option existed', async () => {
      const ctx = provisioningContext(badConfig);
      const checks: readonly Check[] = [
        {
          name: 'whisper model',
          ok: true,
          detail: 'healthy',
          remedy: { kind: 'download-model', slot: 'transcription' },
        },
      ];

      await expect(runProvisioning(ctx, { yes: true }, checks, 'linux')).resolves.toBeUndefined();

      expect(providers.downloadFile).not.toHaveBeenCalled();
      expect(ctx.lines.at(-1)).toBe('Everything ailoud needs is already in place.');
    });

    it('builds a non-empty plan on an all-green environment, instead of "already in place"', async () => {
      // The point of --force: this is the exact fixture the test right above
      // uses (a single PASSING check carrying a remedy), and the only
      // difference is the option -- proof the flag, not some other change in
      // the checks, is what widens the plan.
      providers.downloadFile.mockImplementation(async (_url: string, target: string) => {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'dummy-model-bytes');
      });
      const ctx = provisioningContext(badConfig);
      const checks: readonly Check[] = [
        {
          name: 'whisper model',
          ok: true,
          detail: 'healthy',
          remedy: { kind: 'download-model', slot: 'transcription' },
        },
      ];

      await expect(
        runProvisioning(ctx, { yes: true, force: true }, checks, 'linux'),
      ).resolves.toBeUndefined();

      expect(providers.downloadFile).toHaveBeenCalled();
      expect(ctx.lines).not.toContain('Everything ailoud needs is already in place.');
    });

    it('reinstalls the configured model, not the default, when no --model is given', async () => {
      // The regression this guards: --force with no --model used to resolve
      // through chooseModel with no defaultModel, which falls back to
      // DEFAULT_MODEL_NAME ("small") regardless of what was configured --
      // silently downgrading a healthy "medium" install to "small".
      const configuredModelPath = join(tmp, 'ggml-medium.bin');
      await writeFile(configuredModelPath, 'the existing medium model', 'utf8');
      const downloadedUrls: string[] = [];
      providers.downloadFile.mockImplementation(async (url: string, target: string) => {
        downloadedUrls.push(url);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'reinstalled model bytes');
      });

      const ctx = provisioningContext({
        ...badConfig,
        stt: {
          ...badConfig.stt,
          whisperCpp: { ...badConfig.stt.whisperCpp, model: configuredModelPath },
        },
      });
      const checks: readonly Check[] = [
        {
          name: 'whisper model',
          ok: true,
          detail: configuredModelPath,
          remedy: { kind: 'download-model', slot: 'transcription' },
        },
      ];

      await expect(
        runProvisioning(ctx, { yes: true, force: true }, checks, 'linux'),
      ).resolves.toBeUndefined();

      expect(downloadedUrls.some((url) => url.includes('ggml-medium.bin'))).toBe(true);
      expect(downloadedUrls.some((url) => url.includes('ggml-small.bin'))).toBe(false);
    });

    it('keeps an unrecognized configured model alone, and says why, instead of silently switching to the default', async () => {
      // The regression this guards: someone who built whisper.cpp themselves
      // and pointed stt.whisperCpp.model at their own file -- exactly the
      // person likely to reach for --force after a corrupt download. There is
      // no catalogue name for that path, and falling back to "small" would
      // replace it without being asked, the same silent-switch failure the
      // test above exists for.
      const customModelPath = join(tmp, 'my-own-whisper-build.bin');
      await writeFile(customModelPath, 'a hand-built model', 'utf8');
      const ctx = provisioningContext({
        ...badConfig,
        stt: {
          ...badConfig.stt,
          whisperCpp: { ...badConfig.stt.whisperCpp, model: customModelPath },
        },
      });
      const checks: readonly Check[] = [
        {
          name: 'whisper model',
          ok: true,
          detail: customModelPath,
          remedy: { kind: 'download-model', slot: 'transcription' },
        },
      ];

      await expect(
        runProvisioning(ctx, { yes: true, force: true }, checks, 'linux'),
      ).resolves.toBeUndefined();

      expect(providers.downloadFile).not.toHaveBeenCalled();
      const output = ctx.lines.join('\n');
      expect(output).toContain(customModelPath);
      expect(output).toMatch(/does not match any ailoud catalogue name/);
    });
  });

  describe('switching models', () => {
    it('names the old model file after a real switch, without deleting it', async () => {
      // The download writes the new model under its own filename rather than
      // overwriting the old one (see provisionRunner.ts), so the previous
      // .bin is still on disk afterwards -- this is what proves it is named
      // rather than silently orphaned.
      const oldModelPath = join(tmp, 'ggml-small.bin');
      await writeFile(oldModelPath, 'old model', 'utf8');
      providers.downloadFile.mockImplementation(async (_url: string, target: string) => {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'new model bytes');
      });

      const ctx = provisioningContext({
        ...badConfig,
        stt: {
          ...badConfig.stt,
          whisperCpp: { ...badConfig.stt.whisperCpp, model: oldModelPath },
        },
      });
      const checks: readonly Check[] = [
        {
          name: 'whisper model',
          ok: true,
          detail: oldModelPath,
          remedy: { kind: 'download-model', slot: 'transcription' },
        },
      ];

      // No --force here: naming a different model than the one configured is
      // what triggers this on its own.
      await expect(
        runProvisioning(ctx, { yes: true, model: 'medium' }, checks, 'linux'),
      ).resolves.toBeUndefined();

      const output = ctx.lines.join('\n');
      expect(output).toContain(oldModelPath);
      expect(output).toMatch(/does not delete it automatically/);
      await expect(stat(oldModelPath)).resolves.toBeDefined();
    });

    it('says nothing about an old file when the model did not actually change', async () => {
      const modelPath = join(tmp, 'ggml-small.bin');
      await writeFile(modelPath, 'the model', 'utf8');
      const ctx = provisioningContext({
        ...badConfig,
        stt: { ...badConfig.stt, whisperCpp: { ...badConfig.stt.whisperCpp, model: modelPath } },
      });
      const checks: readonly Check[] = [
        {
          name: 'whisper model',
          ok: true,
          detail: modelPath,
          remedy: { kind: 'download-model', slot: 'transcription' },
        },
      ];

      // --model names the same model that is already configured: force is
      // what would still act on it, not a name that names nothing new.
      await expect(
        runProvisioning(ctx, { yes: true, model: 'small' }, checks, 'linux'),
      ).resolves.toBeUndefined();

      expect(providers.downloadFile).not.toHaveBeenCalled();
      expect(ctx.lines.join('\n')).not.toMatch(/does not delete it automatically/);
    });

    it('names an orphaned file even when the model NAME did not change, only its directory', async () => {
      // A --force reinstall of the identical model name still moves the file:
      // every download lands under dataDir/models (see provisionRunner.ts),
      // so a configured path anywhere else is orphaned even though its
      // basename matches the new one exactly. Comparing basenames alone (the
      // original bug) missed this -- only comparing resolved paths catches it.
      const oldModelPath = join(tmp, 'custom-location', 'ggml-small.bin');
      await mkdir(dirname(oldModelPath), { recursive: true });
      await writeFile(oldModelPath, 'old model', 'utf8');
      providers.downloadFile.mockImplementation(async (_url: string, target: string) => {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'new model bytes');
      });

      const ctx = provisioningContext({
        ...badConfig,
        stt: {
          ...badConfig.stt,
          whisperCpp: { ...badConfig.stt.whisperCpp, model: oldModelPath },
        },
      });
      const checks: readonly Check[] = [
        {
          name: 'whisper model',
          ok: true,
          detail: oldModelPath,
          remedy: { kind: 'download-model', slot: 'transcription' },
        },
      ];

      await expect(
        runProvisioning(ctx, { yes: true, force: true }, checks, 'linux'),
      ).resolves.toBeUndefined();

      const output = ctx.lines.join('\n');
      expect(output).toContain(oldModelPath);
      expect(output).toMatch(/does not delete it automatically/);
    });
  });

  describe('doctor --fix does not switch models', () => {
    it('leaves a healthy, differently-named model alone under --model, unlike setup', async () => {
      const modelPath = join(tmp, 'ggml-small.bin');
      await writeFile(modelPath, 'the model', 'utf8');
      const ctx = provisioningContext({
        ...badConfig,
        stt: { ...badConfig.stt, whisperCpp: { ...badConfig.stt.whisperCpp, model: modelPath } },
      });
      const checks: readonly Check[] = [
        {
          name: 'whisper model',
          ok: true,
          detail: modelPath,
          remedy: { kind: 'download-model', slot: 'transcription' },
        },
      ];

      // 'doctor', not the default 'setup': doctor --fix's own description
      // promises to act only on what actually failed, and its --model help
      // text promises to name what a MISSING model downloads as -- neither
      // promise allows switching a model that is already healthy.
      await expect(
        runProvisioning(ctx, { yes: true, model: 'medium' }, checks, 'linux', 'doctor'),
      ).resolves.toBeUndefined();

      expect(providers.downloadFile).not.toHaveBeenCalled();
      expect(ctx.lines.at(-1)).toBe('Everything ailoud needs is already in place.');
    });
  });

  describe('an unknown --model is rejected before "nothing to fix" can hide it', () => {
    // The regression this guards: chooseModel/resolveModelName -- where
    // --model is actually validated -- is only ever reached once remedies is
    // non-empty. On an all-green machine remedies was empty regardless of
    // --model, so an unknown name exited 0 with "Everything ailoud needs is
    // already in place" instead of ever being rejected.
    const allGreenChecks: readonly Check[] = [{ name: 'database', ok: true, detail: 'fine' }];

    it('doctor --fix --model <invalid> raises UsageError even when nothing else needs fixing', async () => {
      const ctx = provisioningContext(context().config);

      await expect(
        runProvisioning(
          ctx,
          { yes: true, model: 'ailoud-test-no-such-model' },
          allGreenChecks,
          'linux',
          'doctor',
        ),
      ).rejects.toThrow(UsageError);

      expect(ctx.lines).not.toContain('Everything ailoud needs is already in place.');
    });

    it('setup --model <invalid> raises UsageError even when nothing else needs fixing', async () => {
      const ctx = provisioningContext(context().config);

      await expect(
        runProvisioning(
          ctx,
          { yes: true, model: 'ailoud-test-no-such-model' },
          allGreenChecks,
          'linux',
        ),
      ).rejects.toThrow(UsageError);

      expect(ctx.lines).not.toContain('Everything ailoud needs is already in place.');
    });
  });

  describe('--force and the LLM checks: repair vs substitute', () => {
    /** A machine that passes every check runChecks makes, so --force's plan is decided by scope alone. */
    function healthyLlmContext(llmOverrides: Partial<AiloudConfig['llm']>): CliContext & {
      lines: string[];
    } {
      const modelPath = join(tmp, 'ggml-small.bin');
      return provisioningContext({
        ...badConfig,
        stt: {
          ...badConfig.stt,
          whisperCpp: { ...badConfig.stt.whisperCpp, model: modelPath, vadModel: null },
        },
        llm: { ...parseConfig(null).llm, ...llmOverrides },
      });
    }

    beforeEach(async () => {
      // Real files for whichever paths the real runChecks below will access
      // directly (checkModel, checkLanguageModel's llama-cpp branch); every
      // binary check goes through the mocked `run()` instead, so no real
      // binary needs to exist.
      await writeFile(join(tmp, 'ggml-small.bin'), 'the model', 'utf8');
      await mkdir(dirname(join(tmp, 'llm-model.gguf')), { recursive: true });
      // --force also pulls in the (already-passing) transcription and VAD
      // model checks -- unrelated to what these two tests are about, but
      // real actions all the same, so their downloads need to actually land
      // on disk or the final re-check fails on ITS OWN account instead of
      // isolating the one thing being tested here.
      providers.downloadFile.mockImplementation(async (_url: string, target: string) => {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'dummy-model-bytes');
      });
    });

    it('does not install llama.cpp for a healthy claude-cli machine: install-llm there is a substitute, not a repair', async () => {
      const ctx = healthyLlmContext({
        provider: 'claude-cli',
        claudeCli: { binary: process.execPath, model: 'sonnet', contextTokens: 1 },
      });
      const checks = await runChecks(ctx, 'linux');
      // Sanity check on the fixture itself: the claude-cli check must
      // actually be passing, or this test would trivially pass for the wrong
      // reason (a failing check contributing its remedy regardless of scope).
      expect(checks.find((c) => c.name === 'language model')?.ok).toBe(true);

      await expect(
        runProvisioning(ctx, { yes: true, force: true }, checks, 'linux'),
      ).resolves.toBeUndefined();

      expect(providers.installLlama).not.toHaveBeenCalled();
      expect(ctx.lines.join('\n')).not.toContain('llama.cpp');
    });

    it('DOES reinstall llama.cpp and its model for a healthy local (llama-cpp) machine: that check covers exactly what install-llm repairs', async () => {
      const llmModelPath = join(tmp, 'llm-model.gguf');
      await writeFile(llmModelPath, 'the local llm model', 'utf8');
      providers.installLlama.mockResolvedValue(process.execPath);
      const ctx = healthyLlmContext({
        provider: 'llama-cpp',
        llamaCpp: {
          ...parseConfig(null).llm.llamaCpp,
          binary: process.execPath,
          model: llmModelPath,
        },
      });
      const checks = await runChecks(ctx, 'linux');
      expect(checks.find((c) => c.name === 'language runner')?.ok).toBe(true);
      expect(checks.find((c) => c.name === 'language model')?.ok).toBe(true);

      await expect(
        runProvisioning(ctx, { yes: true, force: true }, checks, 'linux'),
      ).resolves.toBeUndefined();

      expect(providers.installLlama).toHaveBeenCalled();
    });
  });

  // These pass an actual `command: Command` (registerSetup's own shape) and
  // an explicit `processEnv`, so shell detection sees exactly the fixture
  // seeded below rather than whatever $SHELL/rc files happen to exist on the
  // machine running the suite.
  describe('offering shell completions at the end of a run', () => {
    const zshScriptPath = (): string => join(paths.userDataDir, 'completions', '_ailoud');

    /** Reaches the closing runChecks re-verification, not the "nothing to fix" shortcut. */
    async function healthyRunContext(): Promise<CliContext & { lines: string[] }> {
      providers.downloadFile.mockImplementation(async (_url: string, target: string) => {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'dummy-model-bytes');
      });
      await seedDiarizationConfig();
      return provisioningContext(badConfig);
    }

    function healthyChecks(): readonly Check[] {
      return [
        failing('whisper model', { kind: 'download-model', slot: 'transcription' }),
        failing('vad model', { kind: 'download-model', slot: 'vad' }),
      ];
    }

    it('installs completions for the detected shells when --completions is given, without prompting', async () => {
      const ctx = await healthyRunContext();
      await ctx.fs.writeTextFile('/home/u/.zshrc', '');

      await runProvisioning(
        ctx,
        { yes: true, completions: true },
        healthyChecks(),
        'linux',
        'setup',
        false,
        new Command(),
        { HOME: '/home/u' },
      );

      expect(clack.confirm).not.toHaveBeenCalled();
      expect(await ctx.fs.exists(zshScriptPath())).toBe(true);
      expect(await ctx.fs.readTextFile('/home/u/.zshrc')).toContain('ailoud');
    });

    it('installs nothing when --no-completions is given, without prompting', async () => {
      const ctx = await healthyRunContext();
      await ctx.fs.writeTextFile('/home/u/.zshrc', '');

      await runProvisioning(
        ctx,
        { yes: true, completions: false },
        healthyChecks(),
        'linux',
        'setup',
        false,
        new Command(),
        { HOME: '/home/u' },
      );

      expect(clack.confirm).not.toHaveBeenCalled();
      expect(await ctx.fs.exists(zshScriptPath())).toBe(false);
    });

    it('installs nothing on --yes alone, since --yes only means "do not prompt"', async () => {
      const ctx = await healthyRunContext();
      await ctx.fs.writeTextFile('/home/u/.zshrc', '');

      await runProvisioning(
        ctx,
        { yes: true },
        healthyChecks(),
        'linux',
        'setup',
        false,
        new Command(),
        { HOME: '/home/u' },
      );

      expect(await ctx.fs.exists(zshScriptPath())).toBe(false);
    });

    it("is never reached from a call that passes no `command` -- doctor --fix's own call shape", async () => {
      const ctx = await healthyRunContext();
      await ctx.fs.writeTextFile('/home/u/.zshrc', '');

      // No `command` argument at all: the same shape doctor.ts's call uses.
      await runProvisioning(ctx, { yes: true, completions: true }, healthyChecks(), 'linux');

      expect(await ctx.fs.exists(zshScriptPath())).toBe(false);
    });

    it('reports a failed completions install as a warning instead of failing an otherwise successful run', async () => {
      // The finding this guards against: `install()` used to be called with
      // no try/catch, so an unwritable .zshrc (read-only, disk full) would
      // propagate out of the whole withProvisioningLock callback and turn a
      // fully successful, ready-environment `setup` run into a reported
      // failure over an optional nicety -- the exact outcome syncCompletions
      // in self.ts already exists to prevent on the other path into this code.
      const ctx = await healthyRunContext();
      await ctx.fs.writeTextFile('/home/u/.zshrc', '');
      const originalWriteTextFile = ctx.fs.writeTextFile.bind(ctx.fs);
      vi.spyOn(ctx.fs, 'writeTextFile').mockImplementation(
        async (path: string, content: string) => {
          // The completion script write, not the .zshrc write: it happens first
          // inside install(), so failing it is enough to make the whole
          // per-shell install throw without needing to know install()'s
          // internal write order.
          if (path.includes('/completions/')) {
            throw new Error('ENOSPC: no space left on device');
          }
          return originalWriteTextFile(path, content);
        },
      );

      // Must resolve, not reject: a failed completions install is a nicety
      // failing on top of a successful setup, not a reason to report the run
      // itself as failed.
      await runProvisioning(
        ctx,
        { yes: true, completions: true },
        healthyChecks(),
        'linux',
        'setup',
        false,
        new Command(),
        { HOME: '/home/u' },
      );

      expect(
        ctx.lines.some(
          (line) =>
            line.startsWith('warning: could not install completions for Zsh') &&
            line.includes('ENOSPC'),
        ),
      ).toBe(true);
      // The failed write must not have left a half-written script behind.
      expect(await ctx.fs.exists(zshScriptPath())).toBe(false);
    });

    it('is not offered when the final re-check still finds the environment not ready', async () => {
      const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      const originalCi = process.env['CI'];
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      delete process.env['CI'];
      try {
        // The mandatory (transcription) download fails; the VAD one succeeds
        // -- the same fixture as "still writes the config updates that did
        // succeed, still re-checks, and still throws on a partial failure"
        // above, reused here to reach a failing final check.
        providers.downloadFile.mockImplementation(async (url: string, target: string) => {
          if (url.includes('ggml-small') || url.includes('ggml-base')) {
            throw new Error('network down');
          }
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, 'dummy-model-bytes');
        });
        const ctx = provisioningContext(badConfig);
        await ctx.fs.writeTextFile('/home/u/.zshrc', '');
        // Neither --yes nor --completions: if the completions question were
        // reachable here, interactive + a detected shell would make it ask.
        clack.confirm.mockResolvedValue(true); // answers the plan's own consent question
        clack.select.mockResolvedValue('small'); // answers chooseModel's interactive picker

        await expect(
          runProvisioning(ctx, {}, healthyChecks(), 'linux', 'setup', false, new Command(), {
            HOME: '/home/u',
          }),
        ).rejects.toThrow(EnvironmentError);

        // Exactly the one consent call the plan itself needed: a second call
        // would mean the completions question was asked despite the run
        // having failed its own final check.
        expect(clack.confirm).toHaveBeenCalledTimes(1);
        expect(await ctx.fs.exists(zshScriptPath())).toBe(false);
      } finally {
        if (isTtyDescriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
        else Object.defineProperty(process.stdin, 'isTTY', isTtyDescriptor);
        if (originalCi === undefined) delete process.env['CI'];
        else process.env['CI'] = originalCi;
      }
    });
  });
});

describe('doctor --fix does not inherit --force', () => {
  it('registerDoctor never registers a --force flag, so DoctorOptions.force stays undefined', () => {
    const program = new Command();
    registerDoctor(program, context(), 'linux');
    const doctorCommand = program.commands.find((command) => command.name() === 'doctor');
    expect(doctorCommand?.options.some((option) => option.long === '--force')).toBe(false);
  });
});

describe('doctor --fix does not offer shell completions', () => {
  it('registerDoctor never registers --completions, so DoctorOptions.completions stays undefined', () => {
    const program = new Command();
    registerDoctor(program, context(), 'linux');
    const doctorCommand = program.commands.find((command) => command.name() === 'doctor');
    expect(doctorCommand?.options.some((option) => option.long === '--completions')).toBe(false);
    expect(doctorCommand?.options.some((option) => option.long === '--no-completions')).toBe(false);
  });
});

describe('registerSetup: --completions is a three-state flag', () => {
  it('registers both --completions and --no-completions with no default value', () => {
    const program = new Command();
    registerSetup(program, context(), 'linux');
    const setupCommand = program.commands.find((command) => command.name() === 'setup');
    const completionsOption = setupCommand?.options.find(
      (option) => option.long === '--completions',
    );
    const noCompletionsOption = setupCommand?.options.find(
      (option) => option.long === '--no-completions',
    );
    expect(completionsOption).toBeDefined();
    expect(noCompletionsOption).toBeDefined();
    // No default value is the whole point: commander merges --completions and
    // --no-completions onto one key, and a default here would make "neither
    // flag given" indistinguishable from an explicit "yes".
    expect(completionsOption?.defaultValue).toBeUndefined();
  });
});

describe('ailoud setup on Windows', () => {
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
      .parseAsync(['node', 'ailoud', 'setup', '--yes'])
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

  it('covers the diarizer, since the diarizer check sends win32 users to these steps', async () => {
    // checkDiarizerBinary's fix on win32 is WINDOWS_MANUAL_HINT, i.e. "see
    // the manual steps". Those steps used to list four pieces and never
    // mention diarization, leaving that user with nothing to act on.
    const ctx = context();
    const program = new Command();
    program.exitOverride();
    registerSetup(program, ctx, 'win32');

    await program.parseAsync(['node', 'ailoud', 'setup', '--yes']).catch(() => undefined);

    const output = ctx.lines.join('\n');
    expect(output).toContain('sherpa-onnx');
    expect(output).toContain('--diarize');
    expect(output).toContain('stt.diarization.binary');
  });
});
