import { Scalar, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document } from 'yaml';
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

/**
 * The heading written above the allow list in a policy file AILoud created.
 *
 * Named rather than repeated so the uninstall can recognise its own heading
 * and take it away again; every other comment in that file is the user's.
 */
const CODEX_HEADER = 'AILoud permissions';

type Json = Record<string, unknown>;

/**
 * Why an allow-list was left alone.
 *
 * Three separate problems, and what the user should do about each differs,
 * so the caller cannot report them with one sentence. It used to: every
 * refusal printed "not valid JSON", which sent a Codex user hunting a JSON
 * error in a YAML file and an opencode user hunting a syntax error in a file
 * whose syntax was fine.
 */
export type PermissionRefusal =
  /** The file is there and does not parse. */
  | 'unreadable'
  /** opencode's `"permission": "ask"` -- one default covering every tool. */
  | 'blanket'
  /** A key we would write into holds a shape we will not reinterpret. */
  | 'foreign';

/** The file as it should now read, or why there is no such text. */
export type PermissionEdit =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: PermissionRefusal };

const edited = (text: string): PermissionEdit => ({ ok: true, text });
const refused = (reason: PermissionRefusal): PermissionEdit => ({ ok: false, reason });

/**
 * Adds our entry, or says why the file cannot be edited safely.
 *
 * A refusal rather than a throw: the allow-list is a convenience on top of an
 * install, and failing the whole install -- after the MCP configuration and
 * the rules block were already written -- because one settings file has a
 * stray comma would be a worse outcome than saying so and moving on.
 */
export function addPermission(
  format: PermissionFormat,
  previous: string | null,
  cwd: string,
): PermissionEdit {
  // Checked before any parse-and-reserialise: a hand-formatted file that
  // already carries the rule must come back untouched, not reformatted to
  // this module's own JSON.stringify style. `editJson`'s byte-identical
  // return only works when `previous` was itself produced by `print()`.
  if (previous !== null && hasPermission(format, previous, cwd)) return edited(previous);
  switch (format) {
    case 'json-claude-permissions':
      return editJson(previous, (root) => {
        const permissions = objectAt(root, 'permissions');
        const allow = stringsAt(permissions, 'allow');
        if (allow === null) return 'foreign';
        if (!allow.includes(CLAUDE_RULE)) allow.push(CLAUDE_RULE);
        permissions['allow'] = allow;
        return null;
      });
    case 'json-gemini-tools':
      return editJson(previous, (root) => {
        const tools = objectAt(root, 'tools');
        const allowed = stringsAt(tools, 'allowed');
        if (allowed === null) return 'foreign';
        if (!allowed.includes(GEMINI_RULE)) allowed.push(GEMINI_RULE);
        tools['allowed'] = allowed;
        return null;
      });
    case 'jsonc-opencode-permission':
      return editJson(previous, (root) => {
        // A blanket `"permission": "ask"` applies to every tool. Expanding it
        // into an object would drop that default for everything but bash.
        const current = root['permission'];
        if (current !== undefined && (typeof current !== 'object' || current === null)) {
          return 'blanket';
        }
        const permission = objectAt(root, 'permission');
        const bash = objectAt(permission, 'bash');
        for (const pattern of GLOB_RULES) bash[pattern] = 'allow';
        return null;
      });
    case 'yaml-codex-policy':
      return addCodexPolicy(previous);
    case 'json-copilot-locations':
      return editJson(previous, (root) => {
        const locations = objectAt(root, 'locations');
        const location = objectAt(locations, cwd);
        const approvals = location['tool_approvals'];
        if (approvals !== undefined && !Array.isArray(approvals)) return 'foreign';
        const list = Array.isArray(approvals) ? [...approvals] : [];
        const commands = list.find(
          (entry): entry is Json =>
            entry !== null && typeof entry === 'object' && (entry as Json)['kind'] === 'commands',
        );
        if (commands === undefined) {
          list.push({ kind: 'commands', commandIdentifiers: [COPILOT_RULE] });
        } else {
          const ids = stringsAt(commands, 'commandIdentifiers');
          if (ids === null) return 'foreign';
          if (!ids.includes(COPILOT_RULE)) ids.push(COPILOT_RULE);
          commands['commandIdentifiers'] = ids;
        }
        location['tool_approvals'] = list;
        return null;
      });
  }
}

