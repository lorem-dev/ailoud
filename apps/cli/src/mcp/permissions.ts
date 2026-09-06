import { tryParseJson } from './agentConfig.js';

/**
 * How an agent's command allow-list is written.
 *
 * One per shape actually observed, as `ConfigFormat` is. Every path and every
 * shape here was read from a working installation or an agent's published
 * schema rather than from memory: an allow-list written into a key nothing
 * reads looks exactly like a successful install, and the user finds out only
 * when the approval prompt appears anyway.
 */
export type PermissionFormat =
  'json-claude-permissions' | 'jsonc-opencode-permission' | 'json-gemini-tools';

/** The command an agent is pre-approved to run. */
const COMMAND = 'ailoud';

/**
 * Claude Code's `Bash(...)` names Claude Code's own tool, not the user's
 * shell -- the rule holds whether they run bash, zsh or fish. The `:*` form
 * covers the bare command as well as any arguments.
 */
const CLAUDE_RULE = `Bash(${COMMAND}:*)`;

/** Gemini matches on the command name, so one entry covers every subcommand. */
const GEMINI_RULE = `run_shell_command(${COMMAND})`;

/**
 * Two patterns, because opencode matches a command against a glob and
 * `ailoud *` does not match a bare `ailoud` with no arguments.
 */
const GLOB_RULES = [COMMAND, `${COMMAND} *`] as const;

type Json = Record<string, unknown>;

/**
 * Adds our entry, or null when the file is there and cannot be edited safely.
 *
 * Null rather than a throw: the allow-list is a convenience on top of an
 * install, and failing the whole install -- after the MCP configuration and
 * the rules block were already written -- because one settings file has a
 * stray comma would be a worse outcome than saying so and moving on.
 */
export function addPermission(
  format: PermissionFormat,
  previous: string | null,
  cwd: string,
): string | null {
  void cwd;
  // Checked before any parse-and-reserialise: a hand-formatted file that
  // already carries the rule must come back untouched, not reformatted to
  // this module's own JSON.stringify style. `editJson`'s byte-identical
  // return only works when `previous` was itself produced by `print()`.
  if (previous !== null && hasPermission(format, previous, cwd)) return previous;
  switch (format) {
    case 'json-claude-permissions':
      return editJson(previous, (root) => {
        const permissions = objectAt(root, 'permissions');
        const allow = stringsAt(permissions, 'allow');
        if (allow === null) return false;
        if (!allow.includes(CLAUDE_RULE)) allow.push(CLAUDE_RULE);
        permissions['allow'] = allow;
        return true;
      });
    case 'json-gemini-tools':
      return editJson(previous, (root) => {
        const tools = objectAt(root, 'tools');
        const allowed = stringsAt(tools, 'allowed');
        if (allowed === null) return false;
        if (!allowed.includes(GEMINI_RULE)) allowed.push(GEMINI_RULE);
        tools['allowed'] = allowed;
        return true;
      });
    case 'jsonc-opencode-permission':
      return editJson(previous, (root) => {
        // A blanket `"permission": "ask"` applies to every tool. Expanding it
        // into an object would drop that default for everything but bash.
        const current = root['permission'];
        if (current !== undefined && (typeof current !== 'object' || current === null)) {
          return false;
        }
        const permission = objectAt(root, 'permission');
        const bash = objectAt(permission, 'bash');
        for (const pattern of GLOB_RULES) bash[pattern] = 'allow';
        return true;
      });
  }
}

/** Removes our entry, or null when there was nothing of ours to remove. */
export function removePermission(
  format: PermissionFormat,
  previous: string,
  cwd: string,
): string | null {
  void cwd;
  switch (format) {
    case 'json-claude-permissions':
      return dropFromList(previous, 'permissions', 'allow', CLAUDE_RULE);
    case 'json-gemini-tools':
      return dropFromList(previous, 'tools', 'allowed', GEMINI_RULE);
    case 'jsonc-opencode-permission': {
      const root = tryParseJson(previous);
      if (root === null) return null;
      const permission = root['permission'];
      if (permission === null || typeof permission !== 'object') return null;
      const bash = (permission as Json)['bash'];
      if (bash === null || typeof bash !== 'object') return null;
      const map = bash as Json;
      const had = GLOB_RULES.filter((pattern) => pattern in map);
      if (had.length === 0) return null;
      for (const pattern of had) delete map[pattern];
      if (Object.keys(map).length === 0) delete (permission as Json)['bash'];
      if (Object.keys(permission as Json).length === 0) delete root['permission'];
      return print(root);
    }
  }
}

/** Whether our entry is already there. */
export function hasPermission(format: PermissionFormat, text: string, cwd: string): boolean {
  void cwd;
  const root = tryParseJson(text);
  if (root === null) return false;
  switch (format) {
    case 'json-claude-permissions':
      return listAt(root, 'permissions', 'allow').includes(CLAUDE_RULE);
    case 'json-gemini-tools':
      return listAt(root, 'tools', 'allowed').includes(GEMINI_RULE);
    case 'jsonc-opencode-permission': {
      const permission = root['permission'];
      if (permission === null || typeof permission !== 'object') return false;
      const bash = (permission as Json)['bash'];
      if (bash === null || typeof bash !== 'object') return false;
      return GLOB_RULES.every((pattern) => (bash as Json)[pattern] === 'allow');
    }
  }
}

// --- JSON ------------------------------------------------------------------

function print(root: Json): string {
  return `${JSON.stringify(root, null, 2)}\n`;
}

/**
 * Parses, mutates, re-serialises. The mutation returns false to abandon the
 * edit, for a file whose shape we would have to reinterpret to write into.
 */
function editJson(previous: string | null, mutate: (root: Json) => boolean): string | null {
  const root = previous === null ? {} : tryParseJson(previous);
  if (root === null) return null;
  if (!mutate(root)) return null;
  const out = print(root);
  // Byte-identical when nothing was missing, so the caller reports
  // `unchanged` instead of claiming a write it did not make.
  return previous !== null && out === previous ? previous : out;
}

function objectAt(root: Json, key: string): Json {
  const found = root[key];
  if (found !== null && typeof found === 'object' && !Array.isArray(found)) return found as Json;
  const fresh: Json = {};
  root[key] = fresh;
  return fresh;
}

/** The string array at `key`, or null when something else is sitting there. */
function stringsAt(root: Json, key: string): string[] | null {
  const found = root[key];
  if (found === undefined) return [];
  if (!Array.isArray(found)) return null;
  if (!found.every((entry) => typeof entry === 'string')) return null;
  return [...(found as string[])];
}

function listAt(root: Json, container: string, key: string): readonly string[] {
  const found = root[container];
  if (found === null || typeof found !== 'object') return [];
  const list = (found as Json)[key];
  return Array.isArray(list) ? (list.filter((e) => typeof e === 'string') as string[]) : [];
}

function dropFromList(
  previous: string,
  container: string,
  key: string,
  rule: string,
): string | null {
  const root = tryParseJson(previous);
  if (root === null) return null;
  const found = root[container];
  if (found === null || typeof found !== 'object') return null;
  const holder = found as Json;
  const list = holder[key];
  if (!Array.isArray(list) || !list.includes(rule)) return null;
  const kept = list.filter((entry) => entry !== rule);
  if (kept.length === 0) delete holder[key];
  else holder[key] = kept;
  if (Object.keys(holder).length === 0) delete root[container];
  return print(root);
}
