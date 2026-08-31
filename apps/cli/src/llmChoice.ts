import { select } from '@clack/prompts';
import { isCancel } from '@clack/prompts';
import { UsageError } from '@laud/core';
import type { LlmProvider, Remedy } from '@laud/core';
import { listAnthropicModels, listOpenAiModels } from '@laud/providers';
import type { ModelOption } from '@laud/providers';
import { apiKeyFrom } from './apiKey.js';
import type { CommandName } from './commands/setup.js';

/**
 * The tiers the Claude Code CLI accepts.
 *
 * Hard-coded because there is nothing to ask: the subscription route has no
 * model-listing endpoint, only `--model <alias-or-id>`. Aliases rather than
 * pinned ids on purpose -- each one follows the newest model of its tier, so
 * this list does not go stale the way a list of ids would.
 */
const CLAUDE_CLI_ALIASES: readonly ModelOption[] = [
  { id: 'opus', label: 'opus -- most capable, slowest' },
  { id: 'sonnet', label: 'sonnet -- the balanced default' },
  { id: 'haiku', label: 'haiku -- fastest, cheapest' },
];

/**
 * Which summarisation engine the user wants, as `setup` asks it.
 *
 * Not the same list as `LlmProvider`: "claude-api" maps onto the `anthropic`
 * provider, and "skip" maps onto no provider at all. The question is phrased
 * in terms of what someone is choosing between -- a local model, Claude,
 * OpenAI, or nothing yet -- rather than in terms of the adapter names, which
 * are an implementation detail of the answer.
 */
export type LlmChoice = 'local' | 'claude-cli' | 'claude-api' | 'openai' | 'skip';

/** The answer: which engine, and which model of it when one was chosen. */
export interface LlmSelection {
  readonly choice: LlmChoice;
  readonly model?: string;
}

export const LLM_CHOICES: readonly LlmChoice[] = [
  'local',
  'claude-cli',
  'claude-api',
  'openai',
  'skip',
];

/** The provider each choice writes, or null when it writes none. */
export function providerFor(choice: LlmChoice): LlmProvider | null {
  switch (choice) {
    case 'claude-cli':
      return 'claude-cli';
    case 'claude-api':
      return 'anthropic';
    case 'openai':
      return 'openai-compatible';
    case 'local':
      // Already the config default, so writing it would add a line that says
      // nothing. The local route is identified by what it installs.
      return null;
    case 'skip':
      return null;
  }
}

export function parseLlmChoice(value: string): LlmChoice {
  const match = LLM_CHOICES.find((choice) => choice === value);
  if (match === undefined) {
    throw new UsageError(`unknown --llm "${value}"; choose one of: ${LLM_CHOICES.join(', ')}`);
  }
  return match;
}

/** True when the plan would provision a local language model, which is what the question is about. */
export function planNeedsLlmChoice(remedies: readonly Remedy[]): boolean {
  return remedies.some(
    (remedy) => remedy.kind === 'install-llm' || remedy.kind === 'download-llm-model',
  );
}

export interface LlmChoiceOptions {
  readonly llm?: string;
  readonly llmModel?: string;
  readonly remedies: readonly Remedy[];
  readonly interactive: boolean;
  readonly selectImpl?: typeof select;
  readonly commandName?: CommandName;
  /** For reading the API key the model list needs. Injected so a test can pin it. */
  readonly env?: NodeJS.ProcessEnv;
  /** Overridable so a test never reaches the network. */
  readonly listModels?: (
    choice: LlmChoice,
    env: NodeJS.ProcessEnv,
  ) => Promise<readonly ModelOption[]>;
  /** Where a "could not list models" note goes. Silent when absent. */
  readonly note?: (message: string) => void;
}

/**
 * The models a choice can offer, asked of the provider itself.
 *
 * Both hosted APIs will only answer with a key, so this returns an empty list
 * when there is none -- and the caller then leaves the configured default
 * alone rather than inventing a list. A built-in list was the alternative and
 * is worse: it is stale the day a vendor ships anything.
 */
export async function modelsFor(
  choice: LlmChoice,
  env: NodeJS.ProcessEnv,
): Promise<readonly ModelOption[]> {
  if (choice === 'claude-cli') return CLAUDE_CLI_ALIASES;
  if (choice === 'claude-api') {
    const key = apiKeyFrom(env, 'ANTHROPIC_API_KEY');
    if (key === undefined) return [];
    return listAnthropicModels('https://api.anthropic.com/v1', key);
  }
  if (choice === 'openai') {
    const key = apiKeyFrom(env, 'OPENAI_API_KEY');
    if (key === undefined) return [];
    return listOpenAiModels('https://api.openai.com/v1', key);
  }
  return [];
}

/** Which environment variable a choice needs before its models can be listed. */
function keyVariable(choice: LlmChoice): string | null {
  if (choice === 'claude-api') return 'ANTHROPIC_API_KEY';
  if (choice === 'openai') return 'OPENAI_API_KEY';
  return null;
}

