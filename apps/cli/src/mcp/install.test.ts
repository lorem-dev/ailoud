import { describe, expect, it } from 'vitest';
import { MemFs } from '@ailoud/core/testing';
import { findAgent } from './agents.js';
import {
  PROJECT_GITIGNORE,
  chooseRulesFile,
  detect,
  ensureProjectLibrary,
  install,
  uninstall,
  update,
} from './install.js';
import { START } from './rulesBlock.js';

const HOME = '/home/ann';
const CWD = '/work/repo';
const claude = findAgent('claude')!;
const hermes = findAgent('hermes')!;

const actions = (files: readonly { path: string; action: string }[]) =>
  Object.fromEntries(files.map((file) => [file.path, file.action]));

describe('detect', () => {
  it('reports an agent installed when any of its paths exists', async () => {
    const fs = new MemFs({});
    expect(await detect(fs, claude, HOME)).toBe(false);
    await fs.ensureDir(`${HOME}/.claude`);
    expect(await detect(fs, claude, HOME)).toBe(true);
  });
});

describe('chooseRulesFile', () => {
  it('prefers a rules file that already exists', async () => {
    // Claude Code reads both CLAUDE.md and .claude/CLAUDE.md; creating the
    // second beside an existing first would split a project's instructions.
    const fs = new MemFs({});
    await fs.writeTextFile(`${CWD}/CLAUDE.md`, '# P');
    expect(await chooseRulesFile(fs, claude, 'local', HOME, CWD)).toBe(`${CWD}/CLAUDE.md`);
  });

  it('falls back to the first candidate when none exists', async () => {
    const fs = new MemFs({});
    expect(await chooseRulesFile(fs, claude, 'local', HOME, CWD)).toBe(`${CWD}/CLAUDE.md`);
  });
});

describe('install', () => {
  it('writes both the config and the rules, because either alone is half the feature', async () => {
    const fs = new MemFs({});
    const outcome = await install(fs, claude, 'local', HOME, CWD);
    const byPath = actions(outcome.files);
    expect(byPath[`${CWD}/.mcp.json`]).toBe('created');
    expect(byPath[`${CWD}/CLAUDE.md`]).toBe('created');
    expect(await fs.readTextFile(`${CWD}/.mcp.json`)).toContain('ailoud');
    expect(await fs.readTextFile(`${CWD}/CLAUDE.md`)).toContain(START);
  });

  it('reports unchanged on a second run rather than claiming a write', async () => {
    const fs = new MemFs({});
    await install(fs, claude, 'local', HOME, CWD);
    const second = await install(fs, claude, 'local', HOME, CWD);
    expect(Object.values(actions(second.files))).toEqual(['unchanged', 'unchanged']);
  });

  it('carries the note that says what it takes to pick up the change', async () => {
    const fs = new MemFs({});
    const outcome = await install(fs, claude, 'local', HOME, CWD);
    expect(outcome.note).toMatch(/Restart Claude Code/);
  });

  it('writes a global-only agent into the home directory', async () => {
    const fs = new MemFs({});
    const outcome = await install(fs, hermes, 'global', HOME, CWD);
    expect(Object.keys(actions(outcome.files))[0]).toContain(`${HOME}/.hermes`);
  });
});

describe('uninstall', () => {
  it('deletes a file it created and edits one the user owns', async () => {
    const fs = new MemFs({});
    await fs.writeTextFile(`${CWD}/CLAUDE.md`, '# My Project\n');
    await install(fs, claude, 'local', HOME, CWD);

    const outcome = await uninstall(fs, claude, 'local', HOME, CWD);
    const byPath = actions(outcome.files);
    expect(byPath[`${CWD}/.mcp.json`]).toBe('removed');
    expect(byPath[`${CWD}/CLAUDE.md`]).toBe('cleaned');
    expect(await fs.exists(`${CWD}/.mcp.json`)).toBe(false);
    expect(await fs.readTextFile(`${CWD}/CLAUDE.md`)).toBe('# My Project\n');
  });

  it('removes a rules file that existed only for the block', async () => {
    const fs = new MemFs({});
    await install(fs, claude, 'local', HOME, CWD);
    await uninstall(fs, claude, 'local', HOME, CWD);
    expect(await fs.exists(`${CWD}/CLAUDE.md`)).toBe(false);
  });

  it('reports absent rather than a cleanup it did not do', async () => {
    const fs = new MemFs({});
    const outcome = await uninstall(fs, claude, 'local', HOME, CWD);
    expect(actions(outcome.files)[`${CWD}/.mcp.json`]).toBe('absent');
  });

  it('cleans a block from a rules file the current install would not have chosen', async () => {
    // An earlier install may have written into the other candidate; leaving
    // that block would keep telling the agent about tools it no longer has.
    const fs = new MemFs({});
    await install(fs, claude, 'local', HOME, CWD);
    const block = await fs.readTextFile(`${CWD}/CLAUDE.md`);
    await fs.writeTextFile(`${CWD}/.claude/CLAUDE.md`, block);

    await uninstall(fs, claude, 'local', HOME, CWD);
    expect(await fs.exists(`${CWD}/.claude/CLAUDE.md`)).toBe(false);
  });
});

