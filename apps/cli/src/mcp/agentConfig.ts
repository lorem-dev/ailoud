import { parseDocument } from 'yaml';
import { FailureError } from '@ailoud/core';
import type { ConfigFormat } from './agents.js';

/** The key AILoud registers itself under, in every agent's configuration. */
export const SERVER_NAME = 'ailoud';

/** The command an agent is told to run. */
const COMMAND = 'ailoud';
const ARGS = ['mcp'];

/**
 * Adds our server to an agent's configuration text, returning the new text.
 *
 * `previous` is the file as it stands, or null when there is none. Every
 * format is handled by editing rather than regenerating where that is
 * possible, because these files are hand-edited: an install that reformatted
 * somebody's whole configuration would be a worse outcome than not installing.
 *
 * JSON is the exception -- it is parsed and re-serialised, so comments in a
 * `.jsonc` do not survive. Said plainly here because it is a real loss, and
 * the alternative (a JSONC-preserving editor) is a dependency and a parser
 * this feature does not justify.
 */
export function addServer(format: ConfigFormat, previous: string | null): string {
  switch (format) {
    case 'json-mcp-servers':
      return editJson(previous, (root) => {
        const servers = objectAt(root, 'mcpServers');
        servers[SERVER_NAME] = { type: 'stdio', command: COMMAND, args: [...ARGS] };
      });
    case 'json-mcp-servers-tools':
      return editJson(previous, (root) => {
        const servers = objectAt(root, 'mcpServers');
        servers[SERVER_NAME] = {
          type: 'stdio',
          command: COMMAND,
          args: [...ARGS],
          // Copilot CLI needs the tool allow-list stated; without it the
          // server connects and none of its tools are offered.
          tools: ['*'],
        };
      });
    case 'jsonc-opencode':
      return editJson(previous, (root) => {
        root['$schema'] ??= 'https://opencode.ai/config.json';
        const servers = objectAt(root, 'mcp');
        servers[SERVER_NAME] = {
          type: 'local',
          command: [COMMAND, ...ARGS],
          enabled: true,
        };
      });
    case 'toml-codex':
      return addTomlTable(previous);
    case 'yaml-hermes':
      return addHermesYaml(previous);
  }
}

/** Removes our server, or returns null when it was not there. */
export function removeServer(format: ConfigFormat, previous: string): string | null {
  switch (format) {
    case 'json-mcp-servers':
    case 'json-mcp-servers-tools':
      return removeJsonKey(previous, 'mcpServers');
    case 'jsonc-opencode':
      return removeJsonKey(previous, 'mcp');
    case 'toml-codex':
      return removeTomlTable(previous);
    case 'yaml-hermes':
      return removeHermesYaml(previous);
  }
}

/**
 * Whether our server is registered in this text.
 *
 * Parsed per format, never pattern-matched over the whole file. A regexp for
 * the server name matched it inside ordinary data -- Claude Code stores prompt
 * history in `~/.claude.json`, so a user who had once typed "run ailoud: hi"
 * made `mcp update` believe that agent was configured and install into it,
 * which is the single thing `update` exists not to do.
 */
export function hasServer(format: ConfigFormat, text: string): boolean {
  switch (format) {
    case 'toml-codex':
      return tomlServerForm(text) !== 'absent';
    case 'yaml-hermes': {
      try {
        return parseDocument(text).hasIn(['mcp_servers', SERVER_NAME]);
      } catch {
        return false;
      }
    }
    default: {
      const container = format === 'jsonc-opencode' ? 'mcp' : 'mcpServers';
      const root = tryParseJson(text);
      if (root === null) return false;
      const servers = root[container];
      return servers !== null && typeof servers === 'object' && SERVER_NAME in servers;
    }
  }
}

// --- JSON ------------------------------------------------------------------

type Json = Record<string, unknown>;

function objectAt(root: Json, key: string): Json {
  const found = root[key];
  if (found !== null && typeof found === 'object' && !Array.isArray(found)) return found as Json;
  const fresh: Json = {};
  root[key] = fresh;
  return fresh;
}

