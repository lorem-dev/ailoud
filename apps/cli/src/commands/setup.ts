import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
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
} from '@ailoud/core';
import type { Action, Fs, LlmProvider, Remedy } from '@ailoud/core';
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
} from '@ailoud/providers';
import type { PackageManager } from '@ailoud/providers';
import { executePlan } from '../provisionRunner.js';
import { writeConfigUpdates } from '../configWrite.js';
import { withProvisioningLock } from '../setupLock.js';
import { parseConfig } from '../config.js';
import type { AiloudConfig } from '../config.js';
import { NOT_READY_MESSAGE, runChecks } from './doctor.js';
import type { CliContext } from '../wiring.js';
import type { Check } from '../ui/index.js';
import { install } from '../completions/install.js';
import type { Places, ShellOutcome } from '../completions/install.js';
import { describeTree } from '../completions/generate.js';
import type { ShellTarget } from '../completions/shells.js';
// setup.ts and selfCompletions.ts end up importing each other (selfCompletions
// imports `isInteractive` from here) -- safe for the same reason doctor.ts's
// import of `runProvisioning` is: every use on both sides happens inside a
// function body, never at module-init time, so there is no evaluation-order
// cycle for ESM to trip over.
import { parseShells, placesFor, report, rootOf } from './selfCompletions.js';

/**
 * Whether ailoud may prompt: a terminal on both ends, and not a CI runner.
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
async function readCurrentConfig(configFile: string): Promise<AiloudConfig> {
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
export type CommandName = 'setup' | 'doctor' | 'rm' | 'report rm';

export interface ModelNameOptions {
  readonly model?: string;
  readonly interactive: boolean;
  readonly selectImpl?: typeof select;
  readonly commandName?: CommandName;
  /**
   * What to resolve to when `model` is absent, in place of
   * `DEFAULT_MODEL_NAME` -- the catalogue name of whatever is already
   * configured, when there is one. Without this, reinstalling a healthy,
   * non-default model with no `--model` given (`setup --force --yes` is the
   * documented way to replace a corrupted file) silently downgraded it: the
   * resolution fell through to `small` regardless of what had been running,
   * and the interactive picker's `initialValue` did the same, so pressing
   * Enter did too.
   */
  readonly defaultModel?: string;
}

export async function resolveModelName(options: ModelNameOptions): Promise<string> {
  if (options.model !== undefined) {
    if (findModel(options.model) === undefined) {
      const names = TRANSCRIPTION_MODELS.map((m) => m.name).join(', ');
      throw new UsageError(`unknown model "${options.model}"; choose one of: ${names}`);
    }
    return options.model;
  }
  const fallback = options.defaultModel ?? DEFAULT_MODEL_NAME;
  if (!options.interactive) return fallback;

  const selectImpl = options.selectImpl ?? select;
  const answer = await selectImpl({
    message: 'Which transcription model should ailoud download?',
    initialValue: fallback,
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
  /** See `ModelNameOptions.defaultModel`; forwarded to `resolveModelName` unchanged. */
  readonly defaultModel?: string;
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
    ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
  });
}

/**
 * The catalogue name of whatever is already configured, so a reinstall with
 * no explicit `--model` keeps it rather than falling back to
 * `DEFAULT_MODEL_NAME`. Filename-based for the same reason `isSwitchingModel`
 * is: `configuredModel` is a path, the catalogue only knows names.
 *
 * Returns `undefined` for a path that matches no catalogue entry (nothing
 * configured yet, or a hand-edited config pointing at a file ailoud never
 * downloaded) -- callers fall back to `DEFAULT_MODEL_NAME` themselves, the
 * same way they always did when nothing was configured.
 */
