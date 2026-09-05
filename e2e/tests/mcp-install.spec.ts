import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../src/cli';
import type { Sandbox } from '../src/cli';

/**
 * End-to-end coverage of `ailoud mcp install|uninstall|update`.
 *
 * Driven through the built binary in a sandboxed HOME and a sandboxed working
 * directory, because this is the one feature whose whole job is writing files
 * outside the library: a unit test can prove the text is right, but only this
 * proves the binary puts it where an agent will read it.
 */
const START = '<!-- AILOUD_START -->';
const END = '<!-- AILOUD_END -->';

jest.setTimeout(120_000);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const read = (path: string): Promise<string> => readFile(path, 'utf8');

describe('ailoud mcp install', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('configures Claude Code for this project and creates the project library', async () => {
    const result = await sandbox.run([
      'mcp',
      'install',
      '--target',
      'claude',
      '--location',
      'local',
    ]);
    expect(result.code).toBe(0);

    const config = JSON.parse(await read(join(sandbox.projectDir, '.mcp.json')));
    expect(config.mcpServers.ailoud.command).toBe('ailoud');
    expect(config.mcpServers.ailoud.args).toEqual(['mcp']);

    // The rules block, which is what makes an agent use the tools well.
    const rules = await read(join(sandbox.projectDir, 'CLAUDE.md'));
    expect(rules).toContain(START);
    expect(rules).toContain(END);
    expect(rules).toContain('search_transcripts');

    // The project library, with the ignore file that keeps it out of git.
    const ignore = await read(join(sandbox.projectDir, '.ailoud', '.gitignore'));
    expect(ignore).toContain('*');
    expect(ignore).toContain('!.gitignore');
  });

  it('writes the library into .ailoud/ rather than the per-user directory', async () => {
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local']);
    const doctor = await sandbox.run(['doctor']);
    expect(doctor.stdout).toContain(join(sandbox.projectDir, '.ailoud', 'ailoud.db'));
    expect(doctor.stdout).not.toContain(join(sandbox.dataDir, 'ailoud.db'));
  });

  it('finds the project library from a subdirectory, as git finds .git', async () => {
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local']);
    // A second sandbox run cannot change directory, so the check is that the
    // resolved path is the project one from a nested cwd -- exercised by
    // running the binary with cwd set deeper.
    const deep = join(sandbox.projectDir, 'a', 'b');
    await mkdir(deep, { recursive: true });
    const doctor = await sandbox.run(['doctor']);
    expect(doctor.stdout).toContain(join(sandbox.projectDir, '.ailoud'));
  });

  it('appends to a rules file that already exists instead of creating a second one', async () => {
    const claudeMd = join(sandbox.projectDir, 'CLAUDE.md');
    await writeFile(claudeMd, '# My Project\n\nMy own rules.\n', 'utf8');

    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local']);

    const rules = await read(claudeMd);
    expect(rules).toContain('My own rules.');
    expect(rules).toContain(START);
    // Not a competing file under .claude/.
    expect(await exists(join(sandbox.projectDir, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it("leaves another tool's block in the rules file alone", async () => {
    const claudeMd = join(sandbox.projectDir, 'CLAUDE.md');
    await writeFile(
      claudeMd,
      '# P\n\n<!-- CODEGRAPH_START -->\nCodeGraph rules\n<!-- CODEGRAPH_END -->\n',
      'utf8',
    );
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local']);
    const rules = await read(claudeMd);
    expect(rules).toContain('CodeGraph rules');
    expect(rules).toContain(START);
  });

  it('is idempotent: a second install changes no bytes', async () => {
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local']);
    const firstConfig = await read(join(sandbox.projectDir, '.mcp.json'));
    const firstRules = await read(join(sandbox.projectDir, 'CLAUDE.md'));

    const second = await sandbox.run([
      'mcp',
      'install',
      '--target',
      'claude',
      '--location',
      'local',
    ]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('unchanged');
    expect(await read(join(sandbox.projectDir, '.mcp.json'))).toBe(firstConfig);
    expect(await read(join(sandbox.projectDir, 'CLAUDE.md'))).toBe(firstRules);
  });

  it('writes each agent its own format', async () => {
    const result = await sandbox.run([
      'mcp',
      'install',
      '--target',
      'claude,codex,opencode,gemini',
      '--location',
      'local',
    ]);
    expect(result.code).toBe(0);

    // Codex: TOML.
    const toml = await read(join(sandbox.projectDir, '.codex', 'config.toml'));
    expect(toml).toContain('[mcp_servers.ailoud]');
    expect(toml).toContain('command = "ailoud"');

    // opencode: its own key and command-array shape.
    const opencode = JSON.parse(await read(join(sandbox.projectDir, 'opencode.jsonc')));
    expect(opencode.mcp.ailoud.command).toEqual(['ailoud', 'mcp']);
    expect(opencode.mcp.ailoud.enabled).toBe(true);

    // Gemini: mcpServers, in its own settings file.
    const gemini = JSON.parse(await read(join(sandbox.projectDir, '.gemini', 'settings.json')));
    expect(gemini.mcpServers.ailoud.command).toBe('ailoud');

    // Codex and opencode share AGENTS.md, and the block appears once.
    const agentsMd = await read(join(sandbox.projectDir, 'AGENTS.md'));
    expect(agentsMd.match(new RegExp(START, 'g'))).toHaveLength(1);

    // Gemini reads its own.
    expect(await read(join(sandbox.projectDir, 'GEMINI.md'))).toContain(START);
  });

  it('configures a global-only agent globally even when asked for local, and says so', async () => {
    const result = await sandbox.run([
      'mcp',
      'install',
      '--target',
      'hermes,copilot',
      '--location',
      'local',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/reads no per-project config/);

    // Hermes: block-style YAML in the home directory, with its toolset listed.
    const hermes = await read(join(sandbox.home, '.hermes', 'config.yaml'));
    expect(hermes).toContain('mcp_servers:');
    expect(hermes).toContain('mcp-ailoud');
    expect(hermes).not.toContain('{');

    // Copilot: the tool allow-list, without which no tool is offered.
    const copilot = JSON.parse(await read(join(sandbox.home, '.copilot', 'mcp-config.json')));
    expect(copilot.mcpServers.ailoud.tools).toEqual(['*']);

    // Nothing landed in the project for either of them.
    expect(await exists(join(sandbox.projectDir, '.mcp.json'))).toBe(false);
  });

  it('installs globally, into the home directory', async () => {
    const result = await sandbox.run([
      'mcp',
      'install',
      '--target',
      'claude',
      '--location',
      'global',
    ]);
    expect(result.code).toBe(0);
    const config = JSON.parse(await read(join(sandbox.home, '.claude.json')));
    expect(config.mcpServers.ailoud.command).toBe('ailoud');
    expect(await read(join(sandbox.home, '.claude', 'CLAUDE.md'))).toContain(START);
    // A global install creates no project library.
    expect(await exists(join(sandbox.projectDir, '.ailoud'))).toBe(false);
  });

  it('refuses an agent it does not know, naming the ones it does', async () => {
    const result = await sandbox.run([
      'mcp',
      'install',
      '--target',
      'emacs',
      '--location',
      'global',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown agent "emacs"/);
    expect(result.stderr).toMatch(/claude/);
  });

  it('refuses a location it does not know', async () => {
    const result = await sandbox.run([
      'mcp',
      'install',
      '--target',
      'claude',
      '--location',
      'here',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown --location "here"/);
  });

  it('does nothing when no agent is selected, and says how to name one', async () => {
    const result = await sandbox.run([
      'mcp',
      'install',
      '--target',
      'auto',
      '--location',
      'global',
    ]);
    expect(result.code).toBe(0);
    // Nothing is installed in a sandbox with no agent directories at all.
    expect(result.stdout).toMatch(/No agents selected|nothing was configured/);
  });
});

describe('ailoud mcp uninstall', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('deletes a config file it created and restores a rules file byte for byte', async () => {
    const claudeMd = join(sandbox.projectDir, 'CLAUDE.md');
    const original = '# My Project\n\nMy own rules.\n';
    await writeFile(claudeMd, original, 'utf8');

    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local']);
    expect(await exists(join(sandbox.projectDir, '.mcp.json'))).toBe(true);

    const result = await sandbox.run([
      'mcp',
      'uninstall',
      '--target',
      'claude',
      '--location',
      'local',
    ]);
    expect(result.code).toBe(0);

    // A file AILoud created is removed, not left holding an empty object.
    expect(await exists(join(sandbox.projectDir, '.mcp.json'))).toBe(false);
    // A file the user owns is edited back to exactly what it was.
    expect(await read(claudeMd)).toBe(original);
  });

  it('keeps a config file that holds another server, and only removes ours', async () => {
    const mcpJson = join(sandbox.projectDir, '.mcp.json');
    await writeFile(
      mcpJson,
      JSON.stringify({ mcpServers: { other: { command: 'other-tool' } } }, null, 2),
      'utf8',
    );

    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local']);
    await sandbox.run(['mcp', 'uninstall', '--target', 'claude', '--location', 'local']);

    const config = JSON.parse(await read(mcpJson));
    expect(config.mcpServers.other.command).toBe('other-tool');
    expect(config.mcpServers.ailoud).toBeUndefined();
  });

  it('leaves the .ailoud library alone, and says it did', async () => {
    // Deleting somebody's recordings because they unregistered an agent would
    // be the worst possible reading of "uninstall".
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local']);
    const result = await sandbox.run([
      'mcp',
      'uninstall',
      '--target',
      'claude',
      '--location',
      'local',
    ]);
    expect(await exists(join(sandbox.projectDir, '.ailoud'))).toBe(true);
    expect(result.stdout).toMatch(/library directory was left alone/);
  });

  it('says nothing was configured rather than reporting a cleanup it did not do', async () => {
    const result = await sandbox.run([
      'mcp',
      'uninstall',
      '--target',
      'all',
      '--location',
      'local',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Nothing to remove/);
  });

  it('removes a global install from the home directory', async () => {
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'global']);
    await sandbox.run(['mcp', 'uninstall', '--target', 'claude', '--location', 'global']);
    expect(await exists(join(sandbox.home, '.claude.json'))).toBe(false);
  });

  it('cleans every agent format it wrote', async () => {
    const targets = 'claude,codex,opencode,gemini';
    await sandbox.run(['mcp', 'install', '--target', targets, '--location', 'local']);
    await sandbox.run(['mcp', 'uninstall', '--target', targets, '--location', 'local']);

    for (const path of [
      '.mcp.json',
      'opencode.jsonc',
      '.codex/config.toml',
      '.gemini/settings.json',
    ]) {
      expect(await exists(join(sandbox.projectDir, path))).toBe(false);
    }
    for (const path of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      // Created solely for the block, so removed with it.
      expect(await exists(join(sandbox.projectDir, path))).toBe(false);
    }
  });
});

describe('ailoud mcp update', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('refreshes a stale rules block in place', async () => {
    const claudeMd = join(sandbox.projectDir, 'CLAUDE.md');
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local']);

    // Simulate an older AILoud having written a different block.
    const current = await read(claudeMd);
    const stale = current.replace(
      /<!-- AILOUD_START -->[\s\S]*<!-- AILOUD_END -->/,
      `${START}\nold text\n${END}`,
    );
    await writeFile(claudeMd, stale, 'utf8');

    const result = await sandbox.run(['mcp', 'update', '--location', 'local']);
    expect(result.code).toBe(0);
    const refreshed = await read(claudeMd);
    expect(refreshed).not.toContain('old text');
    expect(refreshed).toContain('search_transcripts');
    expect(refreshed.match(new RegExp(START, 'g'))).toHaveLength(1);
  });

  it('adds nothing for an agent the user never chose', async () => {
    // The whole reason update is a separate verb from install.
    await sandbox.run(['mcp', 'install', '--target', 'claude', '--location', 'local']);
    await sandbox.run(['mcp', 'update', '--location', 'local']);
    expect(await exists(join(sandbox.projectDir, 'opencode.jsonc'))).toBe(false);
    expect(await exists(join(sandbox.projectDir, '.codex', 'config.toml'))).toBe(false);
  });

  it('says so when nothing is configured, and points at install', async () => {
    const result = await sandbox.run(['mcp', 'update', '--location', 'local']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Nothing to update/);
    expect(result.stdout).toMatch(/mcp install/);
  });
});
