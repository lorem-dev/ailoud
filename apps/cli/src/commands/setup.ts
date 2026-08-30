import { readFile } from 'node:fs/promises';
import { confirm, isCancel, select } from '@clack/prompts';
import type { Command } from 'commander';
import {
  DEFAULT_MODEL_NAME,
  EnvironmentError,
  TRANSCRIPTION_MODELS,
  UsageError,
  findModel,
  planDownloadBytes,
  planProvisioning,
} from '@laud/core';
import type { Action, Remedy } from '@laud/core';
import { executePlan } from '../provisionRunner.js';
import { writeConfigUpdates } from '../configWrite.js';
import { parseConfig } from '../config.js';
import type { LaudConfig } from '../config.js';
import { runChecks } from './doctor.js';
import type { CliContext } from '../wiring.js';

/**
 * Whether laud may prompt: a terminal on both ends, and not a CI runner.
 *
 * `CI=0` and `CI=false` are the `ci-info`/`is-ci` convention for "explicitly
 * not CI, prompting is fine" -- only an unset, empty, or truthy `CI` counts
 * as being in CI.
 */
export function isInteractive(env: NodeJS.ProcessEnv, stdinIsTty: boolean): boolean {
  const ci = env['CI'];
  const inCi = ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false';
  if (inCi) return false;
  return stdinIsTty;
}

/**
 * Rebuilds the config from whatever is on disk right now, the same way
 * `createContext` (wiring.ts) does at process startup. `context.config` is
 * parsed once and never refreshed, but the checks below must see what
 * `writeConfigUpdates` just wrote -- otherwise a fully successful install
 * still fails the very check it just fixed, because the in-memory config
 * still holds the pre-install (missing) value.
 */
async function readCurrentConfig(configFile: string): Promise<LaudConfig> {
  let raw: string | null;
  try {
    raw = await readFile(configFile, 'utf8');
  } catch {
    raw = null; // no config file is a normal first run, not an error
  }
  return parseConfig(raw);
}

export interface ModelNameOptions {
  readonly model?: string;
  readonly interactive: boolean;
  readonly selectImpl?: typeof select;
}

export async function resolveModelName(options: ModelNameOptions): Promise<string> {
  if (options.model !== undefined) {
    if (findModel(options.model) === undefined) {
      const names = TRANSCRIPTION_MODELS.map((m) => m.name).join(', ');
      throw new UsageError(`unknown model "${options.model}"; choose one of: ${names}`);
    }
    return options.model;
  }
  if (!options.interactive) return DEFAULT_MODEL_NAME;

  const selectImpl = options.selectImpl ?? select;
  const answer = await selectImpl({
    message: 'Which transcription model should laud download?',
    initialValue: DEFAULT_MODEL_NAME,
    options: TRANSCRIPTION_MODELS.map((model) => ({
      value: model.name,
      label: `${model.name} (${formatBytes(model.bytes)})`,
      hint: model.summary,
    })),
  });
  if (isCancel(answer)) throw new UsageError('setup cancelled');
  return String(answer);
}

export interface ChooseModelOptions {
  readonly model?: string;
  readonly remedies: readonly Remedy[];
  readonly interactive: boolean;
  readonly selectImpl?: typeof select;
}

/**
 * Resolves the model name, but only opens the picker when the plan is
 * actually going to download a transcription model. `doctor --fix` on a
 * machine that only lacks ffmpeg must ask nothing, and `setup` on a machine
 * that already has a model configured must not interrupt an otherwise
 * non-interactive run just to ask a question whose answer will not be used.
 */
export async function chooseModel(options: ChooseModelOptions): Promise<string> {
  const needsTranscriptionModel = options.remedies.some(
    (remedy) => remedy.kind === 'download-model' && remedy.slot === 'transcription',
  );
  return resolveModelName({
    ...(options.model === undefined ? {} : { model: options.model }),
    interactive: options.interactive && needsTranscriptionModel,
    ...(options.selectImpl === undefined ? {} : { selectImpl: options.selectImpl }),
  });
}

export interface ConsentOptions {
  readonly yes: boolean;
  readonly interactive: boolean;
  readonly confirmImpl?: (message: string) => Promise<boolean>;
}

/**
 * Consent for installing software and downloading up to 1.5 GB.
 *
 * Asked once for the whole plan, not once per action: a per-action prompt
 * teaches people to hit `y` without reading, which is worse than not asking.
 * Without a terminal there is nobody to ask, so `--yes` becomes mandatory --
 * a command that blocks on a keypress in CI hangs the pipeline until it times
 * out, and one that installs software unasked is worse still.
 */
