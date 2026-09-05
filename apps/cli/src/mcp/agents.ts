import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where a registration goes: this project only, or the whole machine. */
export type Scope = 'local' | 'global';

/**
 * How an agent's MCP configuration is written.
 *
 * One per shape actually observed, not one per agent: three agents share
 * `json-mcp-servers`, and collapsing them keeps the writer code to four cases
 * instead of six.
 */
export type ConfigFormat =
  'json-mcp-servers' | 'json-mcp-servers-tools' | 'jsonc-opencode' | 'toml-codex' | 'yaml-hermes';

export interface AgentTarget {
  readonly id: string;
  readonly label: string;
  /** Which scopes this agent supports. Some read no per-project configuration. */
  readonly scopes: readonly Scope[];
  readonly format: ConfigFormat;
  /** The MCP configuration file for a scope. */
  configPath(scope: Scope, home: string, cwd: string): string;
  /**
   * The rules file for a scope, or null when the agent reads none.
   *
   * A list, in preference order: the first that already exists is used, and
   * the first entry is created when none do. That is what keeps the block in a
   * repository's own `CLAUDE.md` instead of creating a second one under
   * `.claude/` beside it.
   */
  rulesPaths(scope: Scope, home: string, cwd: string): readonly string[];
  /** Paths whose existence means this agent is installed on this machine. */
  detectPaths(home: string): readonly string[];
  /** Printed after a successful write. Agents differ in what it takes to pick up a change. */
  readonly afterNote: string;
}

const BOTH: readonly Scope[] = ['local', 'global'];
const GLOBAL_ONLY: readonly Scope[] = ['global'];

/**
 * The agents AILoud can configure.
 *
 * Every path and every file format here was read from a working installation
 * rather than from memory: guessing an agent's configuration path writes a
 * file nothing reads, which looks exactly like a successful install.
 */
export const AGENTS: readonly AgentTarget[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    scopes: BOTH,
    format: 'json-mcp-servers',
    configPath: (scope, home, cwd) =>
      scope === 'global' ? join(home, '.claude.json') : join(cwd, '.mcp.json'),
    rulesPaths: (scope, home, cwd) =>
      scope === 'global'
        ? [join(home, '.claude', 'CLAUDE.md')]
        : [join(cwd, 'CLAUDE.md'), join(cwd, '.claude', 'CLAUDE.md')],
    detectPaths: (home) => [join(home, '.claude.json'), join(home, '.claude')],
    afterNote: 'Restart Claude Code, or run /mcp, to pick up the server.',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    scopes: BOTH,
    format: 'toml-codex',
    configPath: (scope, home, cwd) =>
      scope === 'global' ? join(home, '.codex', 'config.toml') : join(cwd, '.codex', 'config.toml'),
    rulesPaths: (scope, home, cwd) =>
      scope === 'global' ? [join(home, '.codex', 'AGENTS.md')] : [join(cwd, 'AGENTS.md')],
    detectPaths: (home) => [join(home, '.codex')],
    afterNote:
      'Codex applies a project config only in a project you have marked trusted; trust this project to activate it.',
  },
  {
    id: 'opencode',
    label: 'opencode',
    scopes: BOTH,
    format: 'jsonc-opencode',
    configPath: (scope, home, cwd) =>
      scope === 'global'
        ? join(home, '.config', 'opencode', 'opencode.jsonc')
        : join(cwd, 'opencode.jsonc'),
    rulesPaths: (scope, home, cwd) =>
      scope === 'global'
        ? [join(home, '.config', 'opencode', 'AGENTS.md')]
        : [join(cwd, 'AGENTS.md')],
    detectPaths: (home) => [join(home, '.config', 'opencode')],
    afterNote: 'Restart opencode to pick up the server.',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    scopes: BOTH,
    format: 'json-mcp-servers',
    configPath: (scope, home, cwd) =>
      scope === 'global'
        ? join(home, '.gemini', 'settings.json')
        : join(cwd, '.gemini', 'settings.json'),
    rulesPaths: (scope, home, cwd) =>
      scope === 'global' ? [join(home, '.gemini', 'GEMINI.md')] : [join(cwd, 'GEMINI.md')],
    detectPaths: (home) => [join(home, '.gemini')],
    afterNote: 'Restart the Gemini CLI to pick up the server.',
  },
  {
    id: 'hermes',
    label: 'Hermes Agent',
    // Global only: Hermes reads one configuration for the machine.
    scopes: GLOBAL_ONLY,
    format: 'yaml-hermes',
    configPath: (_scope, home) => join(home, '.hermes', 'config.yaml'),
    rulesPaths: (_scope, home) => [join(home, '.hermes', 'AGENTS.md')],
    detectPaths: (home) => [join(home, '.hermes')],
    afterNote: 'Start a new Hermes session for the change to take effect.',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    scopes: GLOBAL_ONLY,
    format: 'json-mcp-servers-tools',
    configPath: (_scope, home) => join(home, '.copilot', 'mcp-config.json'),
    rulesPaths: (_scope, home) => [join(home, '.copilot', 'copilot-instructions.md')],
    detectPaths: (home) => [join(home, '.copilot')],
    afterNote: 'Restart any running Copilot CLI session to pick up the server.',
  },
];

export function findAgent(id: string): AgentTarget | undefined {
  const wanted = id.trim().toLowerCase();
  return AGENTS.find((agent) => agent.id === wanted);
}

export function agentIds(): string {
  return AGENTS.map((agent) => agent.id).join(', ');
}

/** True when every chosen agent reads only a machine-wide configuration. */
export function globalOnly(agents: readonly AgentTarget[]): boolean {
  return agents.length > 0 && agents.every((agent) => !agent.scopes.includes('local'));
}

export function defaultHome(): string {
  return homedir();
}
