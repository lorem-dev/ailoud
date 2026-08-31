import { select } from '@clack/prompts';
import { isCancel } from '@clack/prompts';
import { UsageError } from '@laud/core';
import type { LlmProvider, Remedy } from '@laud/core';
import type { CommandName } from './commands/setup.js';

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
  readonly remedies: readonly Remedy[];
  readonly interactive: boolean;
  readonly selectImpl?: typeof select;
  readonly commandName?: CommandName;
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
export async function chooseLlm(options: LlmChoiceOptions): Promise<LlmChoice> {
  if (options.llm !== undefined) return parseLlmChoice(options.llm);
  if (!options.interactive || !planNeedsLlmChoice(options.remedies)) return 'local';

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
  if (String(engine) !== 'claude') return parseLlmChoice(String(engine));

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
  return parseLlmChoice(String(route));
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
  choice: LlmChoice,
): readonly Remedy[] {
  if (choice === 'local') return remedies;
  const kept = remedies.filter(
    (remedy) => remedy.kind !== 'install-llm' && remedy.kind !== 'download-llm-model',
  );
  const provider = providerFor(choice);
  return provider === null ? kept : [...kept, { kind: 'set-llm-provider', provider }];
}
