import { describe, expect, it, vi } from 'vitest';
import { UsageError } from '@laud/core';
import type { Remedy } from '@laud/core';
import {
  LLM_CHOICES,
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
    expect(remediesForChoice(localRemedies, 'local')).toEqual(localRemedies);
  });

  it('drops the local install and download for a hosted engine', () => {
    // Two gigabytes of GGUF is exactly the work someone picking Claude said
    // no to.
    const kept = remediesForChoice(localRemedies, 'claude-api');
    expect(kept.map((r) => r.kind)).not.toContain('install-llm');
    expect(kept.map((r) => r.kind)).not.toContain('download-llm-model');
  });

  it('records the answer as its own remedy, so it flows through plan and consent', () => {
    expect(remediesForChoice(localRemedies, 'openai')).toContainEqual({
      kind: 'set-llm-provider',
      provider: 'openai-compatible',
    });
  });

  it('keeps every unrelated remedy', () => {
    expect(remediesForChoice(localRemedies, 'skip')).toContainEqual({ kind: 'install-ffmpeg' });
  });

  it('writes nothing at all for skip', () => {
    const kept = remediesForChoice(localRemedies, 'skip');
    expect(kept.map((r) => r.kind)).toEqual(['install-ffmpeg']);
  });

  it('can empty the plan, which is the point of skip', () => {
    expect(remediesForChoice([{ kind: 'download-llm-model' }], 'skip')).toEqual([]);
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
    expect(choice).toBe('openai');
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('rejects a bad flag before any work happens', async () => {
    await expect(
      chooseLlm({ llm: 'llamacpp', remedies: localRemedies, interactive: false }),
    ).rejects.toThrow(UsageError);
  });

  it('defaults to local with no terminal, leaving unattended runs as they were', async () => {
    const choice = await chooseLlm({ remedies: localRemedies, interactive: false });
    expect(choice).toBe('local');
  });

  it('asks nothing when no local model would be provisioned', async () => {
    const selectImpl = vi.fn();
    const choice = await chooseLlm({
      remedies: [{ kind: 'install-ffmpeg' }],
      interactive: true,
      selectImpl: selectImpl as never,
    });
    expect(choice).toBe('local');
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
    expect(choice).toBe('claude-api');
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
    ).toBe('skip');
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
