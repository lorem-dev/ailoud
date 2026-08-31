import { describe, expect, it, vi } from 'vitest';
import { UsageError } from '@laud/core';
import type { Remedy } from '@laud/core';
import {
  LLM_CHOICES,
  modelsFor,
  chooseLlm,
  parseLlmChoice,
  planNeedsLlmChoice,
  providerFor,
  remediesForChoice,
} from './llmChoice.js';

// Hoisted: vi.mock's factory runs before the module body, so a plain const
// here is not initialised yet when llmChoice.ts imports @clack/prompts.
// Every test that cares passes its own selectImpl, which takes precedence.
const clack = vi.hoisted(() => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}));

vi.mock('@clack/prompts', () => clack);

const localRemedies: readonly Remedy[] = [
  { kind: 'install-ffmpeg' },
  { kind: 'install-llm' },
  { kind: 'download-llm-model' },
];

describe('parseLlmChoice', () => {
  it('accepts every offered choice', () => {
    for (const choice of LLM_CHOICES) expect(parseLlmChoice(choice)).toBe(choice);
  });

  it('refuses an unknown value and lists the real ones', () => {
    expect(() => parseLlmChoice('gemini')).toThrow(UsageError);
    expect(() => parseLlmChoice('gemini')).toThrow(/gemini/);
    expect(() => parseLlmChoice('gemini')).toThrow(/claude-cli/);
  });

  it('does not accept a provider id in place of a choice', () => {
    // "anthropic" is what gets written to the config, not what the user picks.
    expect(() => parseLlmChoice('anthropic')).toThrow(UsageError);
  });
});

describe('providerFor', () => {
  it('maps each hosted choice onto its adapter', () => {
    expect(providerFor('claude-cli')).toBe('claude-cli');
    expect(providerFor('claude-api')).toBe('anthropic');
    expect(providerFor('openai')).toBe('openai-compatible');
  });

  it('writes nothing for local, which is already the default', () => {
    expect(providerFor('local')).toBeNull();
    expect(providerFor('skip')).toBeNull();
  });
});

describe('planNeedsLlmChoice', () => {
  it('is true when the plan would provision a local model', () => {
    expect(planNeedsLlmChoice([{ kind: 'download-llm-model' }])).toBe(true);
    expect(planNeedsLlmChoice([{ kind: 'install-llm' }])).toBe(true);
  });

  it('is false when the language model is already sorted', () => {
    // Nothing to ask: whatever they configured is working, and interrupting a
    // run to re-ask a settled question is the bug chooseModel already avoids.
    expect(planNeedsLlmChoice([{ kind: 'install-ffmpeg' }])).toBe(false);
  });
});

describe('remediesForChoice', () => {
  it('leaves the plan alone for the local choice', () => {
    expect(remediesForChoice(localRemedies, { choice: 'local' })).toEqual(localRemedies);
  });

  it('drops the local install and download for a hosted engine', () => {
    // Two gigabytes of GGUF is exactly the work someone picking Claude said
    // no to.
    const kept = remediesForChoice(localRemedies, { choice: 'claude-api' });
    expect(kept.map((r) => r.kind)).not.toContain('install-llm');
    expect(kept.map((r) => r.kind)).not.toContain('download-llm-model');
  });

  it('records the answer as its own remedy, so it flows through plan and consent', () => {
    expect(remediesForChoice(localRemedies, { choice: 'openai' })).toContainEqual({
      kind: 'set-llm-provider',
      provider: 'openai-compatible',
    });
  });

  it('keeps every unrelated remedy', () => {
    expect(remediesForChoice(localRemedies, { choice: 'skip' })).toContainEqual({
      kind: 'install-ffmpeg',
    });
  });

  it('writes nothing at all for skip', () => {
    const kept = remediesForChoice(localRemedies, { choice: 'skip' });
    expect(kept.map((r) => r.kind)).toEqual(['install-ffmpeg']);
  });

  it('can empty the plan, which is the point of skip', () => {
    expect(remediesForChoice([{ kind: 'download-llm-model' }], { choice: 'skip' })).toEqual([]);
  });
});

