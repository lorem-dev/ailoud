import { join } from 'node:path';
import { access, constants, mkdir } from 'node:fs/promises';
import type { Action } from '@laud/core';
import {
  downloadFile,
  ffmpegInstallCommands,
  formatInstallCommand,
  installWhisper,
  runInteractive,
} from '@laud/providers';
import type { InstallCommand, PackageManager } from '@laud/providers';
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
  /**
   * Resolved once by the caller, before the plan was printed, and passed in
   * rather than detected here. Detecting it at execution time is what let
   * "Install ffmpeg" be confirmed without the user ever seeing the sudo
   * command it stood for; the plan and the execution must be driven by the
   * same answer.
   */
  readonly manager: PackageManager | null;
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
          // `mkdir(recursive)` returns the first directory it created, or
          // undefined when there was nothing to create. That distinction
          // matters for checkMediaRoot's "exists but unwritable" failure:
          // mkdir no-ops on it, and reporting "created" would be a false
          // claim about the one thing that is still wrong -- the access()
          // check just below exists to catch exactly that case. checkMediaRoot
          // can also fail because the path is not a directory at all, or does
          // not exist and cannot be created (e.g. an unwritable parent); both
          // of those make mkdir itself throw, which the outer catch below
          // reports as a raw errno -- correct, just not what this branch is
          // for.
          const created = await mkdir(action.path, { recursive: true });
          try {
            await access(action.path, constants.W_OK);
          } catch {
            outcomes.push({
              action,
              ok: false,
              detail:
                `${action.path} exists but laud's user cannot write to it; change its ` +
                'owner or permissions',
            });
            break;
          }
          outcomes.push({
            action,
            ok: true,
            detail:
              created === undefined
                ? `${action.path} (already writable)`
                : `created ${action.path}`,
          });
          break;
        }
        case 'install-ffmpeg': {
          if (deps.manager === null) {
            outcomes.push({
              action,
              ok: false,
              detail: 'no supported package manager found; install ffmpeg by hand',
            });
            break;
          }
          const commands = ffmpegInstallCommands(deps.manager);
          // Gated on `interactive`, not on `needsSudo`: runInteractive has no
          // timeout at all (see run.ts), so ANY command it spawns can wait
          // forever with nothing on stdin. `brew install` prompting for the
          // Xcode command line tools is the case that made the sudo-only
          // guard insufficient -- it needs no sudo and still hangs CI.
          if (!deps.interactive) {
            outcomes.push({
              action,
              ok: false,
              detail: skippedDetail(commands),
            });
            break;
          }
          outcomes.push(await runInstallCommands(action, commands, deps, 'ffmpeg installed'));
          break;
        }
        case 'install-whisper': {
          // macOS installs whisper.cpp through brew; with no package manager
          // there is nothing to run, and saying so here matches what the
          // plan already told the user.
          if (deps.platform === 'darwin' && deps.manager === null) {
            outcomes.push({
              action,
              ok: false,
              detail: 'no supported package manager found; install whisper.cpp by hand',
            });
            break;
          }
          // installWhisper reports 'skipped' immediately, without spawning
          // anything, exactly when macOS has no terminal to run brew in
          // interactively (see whisperInstall.ts) -- mirrored here, the same
          // way the ffmpeg branch above checks `interactive` before its own
          // "Running ..." step, so laud never announces work it is about to
          // decline instead of doing.
          const willSkip = deps.platform === 'darwin' && !deps.interactive;
          if (!willSkip) deps.onStep('Installing whisper.cpp');
          const result = await installWhisper({
            platform: deps.platform,
            arch: deps.arch,
            dataDir: deps.dataDir,
            interactive: deps.interactive,
          });
          if (result.kind === 'skipped') {
            outcomes.push({
              action,
              ok: false,
              detail: `needs a terminal; run: ${result.commands.join(' && ')}`,
            });
            break;
          }
          const paths = result.paths;
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

/** The refusal an action reports when it would have to spawn something with no terminal. */
function skippedDetail(commands: readonly InstallCommand[]): string {
  return `needs a terminal; run: ${commands.map(formatInstallCommand).join(' && ')}`;
}

/**
 * Runs an install's commands in order and folds them into one outcome.
 *
 * A command marked `optional` (only `apt-get update` today) is reported and
 * stepped over rather than treated as fatal: refreshing package lists can
 * fail on a single unreachable repository while the install that follows
 * still succeeds.
 */
async function runInstallCommands(
  action: Action,
  commands: readonly InstallCommand[],
  deps: ExecuteDeps,
  successDetail: string,
): Promise<ActionOutcome> {
  for (const command of commands) {
    const line = formatInstallCommand(command);
    // No spinner is ever started for this step (see setup.ts): runInteractive
    // uses stdio: 'inherit' so a sudo password prompt reaches the real
    // terminal, and a live spinner drawing over that same terminal at the
    // same time would make the prompt unreadable.
    deps.onStep(`Running ${line}`);
    const code = await runInteractive(command.command, command.args);
    if (code === 0) continue;
    if (command.optional === true) {
      deps.onStep(`  "${line}" exited with code ${code}; continuing`);
      continue;
    }
    return { action, ok: false, detail: `"${line}" exited with code ${code}` };
  }
  return { action, ok: true, detail: successDetail };
}