/**
 * Strips `//` and block comments so a `.jsonc` parses.
 *
 * String-aware: a `//` inside a value (`"https://..."`) is not a comment, and
 * a version of this that ignored that truncated every URL in the file.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && text[at + 1] === '/') {
      while (at < text.length && text[at] !== '\n') at += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && text[at + 1] === '*') {
      const close = text.indexOf('*/', at + 2);
      at = close === -1 ? text.length : close + 1;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * JSON.parse over a JSONC-ish file, or null.
 *
 * Tolerates the two things an editor leaves behind that `JSON.parse` refuses
 * and every JSONC reader accepts: a trailing comma and a byte-order mark.
 * Without them, one agent's hand-edited file threw mid-install, after earlier
 * agents had already been written and before anything was reported.
 */
export function tryParseJson(text: string): Json | null {
  const cleaned = stripJsonComments(text)
    .replace(/^\uFEFF/, '')
    .replace(/,(\s*[}\]])/g, '$1');
  if (cleaned.trim() === '') return {};
  try {
    return (JSON.parse(cleaned) ?? {}) as Json;
  } catch {
    return null;
  }
}

function editJson(previous: string | null, mutate: (root: Json) => void): string {
  const root = previous === null ? {} : tryParseJson(previous);
  if (root === null) {
    throw new FailureError(
      'that configuration file is not valid JSON, so AILoud will not rewrite it. Fix it by hand, or move it aside.',
    );
  }
  mutate(root);
  return `${JSON.stringify(root, null, 2)}\n`;
}

function removeJsonKey(previous: string, container: string): string | null {
  const root = tryParseJson(previous);
  if (root === null) return null;
  const servers = root[container];
  if (servers === null || typeof servers !== 'object') return null;
  const map = servers as Json;
  if (!(SERVER_NAME in map)) return null;
  delete map[SERVER_NAME];
  // An empty container is removed too: leaving `"mcpServers": {}` behind is
  // litter that says an install happened.
  if (Object.keys(map).length === 0) delete root[container];
  return `${JSON.stringify(root, null, 2)}\n`;
}

// --- TOML ------------------------------------------------------------------

const TOML_HEADER = `[mcp_servers.${SERVER_NAME}]`;
const TOML_SUBTABLE = `[mcp_servers.${SERVER_NAME}.`;
const MULTILINE_DELIMS = ['"""', "'''"];

/**
 * Which lines begin a table, ignoring anything inside a multi-line string.
 *
 * A line starting with `[` is a table header only outside a string. Without
 * this, a value holding a line like `[not a table]` inside a `"""` block ended
 * our table early, and removing it left an orphaned delimiter at top level --
 * unparseable TOML produced by a tidy-up.
 */
function tableHeaderLines(lines: readonly string[]): boolean[] {
  const headers: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    if (open !== null) {
      headers.push(false);
      if (line.includes(open)) open = null;
      continue;
    }
    headers.push(/^\s*\[/.test(line));
    for (const delim of MULTILINE_DELIMS) {
      const first = line.indexOf(delim);
      if (first !== -1 && line.indexOf(delim, first + 3) === -1) open = delim;
    }
  }
  return headers;
}

/**
 * How our server is defined in this file, if at all.
 *
 * `other` covers every spelling that is not the canonical table AILoud writes:
 * an inline table under `[mcp_servers]`, a quoted key, a spaced header. Those
 * are refused rather than edited, because appending our table beside an
 * existing definition of the same key is a hard TOML error -- which costs the
 * user their WHOLE Codex configuration, not just this server.
 */
export function tomlServerForm(text: string): 'absent' | 'canonical' | 'other' {
  const lines = text.split('\n');
  const headers = tableHeaderLines(lines);
  for (const [at, line] of lines.entries()) {
    if (headers[at] !== true) continue;
    const header = line.trim();
    if (header === TOML_HEADER || header.startsWith(TOML_SUBTABLE)) return 'canonical';
    if (new RegExp(`^\\[\\s*mcp_servers\\s*\\.\\s*"?${SERVER_NAME}"?\\s*[.\\]]`).test(header)) {
      return 'other';
    }
  }
  let inServers = false;
  for (const [at, line] of lines.entries()) {
    if (headers[at] === true) {
      inServers = line.trim() === '[mcp_servers]';
      continue;
    }
    if (inServers && new RegExp(`^\\s*"?${SERVER_NAME}"?\\s*=`).test(line)) return 'other';
  }
  return 'absent';
}