describe('update', () => {
  it('does nothing for an agent that was never configured', async () => {
    // The whole reason it is a separate verb from install.
    const fs = new MemFs({});
    expect(await update(fs, claude, 'local', HOME, CWD)).toBeNull();
    expect(await fs.exists(`${CWD}/.mcp.json`)).toBe(false);
  });

  it('refreshes a stale block in place', async () => {
    const fs = new MemFs({});
    await install(fs, claude, 'local', HOME, CWD);
    await fs.writeTextFile(`${CWD}/CLAUDE.md`, `${START}\nold\n<!-- AILOUD_END -->\n`);
    const outcome = await update(fs, claude, 'local', HOME, CWD);
    expect(outcome).not.toBeNull();
    const rules = await fs.readTextFile(`${CWD}/CLAUDE.md`);
    expect(rules).not.toContain('old');
    expect(rules).toContain('search_transcripts');
  });

  it('acts when only the rules block is present, not just the config', async () => {
    const fs = new MemFs({});
    await fs.writeTextFile(`${CWD}/CLAUDE.md`, `${START}\nold\n<!-- AILOUD_END -->\n`);
    expect(await update(fs, claude, 'local', HOME, CWD)).not.toBeNull();
  });
});

describe('ensureProjectLibrary', () => {
  it('creates the directory with an ignore file that keeps its contents out of git', async () => {
    const fs = new MemFs({});
    const outcome = await ensureProjectLibrary(fs, CWD);
    expect(outcome.action).toBe('created');
    expect(await fs.readTextFile(`${CWD}/.ailoud/.gitignore`)).toBe(PROJECT_GITIGNORE);
    expect(PROJECT_GITIGNORE).toContain('*');
    expect(PROJECT_GITIGNORE).toContain('!.gitignore');
  });

  it('leaves an ignore file the user has changed alone', async () => {
    const fs = new MemFs({});
    await fs.ensureDir(`${CWD}/.ailoud`);
    await fs.writeTextFile(`${CWD}/.ailoud/.gitignore`, '*\n!.gitignore\n!notes.md\n');
    const outcome = await ensureProjectLibrary(fs, CWD);
    expect(outcome.action).toBe('unchanged');
    expect(await fs.readTextFile(`${CWD}/.ailoud/.gitignore`)).toContain('notes.md');
  });
});

describe('the rules file is written atomically', () => {
  /** Records the order of writes and renames, so the mechanism is checkable. */
  class RecordingFs extends MemFs {
    public readonly calls: string[] = [];
    public override async writeTextFile(path: string, content: string): Promise<void> {
      this.calls.push(`write:${path}`);
      return super.writeTextFile(path, content);
    }
    public override async rename(from: string, to: string): Promise<void> {
      this.calls.push(`rename:${from}->${to}`);
      return super.rename(from, to);
    }
  }

  it('writes a temporary file and renames it over the target', async () => {
    // The MECHANISM is what this asserts, deliberately. The defect it guards
    // against -- `writeTextFile` truncating the target before a failed write
    // empties it -- cannot be reproduced with `MemFs`, which either writes or
    // throws atomically. Truncation is a property of the real POSIX
    // `open(path, 'w')`.
    //
    // It was demonstrated on a real filesystem instead: on a full 1 MB
    // volume, a plain write turned a 25-byte hand-written CLAUDE.md into 0
    // bytes with ENOSPC, while temp-then-rename left it byte-identical. That
    // is why this pattern is here, and `self sync` sweeping this writer
    // across every registered project unattended is why it matters.
    const fs = new RecordingFs({ '/proj/CLAUDE.md': '# My own notes\n' });

    await install(fs, findAgent('claude')!, 'local', '/home/x', '/proj');

    const rules = fs.calls.filter((call) => call.includes('CLAUDE.md'));
    expect(rules.some((call) => call.startsWith('write:') && call.includes('.tmp'))).toBe(true);
    expect(
      rules.some((call) => call.startsWith('rename:') && call.endsWith('->/proj/CLAUDE.md')),
    ).toBe(true);
    // And never a direct write to the target itself.
    expect(rules).not.toContain('write:/proj/CLAUDE.md');
  });
});
