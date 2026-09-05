import { describe, expect, it } from 'vitest';
import {
  SERVER_NAME,
  addServer,
  hasServer,
  isEmptyConfig,
  removeServer,
  stripJsonComments,
} from './agentConfig.js';
import type { ConfigFormat } from './agents.js';

const FORMATS: readonly ConfigFormat[] = [
  'json-mcp-servers',
  'json-mcp-servers-tools',
  'jsonc-opencode',
  'toml-codex',
  'yaml-hermes',
];

describe('every format', () => {
  it('registers the server under one agreed name', () => {
    for (const format of FORMATS) {
      expect(addServer(format, null), format).toContain(SERVER_NAME);
    }
  });

  it('tells the agent to run `ailoud mcp`', () => {
    for (const format of FORMATS) {
      const text = addServer(format, null);
      expect(text, format).toContain('ailoud');
      expect(text, format).toContain('mcp');
    }
  });

  it('reports the server as present after adding it', () => {
    for (const format of FORMATS) {
      expect(hasServer(format, addServer(format, null)), format).toBe(true);
    }
  });

  it('reports it absent in a file that does not have it', () => {
    expect(hasServer('json-mcp-servers', '{"mcpServers":{"other":{}}}')).toBe(false);
    expect(hasServer('toml-codex', '[mcp_servers.other]\ncommand = "x"')).toBe(false);
  });

  it('is idempotent: adding twice gives the same bytes as once', () => {
    for (const format of FORMATS) {
      const once = addServer(format, null);
      expect(addServer(format, once), format).toBe(once);
    }
  });

  it('round-trips to an empty configuration', () => {
    for (const format of FORMATS) {
      const removed = removeServer(format, addServer(format, null));
      expect(removed, format).not.toBeNull();
      expect(isEmptyConfig(format, removed!), format).toBe(true);
    }
  });

  it('says nothing was there rather than reporting a change it did not make', () => {
    expect(removeServer('json-mcp-servers', '{"mcpServers":{"other":{}}}')).toBeNull();
    expect(removeServer('toml-codex', '[other]\nx = 1')).toBeNull();
    expect(removeServer('yaml-hermes', 'mcp_servers:\n  other:\n    command: x\n')).toBeNull();
  });
});

