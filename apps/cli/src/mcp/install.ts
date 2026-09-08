import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Fs } from '@ailoud/core';
import { PROJECT_DIR } from '../config.js';
import { addServer, hasServer, isEmptyConfig, removeServer } from './agentConfig.js';
import type { AgentTarget, Scope } from './agents.js';
import { addPermission, describeRefusal, hasPermission, removePermission } from './permissions.js';
import { hasBlock, withBlock, withoutBlock } from './rulesBlock.js';

/** What happened to one file, for the report a command prints. */
export interface FileOutcome {
  readonly path: string;
  /**
   * `skipped` is the allow-list writer declining to rewrite a settings file
   * it will not touch safely. Distinct from `unchanged`, which means nothing
   * needed doing: this one means the user asked for something and did not get
   * it. `detail` below says which refusal it was.
   */
  readonly action:
    'created' | 'updated' | 'unchanged' | 'removed' | 'cleaned' | 'absent' | 'skipped';
  /**
   * Why, for an action that does not say on its own. Only `skipped` carries
   * one: the reasons the allow-list writer declines are different problems
   * with different fixes, and one catch-all sentence sent users looking for
   * a fault their file did not have.
   */
  readonly detail?: string;
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

async function readIfPresent(fs: Fs, path: string): Promise<string | null> {
  return (await fs.exists(path)) ? fs.readTextFile(path) : null;
}

/**
 * The rules files to write for a scope.
 *
 * Every candidate that already carries the block, or the first candidate when
 * none does.
 *
 * Claude Code reads both a repository's own `CLAUDE.md` and a
 * `.claude/CLAUDE.md` beside it, which makes both halves of that rule
 * load-bearing. Writing to both on a fresh install would put the same
 * instructions in the agent's context twice; writing to only the preferred one
 * when an earlier install left a block in the other would leave that copy to
 * go stale and keep telling the agent about tools it no longer has.
 */
export async function rulesTargets(
  fs: Fs,
  agent: AgentTarget,
  scope: Scope,
  home: string,
  cwd: string,
): Promise<readonly string[]> {
  const candidates = agent.rulesPaths(scope, home, cwd);
  if (candidates.length === 0) return [];
  const carrying: string[] = [];
  for (const path of candidates) {
    const text = await readIfPresent(fs, path);
    if (text !== null && hasBlock(text)) carrying.push(path);
  }
  return carrying.length > 0 ? carrying : [candidates[0]!];
}

/**
 * Writes a file without ever leaving it half-written: a temporary file beside
 * it, then a rename over the top.
 *
 * `writeTextFile` truncates before it writes, so a failure part-way through --
 * ENOSPC is the realistic one -- leaves the target EMPTY. That was survivable
 * while these files were only touched by an interactive `mcp install` the user
 * was watching. It is not survivable now: `self sync` sweeps this writer
 * across every registered project unattended, and the file it rewrites is
 * often a repository's own hand-written `CLAUDE.md` or `AGENTS.md`. Truncating
 * one of those and then reporting `failed` destroys the user's content while
 * telling them nothing happened.
 *
 * Same pattern as `writeRegistry` in `apps/cli/src/projects.ts`, and for the
 * same reason. The temporary name is randomised so two concurrent writers
 * cannot corrupt each other's, and it sits in the target's own directory so
 * the rename stays on one filesystem and therefore stays atomic.
 */
async function write(fs: Fs, path: string, content: string): Promise<void> {
  await fs.ensureDir(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeTextFile(temp, content);
  } catch (error) {
    // The target has not been touched yet, so there is nothing to undo. Clear
    // the partial temporary file rather than leaving litter beside a config.
    await fs.removeFile(temp);
    throw error;
  }
  await fs.rename(temp, path);
}

/**
 * Writes the agent's command allow-list, when it has one and was asked for.
 *
 * Returns nothing to report for an agent with no allow-list, rather than a
 * row saying so for every agent on every run.
 */
async function writePermission(
  fs: Fs,
  agent: AgentTarget,
  scope: Scope,
  home: string,
  cwd: string,
): Promise<FileOutcome | null> {
  if (agent.permission === undefined) return null;
  const path = agent.permission.path(scope, home, cwd);
  const before = await readIfPresent(fs, path);
  const edit = addPermission(agent.permission.format, before, cwd);
  if (!edit.ok) {
    return {
      path,
      action: 'skipped',
      detail: describeRefusal(agent.permission.format, edit.reason),
    };
  }
  const after = edit.text;
  if (before === null) {
    await write(fs, path, after);
    return { path, action: 'created' };
  }
  if (before === after) return { path, action: 'unchanged' };
  await write(fs, path, after);
  return { path, action: 'updated' };
}

/**
 * Registers AILoud with one agent, in one scope.
 *
 * Both files are written: the MCP configuration, which is what makes the tools
 * reachable, and the rules block, which is what makes the agent use them well.
 * Either alone is half the feature -- an agent with the tools and no guidance
 * reads whole transcripts into its context. A third, the command allow-list,
 * is written only when `allowShell` says the user asked for it.
 */
export async function install(
  fs: Fs,
  agent: AgentTarget,
  scope: Scope,
  home: string,
  cwd: string,
  allowShell: boolean,
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

  for (const rulesPath of await rulesTargets(fs, agent, scope, home, cwd)) {
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

  if (allowShell) {
    const permission = await writePermission(fs, agent, scope, home, cwd);
    if (permission !== null) files.push(permission);
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

  // Symmetric with install, and unconditional: an uninstall that left a
  // standing permission for a command the user just removed would be a
  // privilege nobody can see the reason for any more.
  if (agent.permission !== undefined) {
    const path = agent.permission.path(scope, home, cwd);
    const before = await readIfPresent(fs, path);
    if (before === null) {
      files.push({ path, action: 'absent' });
    } else {
      const after = removePermission(agent.permission.format, before, cwd);
      if (after === null) {
        files.push({ path, action: 'unchanged' });
      } else if (after === '') {
        // Decided here rather than left to the `isEmptyConfig` check above:
        // for opencode and Gemini this IS the MCP configuration file, and
        // that check ran first, while our permission keys were still in it.
        // It therefore saw a file with settings in and kept it -- so an
        // install that used the allow-list left `{}` behind where one that
        // did not deleted the file outright.
        await fs.removeFile(path);
        files.push({ path, action: 'removed' });
      } else {
        await write(fs, path, after);
        files.push({ path, action: 'cleaned' });
      }
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

  // The allow-list is refreshed where it already is and never created here.
  // `self sync` sweeps this across every registered project unattended, and
  // widening an agent's privileges without being asked is the one thing that
  // sweep must not do.
  let allowShell = false;
  if (agent.permission !== undefined) {
    const text = await readIfPresent(fs, agent.permission.path(scope, home, cwd));
    allowShell = text !== null && hasPermission(agent.permission.format, text, cwd);
  }

  if (!configured && !rulesConfigured) return null;
  return install(fs, agent, scope, home, cwd, allowShell);
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
