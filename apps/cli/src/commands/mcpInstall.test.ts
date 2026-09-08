import { describe, expect, it } from 'vitest';
import { findAgent } from '../mcp/agents.js';
import { allowShellAgents, directoryGrants, reportFile, resolveAllowShell } from './mcpInstall.js';
import type { AgentOutcome, FileOutcome } from '../mcp/install.js';
import type { CliContext } from '../wiring.js';

const claude = findAgent('claude')!;
const hermes = findAgent('hermes')!;

describe('allowShellAgents', () => {
  it('lists only the agents with an allow-list of their own', () => {
    expect(allowShellAgents([claude, hermes])).toEqual([claude]);
  });
});

describe('resolveAllowShell', () => {
  it('honours --allow-shell', async () => {
    expect(await resolveAllowShell({ allowShell: true }, true, [claude])).toBe(true);
  });

  it('honours --no-allow-shell without prompting', async () => {
    expect(await resolveAllowShell({ allowShell: false }, true, [claude])).toBe(false);
  });

  it('does not grant anything for -y on its own', async () => {
    // --yes means "do not prompt". Resolving an unasked permission question
    // as yes would widen an agent's privileges in CI on the strength of a
    // flag that says nothing about permissions.
    expect(await resolveAllowShell({ yes: true }, false, [claude])).toBe(false);
  });

  it('does not prompt when no chosen agent has an allow-list', async () => {
    expect(await resolveAllowShell({}, true, [hermes])).toBe(false);
  });
});

/** A context that records which channel each line went to, and nothing else. */
function uiSpy(): { calls: [string, string][]; context: CliContext } {
  const calls: [string, string][] = [];
  const push =
    (channel: string) =>
    (message: string): void => {
      calls.push([channel, message]);
    };
  const ui = { success: push('success'), warn: push('warn'), note: push('note') };
  return { calls, context: { ui } as unknown as CliContext };
}

describe('reportFile', () => {
  it('warns about a skipped allow-list, and says which refusal it was', () => {
    // `skipped` means the user asked for something and did not get it. Said
    // through `note`, it reads as "nothing needed doing" and gets scrolled
    // past -- and the reason has to be the real one, because "not valid
    // JSON" for a YAML file is a fault the user cannot find.
    const { calls, context } = uiSpy();
    reportFile(context, {
      path: '/home/ann/.codex/policy.yaml',
      action: 'skipped',
      detail: 'not valid YAML; left alone -- add the entry by hand',
    });
    expect(calls).toHaveLength(1);
    const [channel, message] = calls[0]!;
    expect(channel).toBe('warn');
    expect(message).toContain('/home/ann/.codex/policy.yaml');
    expect(message).toContain('not valid YAML');
    expect(message).not.toContain('JSON');
  });

  it('keeps the informational actions out of the warning channel', () => {
    const { calls, context } = uiSpy();
    reportFile(context, { path: '/p/.mcp.json', action: 'unchanged' });
    reportFile(context, { path: '/p/.mcp.json', action: 'created' });
    expect(calls.map(([channel]) => channel)).toEqual(['note', 'success']);
  });
});

describe('directoryGrants', () => {
  const HOME = '/home/ann';
  const CWD = '/work/repo';
  const copilot = findAgent('copilot')!;
  const file = `${HOME}/.copilot/permissions-config.json`;

  const outcome = (files: FileOutcome[]): AgentOutcome => ({
    agent: copilot,
    scope: 'global',
    files,
    note: '',
  });

  it('names the directory a Copilot grant is confined to', async () => {
    // The file is machine-wide but the entry inside it is keyed by cwd, so
    // the outcome row alone claims far more than was actually approved.
    const lines = directoryGrants([outcome([{ path: file, action: 'created' }])], HOME, CWD);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CWD);
  });

  it('says nothing when the allow-list was never written', async () => {
    expect(directoryGrants([outcome([{ path: file, action: 'skipped' }])], HOME, CWD)).toEqual([]);
    expect(directoryGrants([outcome([])], HOME, CWD)).toEqual([]);
  });

  it('says nothing for an agent whose grant is not keyed by directory', async () => {
    const claudeOutcome: AgentOutcome = {
      agent: claude,
      scope: 'local',
      files: [{ path: `${CWD}/.claude/settings.json`, action: 'created' }],
      note: '',
    };
    expect(directoryGrants([claudeOutcome], HOME, CWD)).toEqual([]);
  });
});