describe('keeping other servers', () => {
  it('leaves another agent entry alone in JSON', () => {
    const before = JSON.stringify({ mcpServers: { other: { command: 'x' } } });
    const after = addServer('json-mcp-servers', before);
    expect(JSON.parse(after).mcpServers.other.command).toBe('x');
    const removed = removeServer('json-mcp-servers', after)!;
    expect(JSON.parse(removed).mcpServers.other.command).toBe('x');
    expect(isEmptyConfig('json-mcp-servers', removed)).toBe(false);
  });

  it('leaves another table and its comments alone in TOML', () => {
    // config.toml is hand-written, with comments, and no TOML serialiser
    // preserves those -- which is why this is a targeted text edit.
    const before = '# my settings\n[model]\nname = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n';
    const after = addServer('toml-codex', before);
    expect(after).toContain('# my settings');
    expect(after).toContain('[mcp_servers.other]');
    const removed = removeServer('toml-codex', after)!;
    expect(removed).toContain('# my settings');
    expect(removed).toContain('name = "gpt"');
    expect(removed).not.toContain(`[mcp_servers.${SERVER_NAME}]`);
  });

  it('replaces our TOML table in place when it sits before another one', () => {
    const withOurs = addServer('toml-codex', '[a]\nx = 1\n');
    const withMore = `${withOurs}\n[z]\ny = 2\n`;
    const again = addServer('toml-codex', withMore);
    expect(again).toContain('[a]');
    expect(again).toContain('[z]');
    expect(again.match(new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\]`, 'g'))).toHaveLength(1);
  });

  it('leaves comments and other servers alone in Hermes YAML', () => {
    const before = '# hermes notes\nmcp_servers:\n  other:\n    command: x\n';
    const after = addServer('yaml-hermes', before);
    expect(after).toContain('# hermes notes');
    expect(after).toContain('other:');
    const removed = removeServer('yaml-hermes', after)!;
    expect(removed).toContain('# hermes notes');
    expect(removed).toContain('other:');
  });
});

describe('format specifics', () => {
  it('gives Copilot the tool allow-list it needs', () => {
    // Without it the server connects and none of its tools are offered.
    const parsed = JSON.parse(addServer('json-mcp-servers-tools', null));
    expect(parsed.mcpServers[SERVER_NAME].tools).toEqual(['*']);
  });

  it('gives opencode its schema and its command array shape', () => {
    const parsed = JSON.parse(addServer('jsonc-opencode', null));
    expect(parsed['$schema']).toContain('opencode.ai');
    expect(parsed.mcp[SERVER_NAME].command).toEqual(['ailoud', 'mcp']);
    expect(parsed.mcp[SERVER_NAME].enabled).toBe(true);
  });

  it('lists the Hermes toolset, or the server is loaded and never offered', () => {
    expect(addServer('yaml-hermes', null)).toContain(`mcp-${SERVER_NAME}`);
  });

  it('writes Hermes YAML in block style, as a hand-written config looks', () => {
    const text = addServer('yaml-hermes', null);
    expect(text).toMatch(/^mcp_servers:\n/);
    expect(text).not.toContain('{');
  });

  it('drops the Hermes toolset entry on removal', () => {
    const removed = removeServer('yaml-hermes', addServer('yaml-hermes', null))!;
    expect(removed).not.toContain(`mcp-${SERVER_NAME}`);
  });
});

describe('stripJsonComments', () => {
  it('removes line and block comments', () => {
    expect(JSON.parse(stripJsonComments('{ // hi\n "a": 1 /* there */ }')).a).toBe(1);
  });

  it('leaves a // inside a string alone', () => {
    // A version of this that did not truncated every URL in the file.
    const text = '{ "$schema": "https://opencode.ai/config.json" }';
    expect(JSON.parse(stripJsonComments(text))['$schema']).toBe('https://opencode.ai/config.json');
  });

  it('leaves an escaped quote alone', () => {
    expect(JSON.parse(stripJsonComments('{ "a": "say \\" // no" }')).a).toBe('say " // no');
  });

  it('survives an unterminated block comment', () => {
    expect(() => stripJsonComments('{ "a": 1 } /* never closed')).not.toThrow();
  });
});

describe('isEmptyConfig', () => {
  it("does not call a file with the user's own content empty", () => {
    expect(isEmptyConfig('json-mcp-servers', '{"other":1}')).toBe(false);
    expect(isEmptyConfig('toml-codex', '[other]\nx = 1')).toBe(false);
    expect(isEmptyConfig('yaml-hermes', 'mcp_servers:\n  other:\n    command: x')).toBe(false);
  });

  it('sees through nested emptiness', () => {
    // Removing our Hermes entry leaves {mcp_servers:{}, platform_toolsets:{cli:[]}},
    // which a one-level check called non-empty and kept.
    expect(isEmptyConfig('yaml-hermes', 'mcp_servers: {}\nplatform_toolsets:\n  cli: []\n')).toBe(
      true,
    );
  });

  it('treats a lone $schema as scaffolding', () => {
    expect(isEmptyConfig('jsonc-opencode', '{"$schema":"https://opencode.ai/config.json"}')).toBe(
      true,
    );
  });

  it('refuses to call an unparseable file empty', () => {
    // Not ours to delete.
    expect(isEmptyConfig('json-mcp-servers', '{ not json')).toBe(false);
  });
});

describe('a config file AILoud did not write', () => {
  it('refuses a TOML file that defines our server another way, rather than corrupting it', () => {
    // Appending our table beside an inline definition of the same key is a
    // hard TOML error, which costs the user their WHOLE Codex config.
    const inline = '[mcp_servers]\nailoud = { command = "ailoud", args = ["mcp"] }\n';
    expect(() => addServer('toml-codex', inline)).toThrow(/another form/);
    for (const spelling of ['[ mcp_servers.ailoud ]', '[mcp_servers."ailoud"]']) {
      expect(() => addServer('toml-codex', `${spelling}\ncommand = "x"\n`), spelling).toThrow(
        /another form/,
      );
    }
  });

  it('leaves blank lines inside a multi-line TOML value alone', () => {
    // A global collapse of blank runs rewrote the user's own values.
    const before =
      '[model]\ninstructions = """\nline one\n\n\nline four\n"""\n\n' +
      '[mcp_servers.ailoud]\ncommand = "ailoud"\nargs = ["mcp"]\n';
    expect(removeServer('toml-codex', before)!).toContain('line one\n\n\nline four');
  });

  it('does not mistake a bracket inside a TOML string for a table header', () => {
    const before =
      '[mcp_servers.ailoud]\ncommand = "ailoud"\nnote = """\n[not a table]\n"""\n\n[model]\nn = 1\n';
    const after = removeServer('toml-codex', before)!;
    expect(after).not.toContain('not a table');
    expect(after).toContain('[model]');
  });

  it('removes our TOML sub-tables with their parent', () => {
    // Left behind, [mcp_servers.ailoud.env] still implicitly defines the
    // server -- with an env and no command -- and nothing could clean it.
    const before =
      '[mcp_servers.ailoud]\ncommand = "ailoud"\nargs = ["mcp"]\n' +
      '[mcp_servers.ailoud.env]\nX = "1"\n\n[model]\nn = 1\n';
    const after = removeServer('toml-codex', before)!;
    expect(after).not.toContain('ailoud');
    expect(after).toContain('[model]');
  });

  it('does not read our name out of ordinary JSON data', () => {
    // Claude Code stores prompt history in ~/.claude.json. A regexp for the
    // server name matched "run ailoud: hi" there, and `mcp update` then
    // installed into an agent the user never chose.
    const history = JSON.stringify({
      projects: { '/w': { history: [{ display: 'run ailoud: hi' }] } },
    });
    expect(hasServer('json-mcp-servers', history)).toBe(false);
  });

  it('does not read our name out of a YAML comment', () => {
    expect(hasServer('yaml-hermes', '# ailoud: not installed\nmcp_servers: {}\n')).toBe(false);
  });

  it("never calls a Hermes config with the user's own keys empty", () => {
    // `default_model:` with no value parses to null, and a comment parses to
    // nothing at all -- so a file full of settings and notes looked empty and
    // was deleted.
    const theirs =
      '# Hermes configuration\ndefault_model:\n\nmcp_servers: {}\nplatform_toolsets:\n  cli: []\n';
    expect(isEmptyConfig('yaml-hermes', theirs)).toBe(false);
    expect(isEmptyConfig('yaml-hermes', '# just a note\n')).toBe(false);
  });

  it('tolerates a trailing comma and a byte-order mark', () => {
    // Both are legal JSONC and what editors leave behind. JSON.parse threw
    // mid-install, after earlier agents had already been written.
    expect(addServer('jsonc-opencode', '{\n  // mine\n  "theme": "dark",\n}\n')).toContain('theme');
    expect(addServer('json-mcp-servers', '﻿{"mcpServers":{}}')).toContain('ailoud');
  });

  it('refuses to rewrite a file that is not JSON at all', () => {
    expect(() => addServer('json-mcp-servers', '{ not json')).toThrow(/not valid JSON/);
  });
});
