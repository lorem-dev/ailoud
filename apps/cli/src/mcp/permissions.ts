import { parseDocument } from 'yaml';
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
  | 'json-claude-permissions'
  | 'yaml-codex-policy'
  | 'jsonc-opencode-permission'
  | 'json-gemini-tools'
  | 'json-copilot-locations';

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

/** Copilot matches `name:*` against the command and its arguments alike. */
const COPILOT_RULE = `${COMMAND}:*`;

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
    case 'yaml-codex-policy':
      return addCodexPolicy(previous);
    case 'json-copilot-locations':
      return editJson(previous, (root) => {
        const locations = objectAt(root, 'locations');
        const location = objectAt(locations, cwd);
        const approvals = location['tool_approvals'];
        if (approvals !== undefined && !Array.isArray(approvals)) return false;
        const list = Array.isArray(approvals) ? [...approvals] : [];
        const commands = list.find(
          (entry): entry is Json =>
            entry !== null && typeof entry === 'object' && (entry as Json)['kind'] === 'commands',
        );
        if (commands === undefined) {
          list.push({ kind: 'commands', commandIdentifiers: [COPILOT_RULE] });
        } else {
          const ids = stringsAt(commands, 'commandIdentifiers');
          if (ids === null) return false;
          if (!ids.includes(COPILOT_RULE)) ids.push(COPILOT_RULE);
          commands['commandIdentifiers'] = ids;
        }
        location['tool_approvals'] = list;
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
    case 'yaml-codex-policy':
      return removeCodexPolicy(previous);
    case 'json-copilot-locations': {
      const root = tryParseJson(previous);
      if (root === null) return null;
      const locations = root['locations'];
      if (locations === null || typeof locations !== 'object') return null;
      const location = (locations as Json)[cwd];
      if (location === null || typeof location !== 'object') return null;
      const list = (location as Json)['tool_approvals'];
      if (!Array.isArray(list)) return null;
      let removed = false;
      const kept = list.filter((entry) => {
        if (entry === null || typeof entry !== 'object') return true;
        const rule = entry as Json;
        if (rule['kind'] !== 'commands') return true;
        const ids = Array.isArray(rule['commandIdentifiers']) ? rule['commandIdentifiers'] : [];
        if (!ids.includes(COPILOT_RULE)) return true;
        removed = true;
        const left = ids.filter((id) => id !== COPILOT_RULE);
        rule['commandIdentifiers'] = left;
        return left.length > 0;
      });
      if (!removed) return null;
      if (kept.length === 0) delete (location as Json)['tool_approvals'];
      else (location as Json)['tool_approvals'] = kept;
      if (Object.keys(location as Json).length === 0) delete (locations as Json)[cwd];
      if (Object.keys(locations as Json).length === 0) delete root['locations'];
      return print(root);
    }
  }
}

/** Whether our entry is already there. */
export function hasPermission(format: PermissionFormat, text: string, cwd: string): boolean {
  if (format === 'yaml-codex-policy') {
    const current = codexAllowList(text);
    return current !== null && GLOB_RULES.every((pattern) => current.includes(pattern));
  }
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
    case 'json-copilot-locations': {
      const locations = root['locations'];
      if (locations === null || typeof locations !== 'object') return false;
      const location = (locations as Json)[cwd];
      if (location === null || typeof location !== 'object') return false;
      const list = (location as Json)['tool_approvals'];
      if (!Array.isArray(list)) return false;
      return list.some(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          (entry as Json)['kind'] === 'commands' &&
          Array.isArray((entry as Json)['commandIdentifiers']) &&
          ((entry as Json)['commandIdentifiers'] as unknown[]).includes(COPILOT_RULE),
      );
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

// --- YAML ------------------------------------------------------------------

/**
 * The `allow` sequence as plain strings, or null when the document cannot be
 * read or `allow` is holding something that is not a list of strings.
 */
function codexAllowList(text: string): string[] | null {
  let doc;
  try {
    doc = parseDocument(text);
  } catch {
    return null;
  }
  if (doc.errors.length > 0) return null;
  const listed = doc.get('allow');
  if (listed === undefined || listed === null) return [];
  const asJson = (listed as { toJSON?: () => unknown }).toJSON?.();
  if (!Array.isArray(asJson)) return null;
  if (!asJson.every((entry) => typeof entry === 'string')) return null;
  return asJson as string[];
}

/**
 * Codex, through the yaml document API, which preserves comments and key
 * order -- the same reason `agentConfig.ts` uses it for Hermes.
 *
 * Merged into the existing sequence rather than appended as a second
 * `allow:` mapping: a duplicate key is a YAML error, and the file it breaks
 * is the one holding every command the user has already approved.
 */
function addCodexPolicy(previous: string | null): string | null {
  if (previous === null || previous.trim() === '') {
    // Emitted directly rather than through the document API, which renders
    // everything built from an empty seed in flow style -- valid YAML that no
    // hand-written policy file looks like.
    return [
      '# AILoud permissions',
      'allow:',
      ...GLOB_RULES.map((r) => `  - ${JSON.stringify(r)}`),
      '',
    ].join('\n');
  }
  const current = codexAllowList(previous);
  if (current === null) return null;
  const missing = GLOB_RULES.filter((pattern) => !current.includes(pattern));
  if (missing.length === 0) return previous;
  const doc = parseDocument(previous);
  doc.set('allow', [...current, ...missing]);
  return doc.toString();
}

function removeCodexPolicy(previous: string): string | null {
  const current = codexAllowList(previous);
  if (current === null) return null;
  const kept = current.filter((entry) => !(GLOB_RULES as readonly string[]).includes(entry));
  if (kept.length === current.length) return null;
  const doc = parseDocument(previous);
  if (kept.length === 0) doc.delete('allow');
  else doc.set('allow', kept);
  return doc.toString();
}
