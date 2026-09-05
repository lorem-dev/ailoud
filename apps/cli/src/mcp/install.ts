import { dirname, join } from 'node:path';
import type { Fs } from '@ailoud/core';
import { PROJECT_DIR } from '../config.js';
import { addServer, hasServer, isEmptyConfig, removeServer } from './agentConfig.js';
import type { AgentTarget, Scope } from './agents.js';
import { hasBlock, withBlock, withoutBlock } from './rulesBlock.js';

/** What happened to one file, for the report a command prints. */
export interface FileOutcome {
  readonly path: string;
  readonly action: 'created' | 'updated' | 'unchanged' | 'removed' | 'cleaned' | 'absent';
}

export interface AgentOutcome {
  readonly agent: AgentTarget;
  readonly scope: Scope;
  readonly files: readonly FileOutcome[];
  readonly note: string;
}

/** Whether this agent looks installed on this machine. */
export async function detect(fs: Fs, agent: AgentTarget, home: string): Promise<boolean> {
  for (const path of agent.detectPaths(home)) {
    if (await fs.exists(path)) return true;
  }
  return false;
}

/**
 * The rules file to write for a scope: the first that exists, else the first
 * listed.
 *
 * Preference order matters for Claude Code, which reads both a repository's
 * own `CLAUDE.md` and a `.claude/CLAUDE.md` beside it. Appending to the one
 * that already exists keeps a project's instructions in one file; creating
 * `.claude/CLAUDE.md` next to an existing `CLAUDE.md` would split them.
 */
export async function chooseRulesFile(
  fs: Fs,
  agent: AgentTarget,
  scope: Scope,
  home: string,
  cwd: string,
): Promise<string | null> {
  const candidates = agent.rulesPaths(scope, home, cwd);
  if (candidates.length === 0) return null;
  for (const path of candidates) {
    if (await fs.exists(path)) return path;
  }
  return candidates[0] ?? null;
}

async function readIfPresent(fs: Fs, path: string): Promise<string | null> {
  return (await fs.exists(path)) ? fs.readTextFile(path) : null;
}

async function write(fs: Fs, path: string, content: string): Promise<void> {
  await fs.ensureDir(dirname(path));
  await fs.writeTextFile(path, content);
}

/**
 * Registers AILoud with one agent, in one scope.
 *
 * Both files are written: the MCP configuration, which is what makes the tools
 * reachable, and the rules block, which is what makes the agent use them well.
 * Either alone is half the feature -- an agent with the tools and no guidance
 * reads whole transcripts into its context.
 */
export async function install(
  fs: Fs,
  agent: AgentTarget,
  scope: Scope,
  home: string,
  cwd: string,
): Promise<AgentOutcome> {
  const files: FileOutcome[] = [];

  const configPath = agent.configPath(scope, home, cwd);
  const before = await readIfPresent(fs, configPath);
  const after = addServer(agent.format, before);
  if (before === null) {
    await write(fs, configPath, after);
    files.push({ path: configPath, action: 'created' });
  } else if (before !== after) {
    await write(fs, configPath, after);
    files.push({ path: configPath, action: 'updated' });
  } else {
    files.push({ path: configPath, action: 'unchanged' });
  }

  const rulesPath = await chooseRulesFile(fs, agent, scope, home, cwd);
  if (rulesPath !== null) {
    const rulesBefore = await readIfPresent(fs, rulesPath);
    const rulesAfter = withBlock(rulesBefore ?? '');
    if (rulesBefore === null) {
      await write(fs, rulesPath, rulesAfter);
      files.push({ path: rulesPath, action: 'created' });
    } else if (rulesBefore !== rulesAfter) {
      await write(fs, rulesPath, rulesAfter);
      files.push({ path: rulesPath, action: 'updated' });
    } else {
      files.push({ path: rulesPath, action: 'unchanged' });
    }
  }

  return { agent, scope, files, note: agent.afterNote };
}

/**
 * Removes AILoud from one agent, in one scope.
 *
 * A file AILoud created and nothing else has touched is deleted rather than
 * left holding `{}`; a file with anything else in it is edited. That is the
 * difference between undoing an install and vandalising a configuration.
 */
