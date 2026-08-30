import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Action } from '@laud/core';
import {
  detectPackageManager,
  downloadFile,
  ffmpegInstallCommand,
  installWhisper,
  runInteractive,
} from '@laud/providers';
import type { ConfigUpdates } from './configWrite.js';

export interface ActionOutcome {
  readonly action: Action;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ExecuteResult {
  readonly outcomes: readonly ActionOutcome[];
  readonly updates: ConfigUpdates;
}

export interface ExecuteDeps {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly dataDir: string;
  readonly interactive: boolean;
  readonly onStep: (message: string) => void;
  /** Called at most once per percent, per file. Optional: tests pass nothing. */
  readonly onProgress?: (file: string, percent: number) => void;
}

/**
 * Runs the plan. Actions are independent: a failed ffmpeg install must not
 * stop the models downloading, so every action is caught individually and
 * reported. The caller decides what the accumulated failures mean -- which
 * it does by re-running the checks, not by counting these.
 *
 * Strictly sequential -- no Promise.all, no concurrent iteration. downloadFile
 * writes through a fixed `<target>.part` suffix (no per-call random token),
 * so two downloads racing on the same target would corrupt each other; a
 * single in-flight action at a time is what keeps that safe.
 */
export async function executePlan(
  actions: readonly Action[],
  deps: ExecuteDeps,
): Promise<ExecuteResult> {
  const outcomes: ActionOutcome[] = [];
  let updates: ConfigUpdates = {};

  for (const action of actions) {
    try {
      switch (action.kind) {
        case 'create-directory': {
          await mkdir(action.path, { recursive: true });
          outcomes.push({ action, ok: true, detail: `created ${action.path}` });
          break;
        }
        case 'install-ffmpeg': {
          const manager = await detectPackageManager(deps.platform);
          if (manager === null) {
            outcomes.push({
              action,
              ok: false,
              detail: 'no supported package manager found; install ffmpeg by hand',
            });
            break;
          }
          const command = ffmpegInstallCommand(manager);
          if (command.needsSudo && !deps.interactive) {
            outcomes.push({
              action,
              ok: false,
              detail: `needs a terminal for sudo; run: ${command.command} ${command.args.join(' ')}`,
            });
            break;
          }
          // No spinner is ever started for this step (see setup.ts): runInteractive
          // uses stdio: 'inherit' so a sudo password prompt reaches the real
          // terminal, and a live spinner drawing over that same terminal at the
          // same time would make the prompt unreadable.
          deps.onStep(`Running ${command.command} ${command.args.join(' ')}`);
          const code = await runInteractive(command.command, command.args);
          outcomes.push(
            code === 0
              ? { action, ok: true, detail: 'ffmpeg installed' }
              : { action, ok: false, detail: `exited with code ${code}` },
          );
          break;
        }
        case 'install-whisper': {
          deps.onStep('Installing whisper.cpp');
          const paths = await installWhisper({
            platform: deps.platform,
            arch: deps.arch,
            dataDir: deps.dataDir,
          });
          if (paths !== null) {
            updates = { ...updates, binary: paths.binary, vadBinary: paths.vadBinary };
          }
          outcomes.push({
            action,
            ok: true,
            detail: paths === null ? 'installed on PATH' : `installed at ${paths.binary}`,
          });
          break;
        }
        case 'download-model': {
          const target = join(deps.dataDir, 'models', action.model.file);
          deps.onStep(`Downloading ${action.model.file}`);
          // A 1.5 GB download with no feedback is indistinguishable from a
          // hang. Report at most once per percent: this fires per chunk, and
          // an unthrottled call would repaint thousands of times.
          let lastPercent = -1;
          await downloadFile(action.model.url, target, {
            onProgress: (received, total) => {
              if (total === null || total === 0) return;
              const percent = Math.floor((received / total) * 100);
              if (percent === lastPercent) return;
              lastPercent = percent;
              deps.onProgress?.(action.model.file, percent);
            },
          });
          updates =
            action.slot === 'vad'
              ? { ...updates, vadModel: target }
              : { ...updates, model: target };
          outcomes.push({ action, ok: true, detail: target });
          break;
        }
      }
    } catch (error) {
      outcomes.push({
        action,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { outcomes, updates };
}
