import { describe, expect, it } from 'vitest';
import { addPermission, hasPermission, removePermission } from './permissions.js';

const CWD = '/work/repo';
const parse = (text: string) => JSON.parse(text);

describe('json-claude-permissions', () => {
  it('creates the allow list when there is no file', () => {
    const out = addPermission('json-claude-permissions', null, CWD)!;
    expect(parse(out).permissions.allow).toEqual(['Bash(ailoud:*)']);
  });

  it('keeps every other setting and every other rule verbatim', () => {
    // These files are hand-edited. An install that dropped a user's hooks
    // while adding one permission would be a worse outcome than not installing.
    const before = JSON.stringify({
      permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm:*)'] },
      hooks: { UserPromptSubmit: [{ command: 'x' }] },
    });
    const out = addPermission('json-claude-permissions', before, CWD)!;
    const root = parse(out);
    expect(root.permissions.allow).toEqual(['Bash(git status)', 'Bash(ailoud:*)']);
    expect(root.permissions.deny).toEqual(['Bash(rm:*)']);
    expect(root.hooks.UserPromptSubmit).toEqual([{ command: 'x' }]);
  });

  it('is idempotent, so a second install reports unchanged rather than a write', () => {
    const once = addPermission('json-claude-permissions', null, CWD)!;
    expect(addPermission('json-claude-permissions', once, CWD)).toBe(once);
  });

  it('returns a hand-formatted file untouched when the rule is already there', () => {
    // Reformatting a file that already has the rule would report a write on
    // a file that needed none, on the very first install against it.
    const input = '{"unrelated":true,"permissions":{"allow":["Bash(ailoud:*)"]}}';
    expect(addPermission('json-claude-permissions', input, CWD)).toBe(input);
  });

  it('refuses to rewrite a file it cannot parse', () => {
    // Rewriting it would destroy hand-written settings; the caller reports
    // this as skipped and names the path.
    expect(addPermission('json-claude-permissions', '{ this is not json', CWD)).toBeNull();
  });

  it('reports whether the rule is present', () => {
    expect(hasPermission('json-claude-permissions', '{}', CWD)).toBe(false);
    const once = addPermission('json-claude-permissions', null, CWD)!;
    expect(hasPermission('json-claude-permissions', once, CWD)).toBe(true);
  });

  it('removes only our rule, and says so when there was none', () => {
    const before = JSON.stringify({
      permissions: { allow: ['Bash(git status)', 'Bash(ailoud:*)'] },
    });
    const out = removePermission('json-claude-permissions', before, CWD)!;
    expect(parse(out).permissions.allow).toEqual(['Bash(git status)']);
    expect(removePermission('json-claude-permissions', '{}', CWD)).toBeNull();
  });

  it('clears the containers it emptied rather than leaving them behind', () => {
    // `"permissions": {"allow": []}` records that an install once happened,
    // which is what an uninstall is supposed to undo.
    const once = addPermission('json-claude-permissions', null, CWD)!;
    const out = removePermission('json-claude-permissions', once, CWD)!;
    expect(parse(out).permissions).toBeUndefined();
  });
});

describe('json-gemini-tools', () => {
  it('writes tools.allowed, never tools.core', () => {
    // tools.core is a restricting allowlist: writing into it would disable
    // every other built-in tool the user has.
    const out = addPermission('json-gemini-tools', null, CWD)!;
    expect(parse(out).tools.allowed).toEqual(['run_shell_command(ailoud)']);
    expect(parse(out).tools.core).toBeUndefined();
  });

  it('keeps an existing core allowlist untouched', () => {
    const before = JSON.stringify({ tools: { core: ['read_file'] } });
    const out = addPermission('json-gemini-tools', before, CWD)!;
    expect(parse(out).tools.core).toEqual(['read_file']);
    expect(parse(out).tools.allowed).toEqual(['run_shell_command(ailoud)']);
  });

  it('is idempotent, so a second install reports unchanged rather than a write', () => {
    const once = addPermission('json-gemini-tools', null, CWD)!;
    expect(addPermission('json-gemini-tools', once, CWD)).toBe(once);
  });

  it('returns a hand-formatted file untouched when the rule is already there', () => {
    const input = '{"other":1,"tools":{"allowed":["run_shell_command(ailoud)"]}}';
    expect(addPermission('json-gemini-tools', input, CWD)).toBe(input);
  });

  it('removes only our entry', () => {
    const before = JSON.stringify({
      tools: { allowed: ['run_shell_command(git)', 'run_shell_command(ailoud)'] },
    });
    const out = removePermission('json-gemini-tools', before, CWD)!;
    expect(parse(out).tools.allowed).toEqual(['run_shell_command(git)']);
    expect(removePermission('json-gemini-tools', '{}', CWD)).toBeNull();
  });
});

describe('jsonc-opencode-permission', () => {
  it('allows both the bare command and the command with arguments', () => {
    // opencode matches a command against a glob, and `ailoud *` does not
    // match a bare `ailoud` -- which is what `ailoud audio ls` collapses to
    // for an agent that runs the top-level alias.
    const out = addPermission('jsonc-opencode-permission', null, CWD)!;
    expect(parse(out).permission.bash).toEqual({ ailoud: 'allow', 'ailoud *': 'allow' });
  });

  it('keeps the mcp block a previous install wrote', () => {
    const before = JSON.stringify({ mcp: { ailoud: { type: 'local' } } });
    const out = addPermission('jsonc-opencode-permission', before, CWD)!;
    expect(parse(out).mcp.ailoud.type).toBe('local');
  });

  it('leaves a blanket permission setting alone', () => {
    // `"permission": "ask"` applies to every tool. Expanding it into an
    // object would silently drop that default for everything but bash.
    expect(addPermission('jsonc-opencode-permission', '{"permission":"ask"}', CWD)).toBeNull();
  });

  it('is idempotent, so a second install reports unchanged rather than a write', () => {
    const once = addPermission('jsonc-opencode-permission', null, CWD)!;
    expect(addPermission('jsonc-opencode-permission', once, CWD)).toBe(once);
  });

  it('returns a hand-formatted file untouched when the rule is already there', () => {
    const input = '{"foo":"bar","permission":{"bash":{"ailoud":"allow","ailoud *":"allow"}}}';
    expect(addPermission('jsonc-opencode-permission', input, CWD)).toBe(input);
  });

  it('removes both patterns and clears the emptied containers', () => {
    const once = addPermission('jsonc-opencode-permission', null, CWD)!;
    const out = removePermission('jsonc-opencode-permission', once, CWD)!;
    expect(parse(out).permission).toBeUndefined();
    expect(removePermission('jsonc-opencode-permission', '{}', CWD)).toBeNull();
  });

  it('does not disturb another tool sharing the bash map', () => {
    const before = JSON.stringify({
      permission: { bash: { git: 'allow', ailoud: 'allow', 'ailoud *': 'allow' } },
    });
    const out = removePermission('jsonc-opencode-permission', before, CWD)!;
    expect(parse(out).permission.bash).toEqual({ git: 'allow' });
  });
});
