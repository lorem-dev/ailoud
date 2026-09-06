import { describe, expect, it } from 'vitest';
import { findAgent } from '../mcp/agents.js';
import { allowShellAgents, resolveAllowShell } from './mcpInstall.js';

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