/**
 * Resolves which engine to set up, asking only when the answer will be used.
 *
 * Two prompts rather than one for Claude: it is reachable by subscription and
 * by API key, and guessing from whether the CLI happens to be installed would
 * quietly pick the billable route for someone who has both.
 *
 * The default without a terminal is `local`, which is what `setup` did before
 * this question existed -- an unattended run must not change behaviour just
 * because an interactive one gained a choice.
 */
export async function chooseLlm(options: LlmChoiceOptions): Promise<LlmSelection> {
  const withModel = (choice: LlmChoice, model?: string): LlmSelection =>
    model === undefined ? { choice } : { choice, model };

  if (options.llm !== undefined) {
    const choice = parseLlmChoice(options.llm);
    // Taken verbatim, never checked against the live list: validating it would
    // put a network call in the middle of every unattended run, and an id the
    // provider does not know is rejected at the first summary with its own
    // message, which is clearer than anything guessed here.
    return withModel(choice, options.llmModel);
  }
  if (!options.interactive || !planNeedsLlmChoice(options.remedies)) {
    return withModel('local', options.llmModel);
  }

  const selectImpl = options.selectImpl ?? select;
  const cancelled = (): never => {
    throw new UsageError(`${options.commandName ?? 'setup'} cancelled`);
  };

  const engine = await selectImpl({
    message: 'Which language model should laud use to summarise?',
    initialValue: 'local',
    options: [
      {
        value: 'local',
        label: 'llama.cpp with Qwen2.5-3B (2.1 GB download)',
        hint: 'runs on this machine, nothing leaves it',
      },
      { value: 'claude', label: 'Claude', hint: 'by subscription or by API key' },
      { value: 'openai', label: 'OpenAI', hint: 'needs an API key' },
      {
        value: 'skip',
        label: 'Skip for now',
        hint: 'summarize stays unavailable until configured',
      },
    ],
  });
  if (isCancel(engine)) cancelled();
  if (String(engine) !== 'claude') {
    const choice = parseLlmChoice(String(engine));
    return withModel(choice, await chooseModelId(choice, options, cancelled));
  }

  const route = await selectImpl({
    message: 'How should laud reach Claude?',
    initialValue: 'claude-cli',
    options: [
      {
        value: 'claude-cli',
        label: 'Through the Claude Code CLI',
        hint: 'uses your subscription; no API key needed',
      },
      { value: 'claude-api', label: "Through Anthropic's API", hint: 'needs ANTHROPIC_API_KEY' },
    ],
  });
  if (isCancel(route)) cancelled();
  const choice = parseLlmChoice(String(route));
  return withModel(choice, await chooseModelId(choice, options, cancelled));
}

/**
 * Which model of the chosen engine, asked of the engine.
 *
 * Returns undefined -- leaving whatever the config already says -- whenever
 * there is nothing to choose from: the local route has no list, and the hosted
 * ones cannot be listed without a key. That case is announced rather than
 * passed over silently, because "laud picked a model for me and did not say
 * which" is the confusing outcome.
 */
async function chooseModelId(
  choice: LlmChoice,
  options: LlmChoiceOptions,
  cancelled: () => never,
): Promise<string | undefined> {
  if (choice === 'local' || choice === 'skip') return undefined;

  const env = options.env ?? process.env;
  const list = options.listModels ?? modelsFor;
  let models: readonly ModelOption[];
  try {
    models = await list(choice, env);
  } catch (error) {
    // A failed listing must not sink the whole run: everything else in the
    // plan is still worth doing, and the configured default still works.
    options.note?.(
      `Could not ask for the model list (${
        error instanceof Error ? error.message : String(error)
      }); keeping the configured model.`,
    );
    return undefined;
  }

  if (models.length === 0) {
    const variable = keyVariable(choice);
    options.note?.(
      variable === null
        ? 'No models to choose from; keeping the configured model.'
        : `${variable} is not set, so laud cannot ask which models you can use. ` +
            'Keeping the configured model -- set the key and re-run to choose one.',
    );
    return undefined;
  }

  const answer = await (options.selectImpl ?? select)({
    message: 'Which model should laud use?',
    initialValue: models[0]!.id,
    options: models.map((model) => ({ value: model.id, label: model.label })),
  });
  if (isCancel(answer)) cancelled();
  return String(answer);
}

/**
 * The remedies to act on once the choice is known.
 *
 * Anything but `local` drops the local install and download -- provisioning a
 * two-gigabyte model for someone who picked a hosted engine is exactly the
 * work they said no to -- and adds the one remedy that records the answer.
 */
export function remediesForChoice(
  remedies: readonly Remedy[],
  selection: LlmSelection,
): readonly Remedy[] {
  if (selection.choice === 'local') return remedies;
  const kept = remedies.filter(
    (remedy) => remedy.kind !== 'install-llm' && remedy.kind !== 'download-llm-model',
  );
  const provider = providerFor(selection.choice);
  if (provider === null) return kept;
  return [
    ...kept,
    {
      kind: 'set-llm-provider',
      provider,
      ...(selection.model === undefined ? {} : { model: selection.model }),
    },
  ];
}