/** The line range our table and its sub-tables occupy, or null. */
function tomlTableRange(text: string): { from: number; to: number } | null {
  const lines = text.split('\n');
  const headers = tableHeaderLines(lines);
  const from = lines.findIndex(
    (line, at) =>
      headers[at] === true &&
      (line.trim() === TOML_HEADER || line.trim().startsWith(TOML_SUBTABLE)),
  );
  if (from === -1) return null;

  let to = lines.length;
  for (let at = from + 1; at < lines.length; at += 1) {
    if (headers[at] !== true) continue;
    // Our own sub-tables go with the parent. Left behind, a table like
    // `[mcp_servers.ailoud.env]` still implicitly defines the server -- with
    // an env and no command -- and no later command could see or clean it.
    if (lines[at]!.trim().startsWith(TOML_SUBTABLE)) continue;
    to = at;
    break;
  }
  return { from, to };
}

function tomlTable(): string {
  return [
    TOML_HEADER,
    `command = "${COMMAND}"`,
    `args = [${ARGS.map((a) => `"${a}"`).join(', ')}]`,
  ].join('\n');
}

function addTomlTable(previous: string | null): string {
  const text = previous ?? '';
  if (tomlServerForm(text) === 'other') {
    throw new FailureError(
      'that config.toml already defines an "ailoud" MCP server in another form (an inline ' +
        'table, or a differently spelled header). AILoud will not add a second definition: ' +
        'two definitions of one key is a TOML error that would break the whole file. Remove ' +
        'the existing entry, or leave it as it is.',
    );
  }
  const range = tomlTableRange(text);
  if (range === null) {
    const base = text.trimEnd();
    return base === '' ? `${tomlTable()}\n` : `${base}\n\n${tomlTable()}\n`;
  }
  const lines = text.split('\n');
  const replaced = [
    ...lines.slice(0, range.from),
    ...tomlTable().split('\n'),
    ...lines.slice(range.to),
  ];
  // Normalised to exactly one trailing newline: replacing a table that ran to
  // the end of the file consumed the blank final line, so a second install
  // produced bytes differing from the first by that newline alone.
  return `${replaced.join('\n').trimEnd()}\n`;
}

function removeTomlTable(previous: string): string | null {
  const range = tomlTableRange(previous);
  if (range === null) return null;
  const lines = previous.split('\n');
  const kept = [...lines.slice(0, range.from), ...lines.slice(range.to)];
  // Only the seam is tidied -- the blank lines that surrounded the table just
  // taken out. A global collapse of blank runs rewrote the user's own values:
  // a multi-line string value lost the blank lines inside it.
  while (kept.length > range.from && kept[range.from]?.trim() === '') {
    kept.splice(range.from, 1);
  }
  while (range.from > 0 && kept[range.from - 1]?.trim() === '' && kept.length > range.from) {
    kept.splice(range.from - 1, 1);
  }
  const out = kept.join('\n').replace(/\n+$/, '');
  return out === '' ? '' : `${out}\n`;
}

// --- YAML ------------------------------------------------------------------

/**
 * Hermes, through the yaml document API, which preserves comments and key
 * order -- the same reason `configWrite.ts` uses it for AILoud's own config.
 *
 * `platform_toolsets.cli` is how Hermes decides which MCP servers a CLI
 * session may use; a server registered without being listed there is loaded
 * and then never offered.
 */