/**
 * The refusal as a sentence, naming the format's own syntax.
 *
 * Here rather than in the command, because which of these files is JSON and
 * which is YAML is this module's knowledge; the command only prints it.
 */
export function describeRefusal(format: PermissionFormat, reason: PermissionRefusal): string {
  const byHand = 'left alone -- add the entry by hand';
  switch (reason) {
    case 'unreadable':
      return `not valid ${format === 'yaml-codex-policy' ? 'YAML' : 'JSON'}; ${byHand}`;
    case 'blanket':
      return `"permission" is one blanket setting for every tool; ${byHand}`;
    case 'foreign':
      return `the allow-list key holds something unexpected; ${byHand}`;
  }
}

/**
 * Removes our entry, or null when there was nothing of ours to remove.
 *
 * The empty string is a third answer: the file held nothing but what an
 * install put there, and the caller deletes it rather than writing back a
 * husk. `removeTomlTable` in `agentConfig.ts` says the same thing the same
 * way.
 */
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
      // Only the value an install would have written. A key that says
      // anything else -- `"ailoud": "deny"` -- is the user's own decision
      // about our command, and deleting it on the way out would silently
      // re-open a door they had shut.
      const had = GLOB_RULES.filter((pattern) => map[pattern] === 'allow');
      if (had.length === 0) return null;
      for (const pattern of had) delete map[pattern];
      if (Object.keys(map).length === 0) delete (permission as Json)['bash'];
      if (Object.keys(permission as Json).length === 0) delete root['permission'];
      return printOrEmpty(root);
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
      return printOrEmpty(root);
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
 * The document, or the empty string when nothing of the user's is left in it.
 *
 * Used only by the removal paths, so the caller can delete a file rather than
 * write back `{}` -- which records that an install once happened, which is
 * what the uninstall was asked to undo. `$schema` counts as ours as well,
 * for the same reason `isEmptyConfig` says so: opencode's file is created
 * carrying it and nothing else when AILoud is all that is in it.
 */
function printOrEmpty(root: Json): string {
  const keys = Object.keys(root).filter((key) => key !== '$schema');
  return keys.length === 0 ? '' : print(root);
}

/**
 * Parses, mutates, re-serialises. The mutation names a refusal to abandon the
 * edit, or null to keep it -- for a file whose shape we would have to
 * reinterpret to write into.
 */
function editJson(
  previous: string | null,
  mutate: (root: Json) => PermissionRefusal | null,
): PermissionEdit {
  const root = previous === null ? {} : tryParseJson(previous);
  if (root === null) return refused('unreadable');
  const refusal = mutate(root);
  if (refusal !== null) return refused(refusal);
  const out = print(root);
  // Byte-identical when nothing was missing, so the caller reports
  // `unchanged` instead of claiming a write it did not make.
  return edited(previous !== null && out === previous ? previous : out);
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
  return printOrEmpty(root);
}

// --- YAML ------------------------------------------------------------------

/**
 * The `allow` sequence as plain strings, or null when the document cannot be
 * read or `allow` is holding something that is not a list of strings.
 */
function codexAllowList(text: string): string[] | null {
  const doc = codexDocument(text);
  return doc === null ? null : allowStrings(doc);
}

/** The parsed policy file, or null when it is not readable YAML at all. */
function codexDocument(text: string): Document | null {
  try {
    const doc = parseDocument(text);
    return doc.errors.length > 0 ? null : doc;
  } catch {
    return null;
  }
}

