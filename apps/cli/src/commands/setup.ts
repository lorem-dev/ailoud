import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { confirm, isCancel, select } from '@clack/prompts';
import { chooseLlm, remediesForChoice } from '../llmChoice.js';
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
import type { Action, LlmProvider, Remedy } from '@laud/core';
import {
  LLAMA_VERSION,
  SHERPA_VERSION,
  WHISPER_TAG,
  detectPackageManager,
  ffmpegInstallCommands,
  formatInstallCommand,
  llamaTarballUrl,
  sherpaTarballUrl,
  whisperInstallCommands,
  whisperTarballUrl,
} from '@laud/providers';
import type { PackageManager } from '@laud/providers';
import { executePlan } from '../provisionRunner.js';
import { writeConfigUpdates } from '../configWrite.js';
import { withProvisioningLock } from '../setupLock.js';
import { parseConfig } from '../config.js';
import type { LaudConfig } from '../config.js';
import { NOT_READY_MESSAGE, runChecks } from './doctor.js';
import type { CliContext } from '../wiring.js';
import type { Check } from '../ui/index.js';

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

/**
 * The one label every user-visible message in this file may name: whichever
 * command the user actually typed. `runProvisioning` is shared by `setup`
 * and `doctor --fix`, so any string here that hard-codes "setup" is wrong
 * half the time it is reached -- exactly the drift the shared engine exists
 * to prevent, just relocated into the copy instead of the logic.
 */
export type CommandName = 'setup' | 'doctor' | 'rm';

export interface ModelNameOptions {
  readonly model?: string;
  readonly interactive: boolean;
  readonly selectImpl?: typeof select;
  readonly commandName?: CommandName;
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
  if (isCancel(answer)) throw new UsageError(`${options.commandName ?? 'setup'} cancelled`);
  return String(answer);
}

export interface ChooseModelOptions {
  readonly model?: string;
  readonly remedies: readonly Remedy[];
  readonly interactive: boolean;
  readonly selectImpl?: typeof select;
  readonly commandName?: CommandName;
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
    ...(options.commandName === undefined ? {} : { commandName: options.commandName }),
  });
}

export interface ConsentOptions {
  readonly yes: boolean;
  readonly interactive: boolean;
  readonly confirmImpl?: (message: string) => Promise<boolean>;
  readonly commandName?: CommandName;
  /**
   * What the user is being asked to allow, as a verb phrase: "installing
   * software", "deleting recordings".
   *
   * Parameterised because this guard is shared, and the message is not. It
   * told a `laud rm` user that the command "needs confirmation before
   * installing software" -- the same class of wrong-thing-named bug that had
   * already been fixed twice in the provisioning messages, arriving here the
   * moment a second kind of command reused the guard.
   */
  readonly action?: string;
  /** The flag that grants consent in advance. `setup` has --yes; `rm` has --force. */
  readonly consentFlag?: string;
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
    const commandName = options.commandName ?? 'setup';
    const action = options.action ?? 'installing software';
    const flag = options.consentFlag ?? '--yes';
    throw new UsageError(
      `laud ${commandName} needs confirmation before ${action}, but there is no terminal to ` +
        `ask on. Re-run with ${flag} to confirm in advance.`,
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

/** How each provider is named to the user: what they picked, not the adapter's id. */
const PROVIDER_LABEL: Record<LlmProvider, string> = {
  'llama-cpp': 'a local model through llama.cpp',
  'claude-cli': 'Claude through the Claude Code CLI',
  anthropic: "Claude through Anthropic's API",
  'openai-compatible': 'OpenAI',
};

/**
 * What choosing a hosted engine actually entails, printed before consent.
 *
 * The credential is named here rather than after the run: someone whose only
 * remaining step is "export a key" should learn that while deciding, not
 * discover it the first time `summarize` refuses.
 */
function providerPlanLines(
  provider: LlmProvider,
  model: string | undefined,
  env: PlanEnvironment,
): readonly string[] {
  const lines = [
    model === undefined
      ? `Sets llm.provider to "${provider}" in ${env.configFile}`
      : `Sets llm.provider to "${provider}" and its model to "${model}" in ${env.configFile}`,
  ];
  if (provider === 'anthropic') {
    lines.push('Needs ANTHROPIC_API_KEY (or LAUD_LLM_API_KEY) in your environment');
  }
  if (provider === 'openai-compatible') {
    lines.push('Needs OPENAI_API_KEY (or LAUD_LLM_API_KEY) in your environment');
  }
  if (provider === 'claude-cli') {
    lines.push('Needs Claude Code installed and signed in; laud does not install it');
  }
  return lines;
}

/** One line describing a single planned action, used by both describePlan and the outcome report. */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'create-directory':
      return `Create directory ${action.path}`;
    case 'install-ffmpeg':
      return 'Install ffmpeg';
    case 'install-llm':
      return 'Install llama.cpp, the local language model runner';
    case 'set-llm-provider':
      return `Use ${PROVIDER_LABEL[action.provider]} for summaries`;
    case 'download-llm-model':
      return `Download ${action.model.name} (${formatBytes(action.model.bytes)}), for summarising`;
    case 'install-whisper':
      return 'Install whisper.cpp';
    case 'install-diarizer':
      return 'Install the sherpa-onnx diarizer';
    case 'download-model':
      return `Download the ${action.model.name} ${action.slot} model (${formatBytes(action.model.bytes)})`;
    case 'download-diarization-model':
      return `Download the ${action.model.name} ${action.slot} model (${formatBytes(action.model.bytes)})`;
  }
}