function addHermesYaml(previous: string | null): string {
  // With no file to merge into, the canonical block is emitted directly. The
  // document API would have to be seeded with `{}` to have a mapping to set
  // into, and everything built from that comes out in flow style
  // (`{ mcp_servers: { ... } }`) -- valid YAML that no hand-written config
  // looks like.
  if (previous === null || previous.trim() === '') {
    return [
      'mcp_servers:',
      `  ${SERVER_NAME}:`,
      `    command: ${COMMAND}`,
      '    args:',
      ...ARGS.map((arg) => `      - ${arg}`),
      '    enabled: true',
      '',
      'platform_toolsets:',
      '  cli:',
      `    - mcp-${SERVER_NAME}`,
      '',
    ].join('\n');
  }

  const doc = parseDocument(previous);
  doc.setIn(['mcp_servers', SERVER_NAME, 'command'], COMMAND);
  doc.setIn(['mcp_servers', SERVER_NAME, 'args'], [...ARGS]);
  doc.setIn(['mcp_servers', SERVER_NAME, 'enabled'], true);

  const toolset = `mcp-${SERVER_NAME}`;
  const listed = doc.getIn(['platform_toolsets', 'cli']);
  const current = Array.isArray((listed as { toJSON?: () => unknown })?.toJSON?.())
    ? ((listed as { toJSON: () => string[] }).toJSON() as string[])
    : [];
  if (!current.includes(toolset)) {
    doc.setIn(['platform_toolsets', 'cli'], [...current, toolset]);
  }
  return doc.toString();
}

function removeHermesYaml(previous: string): string | null {
  const doc = parseDocument(previous);
  const had = doc.hasIn(['mcp_servers', SERVER_NAME]);
  if (!had) return null;
  doc.deleteIn(['mcp_servers', SERVER_NAME]);

  const listed = doc.getIn(['platform_toolsets', 'cli']) as { toJSON?: () => unknown } | undefined;
  const current = Array.isArray(listed?.toJSON?.()) ? (listed!.toJSON!() as string[]) : [];
  const kept = current.filter((entry) => entry !== `mcp-${SERVER_NAME}`);
  if (kept.length !== current.length) doc.setIn(['platform_toolsets', 'cli'], kept);
  return doc.toString();
}

/**
 * Whether a configuration holds nothing but the scaffolding AILoud added.
 *
 * Used by `uninstall` to decide between rewriting a file and deleting it. A
 * file left holding `{}` records that an install once happened, which is
 * exactly what an uninstall is supposed to undo -- but a file with anything
 * else in it belongs to the user and is only ever edited, never removed.
 */
export function isEmptyConfig(format: ConfigFormat, text: string): boolean {
  const trimmed = text.trim();
  // Handles TOML entirely: removeTomlTable returns exactly '' when nothing is
  // left, so that format needs no case of its own below.
  if (trimmed === '') return true;
  switch (format) {
    case 'yaml-hermes': {
      // Only the two keys AILoud itself adds may remain, and each must be
      // empty. Treating any null-valued key as "no information" deleted a
      // user's config.yaml: `default_model:` with no value parses to null, and
      // a comment parses to nothing at all, so a file full of the user's own
      // settings and notes looked empty and was removed.
      const doc = parseDocument(trimmed);
      const asJson = doc.toJSON() as Record<string, unknown> | null;
      if (asJson === null) {
        // Nothing but comments. Not ours to delete.
        return trimmed === '';
      }
      const ours = new Set(['mcp_servers', 'platform_toolsets']);
      return Object.entries(asJson).every(([key, value]) => ours.has(key) && isEmptyValue(value));
    }
    default: {
      const root = tryParseJson(trimmed);
      // Unparseable: not ours to delete.
      if (root === null) return false;
      // `$schema` alone is scaffolding -- opencode's file is created with it
      // and nothing else when AILoud is the only server.
      const keys = Object.keys(root).filter((key) => key !== '$schema');
      return keys.length === 0;
    }
  }
}

/**
 * Whether a parsed value carries no information.
 *
 * Recursive, because the shapes left behind nest: removing our Hermes entry
 * leaves `{mcp_servers: {}, platform_toolsets: {cli: []}}`, and a check that
 * only looked one level down called that non-empty and kept the file.
 */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.every(isEmptyValue);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isEmptyValue);
  }
  return false;
}