export async function uninstall(
  fs: Fs,
  agent: AgentTarget,
  scope: Scope,
  home: string,
  cwd: string,
): Promise<AgentOutcome> {
  const files: FileOutcome[] = [];

  const configPath = agent.configPath(scope, home, cwd);
  const before = await readIfPresent(fs, configPath);
  if (before === null) {
    files.push({ path: configPath, action: 'absent' });
  } else {
    const after = removeServer(agent.format, before);
    if (after === null) {
      files.push({ path: configPath, action: 'unchanged' });
    } else if (isEmptyConfig(agent.format, after)) {
      await fs.removeFile(configPath);
      files.push({ path: configPath, action: 'removed' });
    } else {
      await write(fs, configPath, after);
      files.push({ path: configPath, action: 'cleaned' });
    }
  }

  // Every candidate, not only the chosen one: an earlier install may have
  // written into a different file, and leaving that block behind would keep
  // telling the agent about tools it no longer has.
  for (const rulesPath of agent.rulesPaths(scope, home, cwd)) {
    const rulesBefore = await readIfPresent(fs, rulesPath);
    if (rulesBefore === null) continue;
    const rulesAfter = withoutBlock(rulesBefore);
    if (rulesAfter === null) {
      files.push({ path: rulesPath, action: 'unchanged' });
    } else if (rulesAfter.trim() === '') {
      await fs.removeFile(rulesPath);
      files.push({ path: rulesPath, action: 'removed' });
    } else {
      await write(fs, rulesPath, rulesAfter);
      files.push({ path: rulesPath, action: 'cleaned' });
    }
  }

  return { agent, scope, files, note: agent.afterNote };
}

/**
 * Rewrites what a previous install put in place, for agents already
 * configured, and touches nothing else.
 *
 * The point of a separate verb: `update` after upgrading AILoud should refresh
 * the rules block wherever it already is, without quietly adding the server to
 * an agent the user never chose.
 */
export async function update(
  fs: Fs,
  agent: AgentTarget,
  scope: Scope,
  home: string,
  cwd: string,
): Promise<AgentOutcome | null> {
  const configPath = agent.configPath(scope, home, cwd);
  const config = await readIfPresent(fs, configPath);
  const configured = config !== null && hasServer(agent.format, config);

  let rulesConfigured = false;
  for (const path of agent.rulesPaths(scope, home, cwd)) {
    const text = await readIfPresent(fs, path);
    if (text !== null && hasBlock(text)) rulesConfigured = true;
  }

  if (!configured && !rulesConfigured) return null;
  return install(fs, agent, scope, home, cwd);
}

/**
 * The per-project library directory, with the .gitignore that keeps it out of
 * git.
 *
 * The recordings, the database and the media copies are machine-local and
 * often large; a repository that committed them would grow without bound. The
 * directory itself is worth committing, though -- its presence is what tells
 * AILoud this project has its own library -- so the ignore file excludes
 * everything except itself, exactly as `.codegraph/.gitignore` does.
 */
export const PROJECT_GITIGNORE = [
  '# AILoud library -- local to each machine, not for committing.',
  '# Ignore everything in .ailoud/ except this file itself, so the database,',
  '# the media copies and any scratch file never show up in git.',
  '*',
  '!.gitignore',
  '',
].join('\n');

export async function ensureProjectLibrary(fs: Fs, cwd: string): Promise<FileOutcome> {
  const dir = join(cwd, PROJECT_DIR);
  const ignore = join(dir, '.gitignore');
  await fs.ensureDir(dir);
  // Never rewritten once it exists: the user may have added a rule of their
  // own, and the directory works either way. (Both branches of an earlier
  // version returned the same thing, so the read and the comparison were pure
  // cost.)
  if (await fs.exists(ignore)) return { path: dir, action: 'unchanged' };
  await fs.writeTextFile(ignore, PROJECT_GITIGNORE);
  return { path: dir, action: 'created' };
}