export function configuredModelName(configuredModel: string | null): string | undefined {
  if (configuredModel === null) return undefined;
  const base = basename(configuredModel);
  return TRANSCRIPTION_MODELS.find((model) => model.file === base)?.name;
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
   * told a `ailoud rm` user that the command "needs confirmation before
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
      `ailoud ${commandName} needs confirmation before ${action}, but there is no terminal to ` +
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
    lines.push('Needs ANTHROPIC_API_KEY (or AILOUD_LLM_API_KEY) in your environment');
  }
  if (provider === 'openai-compatible') {
    lines.push('Needs OPENAI_API_KEY (or AILOUD_LLM_API_KEY) in your environment');
  }
  if (provider === 'claude-cli') {
    lines.push('Needs Claude Code installed and signed in; ailoud does not install it');
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
  'No supported package manager was found, so ailoud cannot do this automatically.';

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
    return [`ailoud cannot install whisper.cpp on ${env.platform} automatically.`];
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
 * sending a user through ailoud's own installer for something brew already does
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
 * Whether a failing check means ailoud cannot run at all. `Check.optional`
 * (see its doc comment) marks checks for opt-in features -- the diarizer
 * today -- whose failure means only that feature is unavailable, not that
 * ailoud is broken. This is the one place that distinction is applied to the
 * ready/not-ready decision, so `doctor`, `unfixableChecks`, and the final
 * re-check in `runProvisioning` cannot drift onto different answers for the
 * same check.
 */
export function blocksReadiness(check: Check): boolean {
  return !check.ok && check.optional !== true;
}

/**
 * Widens which passing checks contribute their remedy, on top of every
 * failing check's (which always contributes -- see `collectRemedies`).
 *
 * The two flags are independent because they answer different questions:
 * `force` is "reinstall everything, I asked for it explicitly"; `switchingModel`
 * is "one specific thing changed, act on just that". A `--force --model medium`
 * run sets both -- `force` alone would already cover what `switchingModel`
 * asks for, but leaving `switchingModel` out of that run would be relying on
 * `force`'s breadth by accident rather than by the actual reason the model
 * remedy is present.
 */
export interface RemedyScope {
  /** Take every repairable check's remedy, not only the failing ones. */
  readonly force?: boolean;
  /** Take the transcription-model remedy even from a passing check. */
  readonly switchingModel?: boolean;
}

/**
 * The remedies provisioning should act on -- the single definition of "what
 * to do", shared by `setup` and `doctor --fix`.
 *
 * Both entry points used to keep a verbatim copy of this filter. That is the
 * exact drift the one-engine design exists to prevent, so it lives here and
 * `runProvisioning` is the only caller.
 *
 * With no `scope` (or both flags false/absent), only failing checks
 * contribute -- the original behaviour, unchanged, and what `doctor --fix`
 * still gets since it never sets `force`.
 *
 * `scope.force` takes a passing check's remedy too, for every check that
 * carries one -- including `install-ffmpeg` and the macOS brew route for
 * whisper. The user asked for the widest scope by passing `--force`; this is
 * the one place that scope is decided, so `--force` cannot drift into a
 * second installation route that skips some remedies `setup`'s normal path
 * would have used.
 *
 * `scope.switchingModel` takes only the transcription `download-model`
 * remedy from a passing check, and only that one: `--model <name>` on a
 * machine whose configured model is already healthy must still switch
 * models, without also reinstalling ffmpeg or whisper just because a
 * transcription-model check happened to pass alongside them.
 *
 * Deliberately NOT filtered by `blocksReadiness`: an optional check's
 * remedy belongs in the plan just as much as a mandatory one's -- `setup`
 * provisioning the diarizer alongside everything else is exactly what an
 * optional check being fixable is for. Only the ready/not-ready decision
 * itself treats the two differently.
 */
export function collectRemedies(checks: readonly Check[], scope?: RemedyScope): readonly Remedy[] {
  return checks
    .filter((check) => {
      if (!check.ok) return true;
      if (scope?.force === true) return true;
      return (
        scope?.switchingModel === true &&
        check.remedy?.kind === 'download-model' &&
        check.remedy.slot === 'transcription'
      );
    })
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
  context.ui.warn(
    checks.length === 1
      ? 'One check failed, and it is not something ailoud can repair automatically:'
      : `${checks.length} checks failed, and none of them are something ailoud can repair ` +
          'automatically:',
  );
  for (const check of checks) {
    context.ui.warn(`FAILED  ${check.name} -- ${check.detail}`);
    if (check.fix !== undefined) context.ui.warn(`        ${check.fix}`);
  }
}

export interface SetupOptions {
  readonly yes?: boolean;
  readonly model?: string;
  readonly llm?: string;
  readonly llmModel?: string;
  /**
   * `doctor --fix` inherits this field (`DoctorOptions extends SetupOptions`)
   * but `registerDoctor` never registers a `--force` flag, so it stays
   * `undefined` there -- `doctor --fix` keeps acting only on what actually
   * failed, exactly as before this option existed.
   */
  readonly force?: boolean;
  /**
   * Set by --completions, cleared by --no-completions, absent when neither
   * was given -- registerSetup registers both flags with no default so
   * commander preserves this three-state shape; see
   * `resolveCompletionsShells`'s doc comment for why "absent" cannot mean
   * "yes". `doctor --fix` also inherits this field (`DoctorOptions extends
   * SetupOptions`), but never registers either flag and never passes a
   * `command` to `runProvisioning`, so the completions offer is never
   * reached from there regardless of this value -- see runProvisioning's
   * closing block.
   */
  readonly completions?: boolean;
}

/**
 * Whether `--model <name>` names a different model from the one already
 * configured, i.e. whether provisioning should switch rather than leave a
 * healthy transcription model alone.
 *
 * `configuredModel` is a filesystem path (`config.stt.whisperCpp.model`);
 * `model` is a catalogue name (`--model`). They are compared by filename,
 * via `findModel(model).file` against the basename of `configuredModel` --
 * the two are not otherwise comparable, and the configured path's directory
 * is `dataDir`-dependent and not part of the model's identity.
 *
 * An unrecognized `model` counts as switching (returns `true`) rather than
 * `false`: this function only decides whether the transcription remedy is
 * worth taking from a passing check, it never validates the name itself --
 * `resolveModelName` (via `chooseModel`) does that and raises the real
 * `UsageError` naming the valid models. Returning `false` here for a bad name
 * would risk `collectRemedies` finding nothing to do on an otherwise healthy
 * machine, short-circuiting to "already in place" before that validation is
 * ever reached.
 */
export function isSwitchingModel(
  model: string | undefined,
  configuredModel: string | null,
): boolean {
  if (model === undefined || configuredModel === null) return false;
  const found = findModel(model);
  if (found === undefined) return true;
  return basename(configuredModel) !== found.file;
}

/**
 * The shells to install completions for at the very end of a successful
 * `setup` run, or empty to install none. Called from `offerCompletions`,
 * itself called from the very end of `runProvisioning` -- see both doc
 * comments for where this sits in the pipeline and why.
 *
 * `--completions` / `--no-completions` (registerSetup's three-state option --
 * see `SetupOptions.completions`) answer directly, with no prompt.
 *
 * Absent either flag, `--yes` alone answers no, without a prompt, the same
 * rule and for the same reason as `resolveAllowShell` in mcpInstall.ts:
 * `--yes` means "do not prompt", not "consent to everything" -- resolving
 * this unasked question as yes would append lines to a user's shell startup
 * file in CI on the strength of a flag that says nothing about shell
 * configuration.
 *
 * This is deliberately the OPPOSITE of `--yes` on `self completions install`
 * (see `chooseShells` in selfCompletions.ts): running that command IS the
 * request to install, so there is no unasked question there for `--yes` to
 * misread. The two rules must not be unified -- the asymmetry is the point,
 * not a drift to fix.
 *
 * `detected` empty also answers no, without a prompt, regardless of every
 * flag above: there is nothing useful to offer, and a question with no
 * options is worse than staying silent.
 */
export async function resolveCompletionsShells(
  options: SetupOptions,
  interactive: boolean,
  detected: readonly ShellTarget[],
  announce: () => void,
): Promise<readonly ShellTarget[]> {
  if (options.completions === false || detected.length === 0) return [];
  if (options.completions === true) return detected;
  if (options.yes === true || !interactive) return [];
  // The exact files, before the question rather than after it, the same shape
  // `mcp install` uses before asking about an allow-list. The question used to
  // name all three shells and then install the DETECTED ones without saying
  // which: on a stock macOS box with .zshrc and .bash_profile, yes edited
  // ~/.zshrc and CREATED a ~/.bashrc the user had never had, with no chance to
  // see that first. Announced here, inside the only branch that prompts, so
  // the flag and non-interactive paths stay silent.
  announce();
  const answer = await confirm({
    message: `Install shell completions for ${detected.map((t) => t.label).join(', ')}?`,
    initialValue: true,
  });
  if (isCancel(answer) || answer !== true) return [];
  return detected;
}

/**
 * One line per file the offer above would write, saying whether it exists.
 *
 * "create" is the word that matters: a `~/.bashrc` that is not there yet gets
 * made, and a user who only ever had `~/.bash_profile` should read that before
 * answering, not discover it afterwards.
 *
 * Deliberately a listing and not a multiselect: the plan keeps `setup`'s offer
 * a single question, and `self completions install` is where a user picks
 * shells one by one. This only makes the one question honest about its scope.
 */
export async function completionsPlanLines(
  fs: Fs,
  detected: readonly ShellTarget[],
  places: Places,
): Promise<readonly string[]> {
  const lines: string[] = [];
  for (const target of detected) {
    const rcPath = target.rcPath(places.home);
    const paths = [target.scriptPath(places.home, places.configHome, places.userDataDir)];
    if (rcPath !== null) paths.push(rcPath);
    for (const path of paths) {
      lines.push(`  ${target.label}: ${(await fs.exists(path)) ? 'edit' : 'create'} ${path}`);
    }
  }
  return lines;
}

/**
 * Offers to install shell completions -- the very last thing a successful
 * `setup` run does. Called only from the closing block of `runProvisioning`,
 * after the final `runChecks` there has confirmed the environment is ready:
 * a run that failed to provision must not finish by asking about a nicety.
 *
 * `command` is the running invocation's own command, handed down so the
 * completion script can be rendered from the live command tree the same way
 * `self completions install` renders it (see `rootOf`/`describeTree`).
 * `runProvisioning` only calls this when `command` was supplied, which today
 * is only true for `setup` itself -- `doctor --fix` shares this whole
 * pipeline but never passes one, since "the environment doctor --fix just
 * repaired" is not the same moment as "the machine setup just finished
 * provisioning for the first time", and doctor --fix's own description makes
 * no promise about shell completions.
 */
async function offerCompletions(
  context: CliContext,
  options: SetupOptions,
  interactive: boolean,
  command: Command,
  processEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const places = placesFor(context, processEnv);
  const detected = await parseShells(context, 'auto', places, processEnv);
  // Resolved up front because it reads the filesystem and the callback that
  // prints it runs inside the one branch that prompts, which is synchronous.
  // A handful of `exists` calls on a run that never asks is not worth a
  // second code path.
  const lines = await completionsPlanLines(context.fs, detected, places);
  const targets = await resolveCompletionsShells(options, interactive, detected, () => {
    context.ui.note('Shell completions would be written to:');
    for (const line of lines) context.ui.note(line);
  });
  if (targets.length === 0) return;

  const tree = describeTree(rootOf(command));
  const outcomes: ShellOutcome[] = [];
  for (const target of targets) {
    try {
      outcomes.push(await install(context.fs, target, tree, places));
    } catch (error) {
      // Completions are a convenience layered on top of everything this run
      // just provisioned -- ffmpeg, whisper.cpp, and possibly a
      // multi-gigabyte model -- not the provisioning itself. `syncCompletions`
      // in self.ts enforces the identical rule on the other path into this
      // code (self update -> refreshCompletions), with the same reasoning: an
      // unwritable shell startup file (read-only .zshrc, a full disk) must not
      // turn an otherwise fully successful run into a reported failure.
      // Caught per shell rather than around the whole loop, unlike
      // syncCompletions's single try/catch -- one unwritable rc file must not
      // also skip bash and fish, which are independent writes that would
      // otherwise have succeeded.
      context.ui.warn(
        `could not install completions for ${target.label}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  report(context, outcomes);
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
  /**
   * The running invocation's own command, forwarded only by `registerSetup`
   * -- see `offerCompletions`'s doc comment for why its absence is what
   * keeps `doctor --fix` from ever reaching the completions offer.
   */
  command?: Command,
  /** Injected so a test can pin what shell detection sees without touching the real environment. */
  processEnv: NodeJS.ProcessEnv = process.env,
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
    for (const line of windowsManualSteps(commandName)) context.ui.content(line);
    throw new EnvironmentError(
      `ailoud ${commandName} cannot provision Windows: follow the manual steps above.`,
    );
  }

  // Validated here, unconditionally, rather than left to chooseModel further
  // down: that call is never reached when remedies end up empty, which on an
  // all-green machine used to mean an unknown --model exited 0 with
  // "Everything ailoud needs is already in place" instead of ever being
  // rejected -- a typo must fail the same way regardless of what else is or
  // is not broken. resolveModelName already owns this validation (round 1's
  // note not to duplicate it still applies); called here only for the
  // UsageError it throws on a bad name -- `interactive: false` is inert
  // because the validating branch returns before touching it.
  if (options.model !== undefined) {
    await resolveModelName({ model: options.model, interactive: false });
  }

  const interactive = isInteractive(process.env, process.stdin.isTTY === true);
  // The path `--model` would replace, read before anything downloads: it is
  // both what decides `switchingModel` below and, after a successful switch,
  // the file `writeConfigUpdates` is about to orphan (see the note printed
  // near the end of this function).
  const configuredModel = context.config.stt.whisperCpp.model;
  const scope: RemedyScope = {
    force: options.force === true,
    // `setup` only, deliberately: `doctor --fix`'s own description promises
    // to "provision anything that failed a check", and its `--model` help
    // text promises the same ("to download if one is needed") -- switching a
    // healthy model out from under `--fix` would break both promises for a
    // command nobody asked to change anything with.
    switchingModel: commandName === 'setup' && isSwitchingModel(options.model, configuredModel),
  };
  // Asked before the "nothing to fix" test below, not after: choosing a hosted
  // engine REMOVES the local install and download from the list, so the answer
  // can be the difference between a plan and an empty one.
  const collected = collectRemedies(checks, scope);
  const llmChoice = await chooseLlm({
    ...(options.llm === undefined ? {} : { llm: options.llm }),
    ...(options.llmModel === undefined ? {} : { llmModel: options.llmModel }),
    remedies: collected,
    interactive,
    commandName,
    note: (message) => context.ui.note(message),
  });
  let remedies = remediesForChoice(collected, llmChoice);

  // `--force` with no --model, on a transcription model that already exists
  // but matches no catalogue entry -- someone who built whisper.cpp
  // themselves and pointed `stt.whisperCpp.model` at their own file, exactly
  // the person likely to reach for `--force` after a corrupt download. There
  // is no catalogue name to redownload it AS, and guessing the project
  // default would silently replace a model the user chose on purpose -- the
  // same silent-switch failure `configuredModelName` was added to prevent
  // for --model itself. `transcriptionCheck.ok` is the guard that scopes
  // this to force's widening specifically: a check that is genuinely
  // failing (missing or corrupted) still needs *something* downloaded, and
  // "small" for an unrecognized path is the same fallback --model has always
  // had in that case -- untouched here, unrelated to what --force just
  // widened in.
  const transcriptionCheck = checks.find(
    (check) => check.remedy?.kind === 'download-model' && check.remedy.slot === 'transcription',
  );
  const unrecognizedForcedModel =
    options.model === undefined &&
    transcriptionCheck?.ok === true &&
    configuredModel !== null &&
    configuredModelName(configuredModel) === undefined &&
    transcriptionCheck.remedy !== undefined &&
    remedies.includes(transcriptionCheck.remedy);
  if (unrecognizedForcedModel) {
    context.ui.note(
      `Keeping the transcription model already configured at ${configuredModel} -- it does not ` +
        'match any ailoud catalogue name, so there is nothing to reinstall it as. Pass ' +
        '--model <name> to switch to a catalogue model instead.',
    );
    remedies = remedies.filter((remedy) => remedy !== transcriptionCheck.remedy);
  }

  if (remedies.length === 0) {
    // "Nothing to fix" and "nothing FIXABLE to fix" are different answers,
    // and collapsing them is how a corrupted library got told everything was
    // fine: `doctor` exits 3 on it, `doctor --fix` used to print success and
    // exit 0 on the identical state, and `setup` printed that one sentence
    // and nothing else.
    const unfixable = unfixableChecks(checks);
    if (unfixable.length === 0) {
      context.ui.note('Everything ailoud needs is already in place.');
      return;
    }
    // `doctor --fix` already rendered the full check list (ui.checks) before
    // calling here; reprinting the unfixable subset would just show the same
    // failures a second time. `setup` never prints the checks at all, so it
    // still needs this listing to tell the user what is wrong.
    if (!checksAlreadyShown) reportUnfixable(context, unfixable);
    throw new EnvironmentError(NOT_READY_MESSAGE);
  }

  const defaultModel = configuredModelName(configuredModel);
  const modelName = await chooseModel({
    ...(options.model === undefined ? {} : { model: options.model }),
    remedies,
    interactive,
    commandName,
    ...(defaultModel === undefined ? {} : { defaultModel }),
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
  for (const line of describePlan(actions, env)) context.ui.content(line);

  const consented = await requireConsent({ yes: options.yes === true, interactive, commandName });
  if (!consented) {
    context.ui.warn('Nothing was changed.');
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
      onStep: (message) => context.ui.note(message),
      // Coarse-grained on purpose: a line per percent would flood plain output,
      // and no spinner is used here (see provisionRunner.ts) so there is never
      // a live display for this to update instead.
      onProgress: (file, percent) => {
        if (percent % 20 === 0) context.ui.note(`  ${file}: ${percent}%`);
      },
    });

    for (const outcome of result.outcomes) {
      const line = `${describeAction(outcome.action)} -- ${outcome.detail}`;
      if (outcome.ok) {
        context.ui.success(line);
      } else {
        context.ui.warn(line);
      }
    }

    const updatedKeys = Object.keys(result.updates);
    if (updatedKeys.length > 0) {
      await writeConfigUpdates(context.paths.configFile, result.updates);
      context.ui.content(`Updated ${context.paths.configFile}: ${updatedKeys.join(', ')}`);
    }

    // A download always targets `<dataDir>/models/<file>` (see
    // provisionRunner.ts's download-model branch), never the path that was
    // configured before -- so the previous .bin is still sitting wherever it
    // was, up to 1.6 GB ailoud has no garbage collection for and will not
    // delete unasked. Named once, here, rather than silently orphaned.
    // `configuredModel` is the path from BEFORE this run (captured at the top
    // of this function); compared as resolved paths, not basenames, because a
    // `--force` reinstall of the SAME model name still orphans a configured
    // file that lived outside `<dataDir>/models` -- the filename matches, but
    // the file writeConfigUpdates now points at is a different one on disk.
    if (
      result.updates.model !== undefined &&
      configuredModel !== null &&
      resolve(configuredModel) !== resolve(result.updates.model)
    ) {
      context.ui.content(
        `The previous transcription model is still at ${configuredModel} -- ailoud does not ` +
          'delete it automatically; remove it by hand if you no longer need it.',
      );
    }

    // Re-read unconditionally, even when result.updates was empty: an action
    // can change what the checks see (e.g. installing a binary onto PATH)
    // without writing anything back to the config file.
    const freshConfig = await readCurrentConfig(context.paths.configFile);
    const finalChecks = await runChecks({ ...context, config: freshConfig }, platform);
    context.ui.checks(finalChecks);
    if (finalChecks.some(blocksReadiness)) {
      throw new EnvironmentError('ailoud is still not ready: see the failing checks above.');
    }

    // The very last thing a successful run does -- placed after the
    // readiness throw above, not before, so a run that failed to provision
    // cannot still end by asking about a nicety. See offerCompletions's doc
    // comment for why `command` is undefined (and this a no-op) whenever the
    // caller is `doctor --fix` rather than `setup` itself.
    if (command !== undefined) {
      await offerCompletions(context, options, interactive, command, processEnv);
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
    `ailoud ${commandName} does not provision Windows, and will not pretend to.`,
    'Install the pieces by hand -- 1 to 4 are required, 5 only for --diarize:',
    '  1. ffmpeg and ffprobe -- take a build from https://ffmpeg.org/download.html',
    '     and put both on PATH.',
    `  2. whisper.cpp -- take the Windows assets of release ${WHISPER_TAG} from`,
    '     https://github.com/ggml-org/whisper.cpp/releases and extract the tree,',
    '     keeping it intact.',
    '  3. A transcription model -- ggml-large-v3-turbo-q5_0.bin (or another',
    '     entry from the catalogue) from',
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
    '.embeddingModel if you did step 5 -- and run "ailoud doctor" to confirm. The',
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
    .option(
      '--model <name>',
      'switch to this transcription model (default: the configured one, else small)',
    )
    .option('--llm <choice>', 'summariser to set up: local, claude-cli, claude-api, openai, skip')
    .option(
      '--llm-model <id>',
      'model id for the chosen summariser (default: ask, or keep the configured one)',
    )
    .option('--force', 'reinstall even when everything checks out')
    .option('--completions', 'install shell completions at the end, without asking')
    .option('--no-completions', 'skip the shell-completions offer, without asking')
    .description('Install ffmpeg and whisper.cpp, and download the models ailoud needs')
    .action(async (options: SetupOptions, command: Command) => {
      await context.ui.frame('Setting up ailoud', async () => {
        // The win32 refusal lives in runProvisioning now (the shared
        // engine), not here -- see its doc comment. runChecks itself only
        // probes; it downloads nothing, so running it unconditionally
        // before that guard costs nothing on Windows either.
        const checks = await runChecks(context, platform);
        // `command` is this action's own Command instance, passed through so
        // a successful run can offer shell completions off the live command
        // tree -- see offerCompletions's doc comment for why only `setup`
        // passes one.
        await runProvisioning(context, options, checks, platform, 'setup', false, command);
      });
    });
}