export async function requireConsent(options: ConsentOptions): Promise<boolean> {
  if (options.yes) return true;
  if (!options.interactive) {
    throw new UsageError(
      'laud setup needs confirmation before installing software, but there is no terminal to ' +
        'ask on. Re-run with --yes to confirm in advance.',
    );
  }
  const confirmImpl =
    options.confirmImpl ??
    (async (message: string) => {
      const answer = await confirm({ message });
      if (isCancel(answer)) return false;
      return answer === true;
    });
  return confirmImpl('Proceed?');
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** One line describing a single planned action, used by both describePlan and the outcome report. */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'create-directory':
      return `Create directory ${action.path}`;
    case 'install-ffmpeg':
      return 'Install ffmpeg';
    case 'install-whisper':
      return 'Install whisper.cpp';
    case 'download-model':
      return `Download the ${action.model.name} ${action.slot} model (${formatBytes(action.model.bytes)})`;
  }
}

/**
 * The full plan, printed for consent before anything runs: one line per
 * action plus the total download size. Consent is asked against exactly
 * this text, so it must name every action and every byte that will move.
 */
export function describePlan(actions: readonly Action[]): readonly string[] {
  return [
    ...actions.map(describeAction),
    `Total download: ${formatBytes(planDownloadBytes(actions))}`,
  ];
}

export interface SetupOptions {
  readonly yes?: boolean;
  readonly model?: string;
}

/**
 * Runs the plan-and-confirm-and-execute pipeline shared by `setup` and (in a
 * later task) `doctor --fix`: both resolve a model, build a plan from
 * whatever remedies their caller selected, get consent once, execute
 * sequentially, write config updates, and re-check. Exported so that command
 * does not have to copy this instead of importing it.
 */
export async function runProvisioning(
  context: CliContext,
  options: SetupOptions,
  remedies: readonly Remedy[],
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (remedies.length === 0) {
    context.write('Everything laud needs is already in place.');
    return;
  }

  const interactive = isInteractive(process.env, process.stdin.isTTY === true);
  const modelName = await chooseModel({
    ...(options.model === undefined ? {} : { model: options.model }),
    remedies,
    interactive,
  });

  const actions = planProvisioning(remedies, { modelName });
  for (const line of describePlan(actions)) context.write(line);

  const consented = await requireConsent({ yes: options.yes === true, interactive });
  if (!consented) {
    context.write('Nothing was changed.');
    return;
  }

  const result = await executePlan(actions, {
    platform,
    arch: process.arch,
    dataDir: context.paths.dataDir,
    interactive,
    onStep: (message) => context.write(message),
    // Coarse-grained on purpose: a line per percent would flood plain output,
    // and no spinner is used here (see provisionRunner.ts) so there is never
    // a live display for this to update instead.
    onProgress: (file, percent) => {
      if (percent % 20 === 0) context.write(`  ${file}: ${percent}%`);
    },
  });

  for (const outcome of result.outcomes) {
    const status = outcome.ok ? 'ok' : 'FAILED';
    context.write(`${status}  ${describeAction(outcome.action)} -- ${outcome.detail}`);
  }

  const updatedKeys = Object.keys(result.updates);
  if (updatedKeys.length > 0) {
    await writeConfigUpdates(context.paths.configFile, result.updates);
    context.write(`Updated ${context.paths.configFile}: ${updatedKeys.join(', ')}`);
  }

  // Re-read unconditionally, even when result.updates was empty: an action
  // can change what the checks see (e.g. installing a binary onto PATH)
  // without writing anything back to the config file.
  const freshConfig = await readCurrentConfig(context.paths.configFile);
  const finalChecks = await runChecks({ ...context, config: freshConfig }, platform);
  context.ui.checks(finalChecks);
  if (finalChecks.some((check) => !check.ok)) {
    throw new EnvironmentError('laud is still not ready: see the failing checks above.');
  }
}

export function registerSetup(program: Command, context: CliContext): void {
  program
    .command('setup')
    .option('--yes', 'confirm the plan without prompting')
    .option('--model <name>', 'transcription model to download (default: small)')
    .description('Install ffmpeg and whisper.cpp, and download the models laud needs')
    .action(async (options: SetupOptions) => {
      await context.ui.frame('Setting up laud', async () => {
        const checks = await runChecks(context);
        const remedies = checks
          .filter((check) => !check.ok)
          .flatMap((check) => (check.remedy !== undefined ? [check.remedy] : []));
        await runProvisioning(context, options, remedies);
      });
    });
}