/** Split from the parse so a refusal can say which of the two went wrong. */
function allowStrings(doc: Document): string[] | null {
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
function addCodexPolicy(previous: string | null): PermissionEdit {
  if (previous === null || previous.trim() === '') {
    // Emitted directly rather than through the document API, which renders
    // everything built from an empty seed in flow style -- valid YAML that no
    // hand-written policy file looks like.
    return edited(
      [
        `# ${CODEX_HEADER}`,
        'allow:',
        ...GLOB_RULES.map((r) => `  - ${JSON.stringify(r)}`),
        '',
      ].join('\n'),
    );
  }
  const doc = codexDocument(previous);
  if (doc === null) return refused('unreadable');
  const current = allowStrings(doc);
  if (current === null) return refused('foreign');
  const missing = GLOB_RULES.filter((pattern) => !current.includes(pattern));
  if (missing.length === 0) return edited(previous);
  const listed = doc.get('allow', true);
  if (isSeq(listed)) {
    // Appended to the sequence node in place. `doc.set('allow', [...])`
    // replaces the whole node instead, and every comment written inside the
    // list goes with it -- the line saying why a hand-added command is
    // trusted, which is the one thing in that file worth keeping.
    for (const pattern of missing) listed.add(quoted(pattern));
  } else {
    // No `allow` key yet, or one holding null: there is no sequence to merge
    // into, so the key is created.
    doc.set('allow', missing.map(quoted));
  }
  return edited(doc.toString());
}

/**
 * A double-quoted scalar, matching the entries written into a fresh file.
 *
 * A bare `- ailoud *` is valid YAML and parses the same, but a policy file
 * whose quoting changes halfway down its own allow list reads as if it had
 * been corrupted.
 */
function quoted(value: string): Scalar {
  const node = new Scalar(value);
  node.type = Scalar.QUOTE_DOUBLE;
  return node;
}

/**
 * Codex, through the same document API and for the same reason.
 *
 * Entries are spliced out of the sequence that is already there rather than
 * the key being rewritten or deleted outright: `doc.set` replaces the whole
 * sequence and drops every comment inside it, and `doc.delete('allow')` drops
 * the comment sitting above the key -- which is where a policy file's header
 * lives, so a silent uninstall took the user's own heading with it.
 */
function removeCodexPolicy(previous: string): string | null {
  const current = codexAllowList(previous);
  if (current === null) return null;
  if (!current.some((entry) => isOurs(entry))) return null;
  const doc = parseDocument(previous);
  const listed = doc.get('allow', true);
  if (!isSeq(listed)) return null;
  const kept = listed.items.filter((item) => !(isScalar(item) && isOurs(String(item.value))));
  if (kept.length > 0) {
    listed.items = kept;
    return doc.toString();
  }
  return withoutAllowKey(doc);
}

function isOurs(entry: string): boolean {
  return (GLOB_RULES as readonly string[]).includes(entry);
}

/**
 * The document without its `allow` key, as text.
 *
 * Two things `doc.delete('allow')` gets wrong on its own. It loses the
 * comment above the key: ours is the header we wrote, but a hand-written
 * file's is the user's, so that one moves down to the next key instead of
 * being dropped. And with no key left it renders the mapping as the literal
 * `{}` -- a file that still records an install, which is the thing the
 * uninstall was asked to undo. Nothing left at all comes back as the empty
 * string, and the caller deletes the file; comments the user wrote come back
 * on their own, because those are not ours to remove.
 */
function withoutAllowKey(doc: Document): string {
  const map = doc.contents;
  if (!isMap(map)) return '';
  const at = map.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === 'allow');
  if (at === -1) return doc.toString();
  const [pair] = map.items.splice(at, 1);
  let orphan = isScalar(pair?.key) ? (pair.key.commentBefore ?? null) : null;
  if (orphan !== null && orphan.trim() === CODEX_HEADER) orphan = null;
  const next = map.items[at];
  if (orphan !== null && next !== undefined && isScalar(next.key)) {
    next.key.commentBefore =
      next.key.commentBefore === null || next.key.commentBefore === undefined
        ? orphan
        : `${orphan}\n${next.key.commentBefore}`;
    orphan = null;
  }
  if (map.items.length > 0) return doc.toString();
  const lines = [doc.commentBefore, orphan, doc.comment]
    .filter((comment): comment is string => typeof comment === 'string' && comment !== '')
    .flatMap((comment) => comment.split('\n'))
    .map((line) => `#${line}`);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