/**
 * Everything the plan description needs that is not in the plan itself.
 *
 * `manager` is resolved BEFORE the plan is printed, not inside executePlan
 * where it used to live: "Install ffmpeg" told a Debian user nothing about
 * the `sudo apt-get install` they were about to consent to, and section 5.5
 * of the design is explicit that sudo is never invoked silently and that the
 * exact command appears in the plan.
 */
export interface PlanEnvironment {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly dataDir: string;
  readonly manager: PackageManager | null;
  /** Where a config-writing action will land, named in the plan rather than implied. */
  readonly configFile: string;
}

const NO_PACKAGE_MANAGER =
  'No supported package manager was found, so laud cannot do this automatically.';

/** Whether the plan contains an action that needs a package manager to run. */
export function planNeedsPackageManager(
  actions: readonly Action[],
  platform: NodeJS.Platform,
): boolean {
  return actions.some(
    (action) =>
      action.kind === 'install-ffmpeg' ||
      ((action.kind === 'install-whisper' || action.kind === 'install-llm') &&
        platform === 'darwin'),
  );
}

function whisperPlanLines(env: PlanEnvironment): readonly string[] {
  if (env.platform === 'darwin') {
    if (env.manager === null) return [NO_PACKAGE_MANAGER];
    return whisperInstallCommands(env.manager).map((c) => `Runs: ${formatInstallCommand(c)}`);
  }
  if (env.platform !== 'linux') {
    return [`laud cannot install whisper.cpp on ${env.platform} automatically.`];
  }
  try {
    return [
      `Downloads ${whisperTarballUrl(env.platform, env.arch)}`,
      `Extracts it into ${join(env.dataDir, 'whisper', WHISPER_TAG)}`,
    ];
  } catch (error) {
    // An unsupported CPU architecture. Reported as a plan line rather than
    // rethrown: one impossible action must not abandon the rest of the plan
    // (section 7), and the user still needs to read what it would have done.
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * Mirrors whisperPlanLines, but sherpa-onnx has only the one route on every
 * platform it supports (see installHint's comment in remedy.ts) -- there is
 * no macOS/brew branch to mirror.
 */
function diarizerPlanLines(env: PlanEnvironment): readonly string[] {
  try {
    return [
      `Downloads ${sherpaTarballUrl(env.platform, env.arch)}`,
      `Extracts it into ${join(env.dataDir, 'sherpa', SHERPA_VERSION)}`,
    ];
  } catch (error) {
    // An unsupported platform or CPU architecture. Reported as a plan line
    // rather than rethrown, for the same reason whisperPlanLines does.
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * What installing the language-model runner will do, for the consent plan.
 *
 * On macOS this is one brew command, because llama.cpp has a formula and
 * sending a user through laud's own installer for something brew already does
 * would be gratuitous. Everywhere else it is the pinned release tarball, the
 * same route whisper.cpp and sherpa take.
 */
function llmPlanLines(env: PlanEnvironment): readonly string[] {
  if (env.platform === 'darwin' && env.manager === 'brew') {
    return ['Runs: brew install llama.cpp'];
  }
  try {
    return [
      `Downloads ${llamaTarballUrl(env.platform, env.arch)}`,
      `Extracts it into ${join(env.dataDir, 'llama', LLAMA_VERSION)}`,
    ];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * The exact commands an action will run, indented under its summary line.
 * Empty for actions that spawn nothing.
 */
export function describeCommands(action: Action, env: PlanEnvironment): readonly string[] {
  switch (action.kind) {
    case 'install-ffmpeg':
      if (env.manager === null) return [NO_PACKAGE_MANAGER];
      return ffmpegInstallCommands(env.manager).map((c) => `Runs: ${formatInstallCommand(c)}`);
    case 'install-whisper':
      return whisperPlanLines(env);
    case 'install-diarizer':
      return diarizerPlanLines(env);
    case 'install-llm':
      return llmPlanLines(env);
    case 'set-llm-provider':
      return providerPlanLines(action.provider, action.model, env);
    case 'create-directory':
    case 'download-model':
    case 'download-diarization-model':
    case 'download-llm-model':
      return [];
  }
}

/**
 * The full plan, printed for consent before anything runs: one line per
 * action, the exact command lines it will spawn underneath it, and the total
 * download size. Consent is asked against exactly this text, so it must name
 * every action, every command, and every byte that will move.
 */
export function describePlan(actions: readonly Action[], env: PlanEnvironment): readonly string[] {
  const lines: string[] = [];
  for (const action of actions) {
    lines.push(describeAction(action));
    for (const command of describeCommands(action, env)) lines.push(`  ${command}`);
  }
  lines.push(`Total download: ${formatBytes(planDownloadBytes(actions))}`);
  return lines;
}

/**
 * Whether a failing check means laud cannot run at all. `Check.optional`
 * (see its doc comment) marks checks for opt-in features -- the diarizer
 * today -- whose failure means only that feature is unavailable, not that
 * laud is broken. This is the one place that distinction is applied to the
 * ready/not-ready decision, so `doctor`, `unfixableChecks`, and the final
 * re-check in `runProvisioning` cannot drift onto different answers for the
 * same check.
 */
export function blocksReadiness(check: Check): boolean {
  return !check.ok && check.optional !== true;
}

/**
 * The remedies of the checks that failed -- the single definition of "what
 * provisioning should act on", shared by `setup` and `doctor --fix`.
 *
 * Both entry points used to keep a verbatim copy of this filter. That is the
 * exact drift the one-engine design exists to prevent, so it lives here and
 * `runProvisioning` is the only caller.
 *
 * Deliberately NOT filtered by `blocksReadiness`: an optional check's
 * remedy belongs in the plan just as much as a mandatory one's -- `setup`
 * provisioning the diarizer alongside everything else is exactly what an
 * optional check being fixable is for. Only the ready/not-ready decision
 * itself treats the two differently.
 */
export function collectRemedies(checks: readonly Check[]): readonly Remedy[] {
  return checks
    .filter((check) => !check.ok)
    .flatMap((check) => (check.remedy !== undefined ? [check.remedy] : []));
}

/**
 * Failing checks that carry no remedy, i.e. the ones no amount of
 * provisioning will repair. The corrupt-database check is the case this
 * exists for: its repair is "back up, then delete", which is destructive and
 * belongs to a human, so it deliberately has no remedy.
 *
 * Filtered by `blocksReadiness` too: a failing optional check with no
 * remedy (hypothetical today -- all three diarization checks carry one)
 * still must not be reported as something standing between the user and a
 * "ready" environment.
 */
export function unfixableChecks(checks: readonly Check[]): readonly Check[] {
  return checks.filter((check) => blocksReadiness(check) && check.remedy === undefined);
}

/** Names the checks provisioning will not touch, with the human fix each carries. */
function reportUnfixable(context: CliContext, checks: readonly Check[]): void {
  context.write(
    checks.length === 1
      ? 'One check failed, and it is not something laud can repair automatically:'
      : `${checks.length} checks failed, and none of them are something laud can repair ` +
          'automatically:',
  );
  for (const check of checks) {
    context.write(`FAILED  ${check.name} -- ${check.detail}`);
    if (check.fix !== undefined) context.write(`        ${check.fix}`);
  }
}

export interface SetupOptions {
  readonly yes?: boolean;
  readonly model?: string;
  readonly llm?: string;
  readonly llmModel?: string;
}

/**
 * Runs the plan-and-confirm-and-execute pipeline shared by `setup` and
 * `doctor --fix`: both hand over the checks they just ran, and this derives
 * the remedies (`collectRemedies`), resolves a model, builds a plan, gets
 * consent once, executes sequentially, writes config updates, and re-checks.
 * Exported so that command does not have to copy this instead of importing it.
 *
 * Takes the checks rather than pre-filtered remedies so that "no check
 * failed" and "checks failed but none are auto-fixable" stay distinguishable
 * here -- a remedy list flattens both to empty.
 *
 * `commandName` is not part of `SetupOptions`: it is not a CLI flag, it is
 * which of the two callers is asking, threaded through so every message
 * this function's helpers can throw (the consent guard, a cancelled model
 * prompt) names the command the user actually typed. Defaults to 'setup'
 * so every existing call site that predates `doctor --fix` keeps behaving
 * exactly as it did.
 */
export async function runProvisioning(
  context: CliContext,
  options: SetupOptions,
  checks: readonly Check[],
  platform: NodeJS.Platform = process.platform,
  commandName: CommandName = 'setup',
  checksAlreadyShown: boolean = false,
): Promise<void> {
  // Before anything else, and in particular before any remedy is collected
  // or plan built: building a plan on Windows would take consent, pull down
  // up to 1.6 GB of models, then fail both installs and exit non-zero
  // anyway. This used to live only in registerSetup, so `doctor --fix` on
  // Windows built the plan and paid for the download before failing --
  // exactly the drift the shared engine exists to prevent. Living here
  // means both entry points refuse first and spend nothing, and neither can
  // drift away from it again.
  if (platform === 'win32') {
    for (const line of windowsManualSteps(commandName)) context.write(line);
    throw new EnvironmentError(
      `laud ${commandName} cannot provision Windows: follow the manual steps above.`,
    );
  }

  const interactive = isInteractive(process.env, process.stdin.isTTY === true);
  // Asked before the "nothing to fix" test below, not after: choosing a hosted
  // engine REMOVES the local install and download from the list, so the answer
  // can be the difference between a plan and an empty one.
  const collected = collectRemedies(checks);
  const llmChoice = await chooseLlm({
    ...(options.llm === undefined ? {} : { llm: options.llm }),
    ...(options.llmModel === undefined ? {} : { llmModel: options.llmModel }),
    remedies: collected,
    interactive,
    commandName,
    note: (message) => context.write(message),
  });
  const remedies = remediesForChoice(collected, llmChoice);

  if (remedies.length === 0) {
    // "Nothing to fix" and "nothing FIXABLE to fix" are different answers,
    // and collapsing them is how a corrupted library got told everything was
    // fine: `doctor` exits 3 on it, `doctor --fix` used to print success and
    // exit 0 on the identical state, and `setup` printed that one sentence
    // and nothing else.
    const unfixable = unfixableChecks(checks);
    if (unfixable.length === 0) {
      context.write('Everything laud needs is already in place.');
      return;
    }
    // `doctor --fix` already rendered the full check list (ui.checks) before
    // calling here; reprinting the unfixable subset would just show the same
    // failures a second time. `setup` never prints the checks at all, so it
    // still needs this listing to tell the user what is wrong.
    if (!checksAlreadyShown) reportUnfixable(context, unfixable);
    throw new EnvironmentError(NOT_READY_MESSAGE);
  }

  const modelName = await chooseModel({
    ...(options.model === undefined ? {} : { model: options.model }),
    remedies,
    interactive,
    commandName,
  });

  const actions = planProvisioning(remedies, { modelName });
  // Resolved here, before the plan is printed, and handed to executePlan
  // rather than detected again inside it: the command the user consents to
  // and the command that runs have to be the same string.
  const manager = planNeedsPackageManager(actions, platform)
    ? await detectPackageManager(platform)
    : null;
  const env: PlanEnvironment = {
    platform,
    arch: process.arch,
    dataDir: context.paths.dataDir,
    manager,
    configFile: context.paths.configFile,
  };
  for (const line of describePlan(actions, env)) context.write(line);

  const consented = await requireConsent({ yes: options.yes === true, interactive, commandName });
  if (!consented) {
    context.write('Nothing was changed.');
    // Declining does not undo the checks that failed to get here: remedies
    // is non-empty at this point (the "nothing to fix" case above already
    // returned), so the environment is exactly as not-ready as it was before
    // asking. Reporting success here is the same false-success shape the
    // unfixable-checks case above was fixed for -- reuse its exact message
    // rather than inventing a second way to say "still not ready".
    throw new EnvironmentError(NOT_READY_MESSAGE);
  }

  // The lock starts HERE, at the first thing that changes the machine.
  //
  // Everything above only reports or asks: the Windows refusal, the
  // nothing-to-fix return, the un-fixable listing, the printed plan and the
  // consent prompt all write nothing and touch no shared scratch. Two runs
  // racing to print a plan is harmless; two racing to download into the same
  // path is the bug. Locking earlier also made an unwritable data directory
  // break the refusal paths, so a diagnostic depended on the very thing it
  // was there to diagnose.
  //
  // From here down the run downloads, extracts, and rewrites config.
  return withProvisioningLock(context.paths.dataDir, async () => {
    const result = await executePlan(actions, {
      platform,
      arch: process.arch,
      dataDir: context.paths.dataDir,
      manager,
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
    if (finalChecks.some(blocksReadiness)) {
      throw new EnvironmentError('laud is still not ready: see the failing checks above.');
    }
  });
}

/**
 * What a Windows user gets instead of an install. Section 3 of the design:
 * there is no package providing ffmpeg the way brew and apt do, and no
 * Windows machine to verify an install path against, so an honest refusal
 * beats an untested installer.
 *
 * Takes the command name rather than hard-coding "setup": this is reachable
 * from `doctor --fix` too (runProvisioning is the one engine behind both),
 * and a Windows user running `doctor --fix` must be told that command
 * refused, not a command they never typed.
 *
 * Step 5 covers diarization even though `doctor`'s diarization checks are
 * optional. `checkDiarizerBinary`'s fix text sends a Windows user here (via
 * `WINDOWS_MANUAL_HINT`), so leaving the diarizer out of this list left that
 * user reading four steps that never mention the thing they were sent to
 * read about.
 */
export function windowsManualSteps(commandName: CommandName): readonly string[] {
  return [
    `laud ${commandName} does not provision Windows, and will not pretend to.`,
    'Install the pieces by hand -- 1 to 4 are required, 5 only for --diarize:',
    '  1. ffmpeg and ffprobe -- take a build from https://ffmpeg.org/download.html',
    '     and put both on PATH.',
    `  2. whisper.cpp -- take the Windows assets of release ${WHISPER_TAG} from`,
    '     https://github.com/ggml-org/whisper.cpp/releases and extract the tree,',
    '     keeping it intact.',
    '  3. A transcription model -- ggml-small.bin (or another size) from',
    '     https://huggingface.co/ggerganov/whisper.cpp',
    '  4. The VAD model, only needed by --multilingual -- ggml-silero-v5.1.2.bin',
    '     from https://huggingface.co/ggml-org/whisper-vad',
    '  5. The diarizer, only needed by --diarize -- sherpa-onnx publishes no',
    '     Windows asset in the pinned release, so build sherpa-onnx from source to',
    '     get sherpa-onnx-offline-speaker-diarization, and take the segmentation',
    '     and speaker-embedding models from',
    '     https://github.com/k2-fsa/sherpa-onnx/releases',
    'Then set stt.whisperCpp.binary, .vadBinary, .model and .vadModel in the config',
    'file to those paths -- plus stt.diarization.binary, .segmentationModel and',
    '.embeddingModel if you did step 5 -- and run "laud doctor" to confirm. The',
    'full version of these steps is under "Manual install (fallback)" in README.md.',
  ];
}

/**
 * `platform` is a parameter, defaulted, for the same reason `runChecks` takes
 * one: the Windows refusal it feeds into `runProvisioning` has to be
 * testable without a Windows box.
 */
export function registerSetup(
  program: Command,
  context: CliContext,
  platform: NodeJS.Platform = process.platform,
): void {
  program
    .command('setup')
    .option('--yes', 'confirm the plan without prompting')
    .option('--model <name>', 'transcription model to download (default: small)')
    .option('--llm <choice>', 'summariser to set up: local, claude-cli, claude-api, openai, skip')
    .option(
      '--llm-model <id>',
      'model id for the chosen summariser (default: ask, or keep the configured one)',
    )
    .description('Install ffmpeg and whisper.cpp, and download the models laud needs')
    .action(async (options: SetupOptions) => {
      await context.ui.frame('Setting up laud', async () => {
        // The win32 refusal lives in runProvisioning now (the shared
        // engine), not here -- see its doc comment. runChecks itself only
        // probes; it downloads nothing, so running it unconditionally
        // before that guard costs nothing on Windows either.
        const checks = await runChecks(context, platform);
        await runProvisioning(context, options, checks, platform);
      });
    });
}