describe('chooseLlm', () => {
  it('takes the flag without asking anything', async () => {
    const selectImpl = vi.fn();
    const choice = await chooseLlm({
      llm: 'openai',
      remedies: localRemedies,
      interactive: true,
      selectImpl: selectImpl as never,
    });
    expect(choice).toEqual({ choice: 'openai' });
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('rejects a bad flag before any work happens', async () => {
    await expect(
      chooseLlm({ llm: 'llamacpp', remedies: localRemedies, interactive: false }),
    ).rejects.toThrow(UsageError);
  });

  it('defaults to local with no terminal, leaving unattended runs as they were', async () => {
    const choice = await chooseLlm({ remedies: localRemedies, interactive: false });
    expect(choice).toEqual({ choice: 'local' });
  });

  it('asks nothing when no local model would be provisioned', async () => {
    const selectImpl = vi.fn();
    const choice = await chooseLlm({
      remedies: [{ kind: 'install-ffmpeg' }],
      interactive: true,
      selectImpl: selectImpl as never,
    });
    expect(choice).toEqual({ choice: 'local' });
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('asks a second question for Claude, rather than guessing the billable route', async () => {
    // Someone with both a subscription and a key must not be silently put on
    // the one that costs money.
    const selectImpl = vi.fn().mockResolvedValueOnce('claude').mockResolvedValueOnce('claude-api');
    const choice = await chooseLlm({
      remedies: localRemedies,
      interactive: true,
      selectImpl: selectImpl as never,
    });
    expect(choice.choice).toBe('claude-api');
    expect(selectImpl).toHaveBeenCalledTimes(2);
  });

  it('asks only once for the choices that need no follow-up', async () => {
    const selectImpl = vi.fn().mockResolvedValue('skip');
    expect(
      await chooseLlm({
        remedies: localRemedies,
        interactive: true,
        selectImpl: selectImpl as never,
      }),
    ).toEqual({ choice: 'skip' });
    expect(selectImpl).toHaveBeenCalledTimes(1);
  });

  it('names the command the user typed when they cancel', async () => {
    // Reachable from `doctor --fix` too, so the message must not default to
    // naming the other caller. mockReturnValueOnce reverts afterwards, so the
    // cancel cannot leak into another test in this file.
    clack.isCancel.mockReturnValueOnce(true);
    const selectImpl = vi.fn().mockResolvedValue('local');
    await expect(
      chooseLlm({
        remedies: localRemedies,
        interactive: true,
        selectImpl: selectImpl as never,
        commandName: 'doctor',
      }),
    ).rejects.toThrow(/doctor cancelled/);
  });

  it('does not fall through to the second question when the first is cancelled', async () => {
    clack.isCancel.mockReturnValueOnce(true);
    const selectImpl = vi.fn().mockResolvedValue('claude');
    await expect(
      chooseLlm({ remedies: localRemedies, interactive: true, selectImpl: selectImpl as never }),
    ).rejects.toThrow(UsageError);
    expect(selectImpl).toHaveBeenCalledTimes(1);
  });
});

describe('choosing a model of the chosen engine', () => {
  const twoModels = async () => [
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  ];

  it('asks the provider, and writes what was picked', async () => {
    const selectImpl = vi
      .fn()
      .mockResolvedValueOnce('claude')
      .mockResolvedValueOnce('claude-api')
      .mockResolvedValueOnce('claude-opus-5');
    const selection = await chooseLlm({
      remedies: localRemedies,
      interactive: true,
      selectImpl: selectImpl as never,
      listModels: twoModels,
    });
    expect(selection).toEqual({ choice: 'claude-api', model: 'claude-opus-5' });
  });

  it('shows the vendor label but stores the id', async () => {
    const selectImpl = vi.fn().mockResolvedValueOnce('openai').mockResolvedValueOnce('gpt-5');
    await chooseLlm({
      remedies: localRemedies,
      interactive: true,
      selectImpl: selectImpl as never,
      listModels: async () => [{ id: 'gpt-5', label: 'GPT-5 (newest)' }],
    });
    const shown = selectImpl.mock.calls[1]![0] as { options: { value: string; label: string }[] };
    expect(shown.options[0]).toEqual({ value: 'gpt-5', label: 'GPT-5 (newest)' });
  });

  it('says why it could not ask, instead of picking silently', async () => {
    // "laud chose a model for me and did not say which" is the confusing
    // outcome; an unlistable provider has to be announced.
    const notes: string[] = [];
    const selectImpl = vi.fn().mockResolvedValueOnce('openai');
    const selection = await chooseLlm({
      remedies: localRemedies,
      interactive: true,
      selectImpl: selectImpl as never,
      listModels: async () => [],
      note: (message) => notes.push(message),
    });
    expect(selection).toEqual({ choice: 'openai' });
    expect(notes.join('\n')).toContain('OPENAI_API_KEY');
    expect(selectImpl).toHaveBeenCalledTimes(1);
  });

  it('survives a listing that throws, keeping the rest of the plan', async () => {
    const notes: string[] = [];
    const selectImpl = vi.fn().mockResolvedValueOnce('openai');
    const selection = await chooseLlm({
      remedies: localRemedies,
      interactive: true,
      selectImpl: selectImpl as never,
      listModels: async () => {
        throw new Error('HTTP 401');
      },
      note: (message) => notes.push(message),
    });
    expect(selection).toEqual({ choice: 'openai' });
    expect(notes.join('\n')).toContain('401');
  });

  it('never asks for a model on the routes that have none', async () => {
    const listModels = vi.fn(async () => []);
    for (const answer of ['local', 'skip']) {
      const selectImpl = vi.fn().mockResolvedValueOnce(answer);
      await chooseLlm({
        remedies: localRemedies,
        interactive: true,
        selectImpl: selectImpl as never,
        listModels,
      });
      expect(selectImpl, answer).toHaveBeenCalledTimes(1);
    }
    expect(listModels).not.toHaveBeenCalled();
  });

  it('takes --llm-model verbatim, with no network call', async () => {
    // Validating it would put a request in the middle of every unattended
    // run; an unknown id is rejected at the first summary with its own message.
    const listModels = vi.fn(async () => []);
    const selection = await chooseLlm({
      llm: 'openai',
      llmModel: 'gpt-9-experimental',
      remedies: localRemedies,
      interactive: true,
      listModels,
    });
    expect(selection).toEqual({ choice: 'openai', model: 'gpt-9-experimental' });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('carries the model into the remedy the plan acts on', () => {
    expect(remediesForChoice([], { choice: 'claude-api', model: 'claude-opus-5' })).toContainEqual({
      kind: 'set-llm-provider',
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
  });

  it('omits the model from the remedy when none was chosen', () => {
    expect(remediesForChoice([], { choice: 'openai' })).toContainEqual({
      kind: 'set-llm-provider',
      provider: 'openai-compatible',
    });
  });
});

describe('modelsFor', () => {
  it('offers the Claude Code tiers as aliases, which do not go stale', async () => {
    // The subscription route has no listing endpoint, and an alias follows
    // the newest model of its tier.
    const ids = (await modelsFor('claude-cli', {})).map((m) => m.id);
    expect(ids).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('returns nothing for a hosted provider with no key, rather than reaching out', async () => {
    expect(await modelsFor('claude-api', {})).toEqual([]);
    expect(await modelsFor('openai', {})).toEqual([]);
  });

  it('has nothing to offer for the local model or for skipping', async () => {
    expect(await modelsFor('local', {})).toEqual([]);
    expect(await modelsFor('skip', {})).toEqual([]);
  });
});
