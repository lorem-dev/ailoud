import { parseDocument } from 'yaml';
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

export function hasServer(format: ConfigFormat, text: string): boolean {
  switch (format) {
    case 'toml-codex':
      return tomlTableRange(text) !== null;
    default:
      // Enough for every other format: the server name appears as a key.
      return new RegExp(`["\\s]${SERVER_NAME}["\\s]?\\s*[:=]`).test(text);
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

function editJson(previous: string | null, mutate: (root: Json) => void): string {
  const root: Json =
    previous === null || previous.trim() === ''
      ? {}
      : ((JSON.parse(stripJsonComments(previous)) ?? {}) as Json);
  mutate(root);
  return `${JSON.stringify(root, null, 2)}\n`;
}

function removeJsonKey(previous: string, container: string): string | null {
  const root = (JSON.parse(stripJsonComments(previous)) ?? {}) as Json;
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

/**
 * Where our table sits, as a line range, or null.
 *
 * A targeted text edit rather than a parse-and-regenerate: `config.toml` is a
 * file people write by hand, with comments, and no TOML serialiser preserves
 * those. The table runs from its header to the next line that begins a new
 * table, which is all this needs to know.
 */
function tomlTableRange(text: string): { from: number; to: number } | null {
  const lines = text.split('\n');
  const from = lines.findIndex((line) => line.trim() === TOML_HEADER);
  if (from === -1) return null;
  let to = lines.length;
  for (let at = from + 1; at < lines.length; at += 1) {
    if (/^\s*\[/.test(lines[at]!)) {
      to = at;
      break;
    }
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
  const out = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
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
  if (trimmed === '') return true;
  switch (format) {
    case 'toml-codex':
      return trimmed === '';
    case 'yaml-hermes': {
      const doc = parseDocument(trimmed);
      const asJson = doc.toJSON() as Record<string, unknown> | null;
      if (asJson === null) return true;
      return isEmptyValue(asJson);
    }
    default: {
      let root: Record<string, unknown>;
      try {
        root = (JSON.parse(stripJsonComments(trimmed)) ?? {}) as Record<string, unknown>;
      } catch {
        // Unparseable: not ours to delete.
        return false;
      }
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
