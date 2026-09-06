import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
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

  it('adds the missing pattern when only one of the two is already present', () => {
    // The early return in `addPermission` is gated on `hasPermission`, which
    // must not answer true for a half-written rule.
    const before = JSON.stringify({ permission: { bash: { ailoud: 'allow' } } });
    const out = addPermission('jsonc-opencode-permission', before, CWD)!;
    expect(parse(out).permission.bash).toEqual({ ailoud: 'allow', 'ailoud *': 'allow' });
  });
});

describe('yaml-codex-policy', () => {
  it('writes an allow list when there is no file', () => {
    const out = addPermission('yaml-codex-policy', null, CWD)!;
    expect(parseDocument(out).toJSON().allow).toEqual(['ailoud', 'ailoud *']);
  });

  it('merges into an existing list instead of adding a second allow key', () => {
    // Two `allow:` mappings in one document is a duplicate key, which is a
    // YAML error -- the file stops loading and every rule in it is lost.
    const before = '# Locksmith permissions\nallow:\n  - "locksmith get *"\n';
    const out = addPermission('yaml-codex-policy', before, CWD)!;
    expect(out.match(/^allow:/gm)).toHaveLength(1);
    expect(parseDocument(out).toJSON().allow).toEqual(['locksmith get *', 'ailoud', 'ailoud *']);
  });

  it('keeps the comments around the rules', () => {
    const before = '# Locksmith permissions\nallow:\n  - "locksmith get *"\n';
    expect(addPermission('yaml-codex-policy', before, CWD)!).toContain('# Locksmith permissions');
  });

  it('is idempotent', () => {
    const once = addPermission('yaml-codex-policy', null, CWD)!;
    expect(addPermission('yaml-codex-policy', once, CWD)).toBe(once);
    expect(hasPermission('yaml-codex-policy', once, CWD)).toBe(true);
  });

  it('refuses a file it cannot parse and one whose allow is not a list', () => {
    expect(addPermission('yaml-codex-policy', 'allow:\n  - [unclosed', CWD)).toBeNull();
    expect(addPermission('yaml-codex-policy', 'allow: everything\n', CWD)).toBeNull();
  });

  it('removes both patterns, and says so when there were none', () => {
    const before = 'allow:\n  - "locksmith get *"\n  - "ailoud"\n  - "ailoud *"\n';
    const out = removePermission('yaml-codex-policy', before, CWD)!;
    expect(parseDocument(out).toJSON().allow).toEqual(['locksmith get *']);
    expect(removePermission('yaml-codex-policy', 'allow:\n  - "git"\n', CWD)).toBeNull();
  });

  it('adds the missing pattern when only one of the two is already present', () => {
    const before = 'allow:\n  - "ailoud"\n';
    const out = addPermission('yaml-codex-policy', before, CWD)!;
    expect(parseDocument(out).toJSON().allow).toEqual(['ailoud', 'ailoud *']);
  });
});

describe('json-copilot-locations', () => {
  it('keys the approval by the directory it was granted for', () => {
    // Copilot scopes shell approvals to a repository root, unlike its
    // machine-wide MCP configuration.
    const out = addPermission('json-copilot-locations', null, CWD)!;
    expect(parse(out).locations[CWD].tool_approvals).toEqual([
      { kind: 'commands', commandIdentifiers: ['ailoud:*'] },
    ]);
  });

  it('merges into the commands rule already there rather than adding a second', () => {
    const before = JSON.stringify({
      locations: {
        [CWD]: { tool_approvals: [{ kind: 'commands', commandIdentifiers: ['git status'] }] },
      },
    });
    const out = addPermission('json-copilot-locations', before, CWD)!;
    const approvals = parse(out).locations[CWD].tool_approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0].commandIdentifiers).toEqual(['git status', 'ailoud:*']);
  });

  it('leaves another directory alone', () => {
    const before = JSON.stringify({
      locations: {
        '/other/repo': { tool_approvals: [{ kind: 'commands', commandIdentifiers: ['git'] }] },
      },
    });
    const out = addPermission('json-copilot-locations', before, CWD)!;
    expect(parse(out).locations['/other/repo'].tool_approvals[0].commandIdentifiers).toEqual([
      'git',
    ]);
    expect(parse(out).locations[CWD].tool_approvals[0].commandIdentifiers).toEqual(['ailoud:*']);
  });

  it('is idempotent and reports presence per directory', () => {
    const once = addPermission('json-copilot-locations', null, CWD)!;
    expect(addPermission('json-copilot-locations', once, CWD)).toBe(once);
    expect(hasPermission('json-copilot-locations', once, CWD)).toBe(true);
    expect(hasPermission('json-copilot-locations', once, '/other/repo')).toBe(false);
  });

  it('removes our identifier and clears whatever that emptied', () => {
    const once = addPermission('json-copilot-locations', null, CWD)!;
    const out = removePermission('json-copilot-locations', once, CWD)!;
    expect(parse(out).locations).toBeUndefined();
    expect(removePermission('json-copilot-locations', '{}', CWD)).toBeNull();
  });
});
