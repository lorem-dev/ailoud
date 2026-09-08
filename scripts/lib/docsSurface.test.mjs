import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSurface,
  collectDocFiles,
  extractFlags,
  extractInvocations,
  extractSurface,
} from './docsSurface.mjs';

describe('extractFlags', () => {
  it('finds every long flag in the text', () => {
    expect(extractFlags('ailoud audio ls --tag standup --json')).toEqual(['--tag', '--json']);
  });

  it('does not care which command a flag belongs to', () => {
    // The safety rule covers every documented flag, not only ailoud's own --
    // scoping this to ailoud's vocabulary would need the script to know it.
    expect(extractFlags('uv run --with-requirements docs/requirements.txt')).toEqual([
      '--with-requirements',
    ]);
  });

  it('ignores a table separator row and a bare double dash', () => {
    expect(extractFlags('| ---- | ---- |')).toEqual([]);
    expect(extractFlags('a note -- like this one')).toEqual([]);
  });

  it('returns nothing for text with no flag', () => {
    expect(extractFlags('nothing to see here')).toEqual([]);
  });
});

describe('extractInvocations', () => {
  it('strips a flag and keeps the command words', () => {
    expect(extractInvocations('`ailoud audio ls --json`')).toEqual(['ailoud audio ls']);
  });

  it('reads a bare invocation from a fenced code block line', () => {
    expect(extractInvocations('ailoud audio transcribe')).toEqual(['ailoud audio transcribe']);
  });

  it('stops at a placeholder in brackets or angle brackets', () => {
    expect(extractInvocations('ailoud audio import <path...> [--title <text>]')).toEqual([
      'ailoud audio import',
    ]);
    expect(extractInvocations('ailoud doctor [--fix] [--yes]')).toEqual(['ailoud doctor']);
  });

  it('stops at a real id, which is never a plain lowercase word', () => {
    expect(extractInvocations('ailoud audio show 01M1B2')).toEqual(['ailoud audio show']);
    expect(extractInvocations('ailoud report show SUM0')).toEqual(['ailoud report show']);
  });

  it('stops at a quoted argument', () => {
    expect(extractInvocations('ailoud audio f "before sunrise"    # phrase search')).toEqual([
      'ailoud audio f',
    ]);
  });

  it('stops at a shell comment even with no other argument', () => {
    expect(
      extractInvocations('ailoud mcp update              # refresh the block after upgrading'),
    ).toEqual(['ailoud mcp update']);
  });

  it('stops at a non-ASCII word, so a Russian search example is not swallowed whole', () => {
    // Source stays ASCII-only per AGENTS.md; this \u escape spells out the
    // same Cyrillic query search.md uses ("vstrecha", meaning "meeting").
    const query = '\u0432\u0441\u0442\u0440\u0435\u0447\u0430';
    expect(extractInvocations(`ailoud audio f ${query}     # finds a match`)).toEqual([
      'ailoud audio f',
    ]);
  });

  it('keeps a pipe-separated alias line whole', () => {
    expect(
      extractInvocations(
        'ailoud audio|recordings   import transcribe summarize search ls show annotate rm',
      ),
    ).toEqual(['ailoud audio|recordings import transcribe summarize search ls show annotate rm']);
  });

  it('finds every invocation on a line, not only the first', () => {
    expect(
      extractInvocations(
        'The old top-level spellings still work: `ailoud ls`, `ailoud show`, `ailoud rm`.',
      ),
    ).toEqual(['ailoud ls', 'ailoud show', 'ailoud rm']);
  });

  it('finds a command piped into from something else', () => {
    expect(extractInvocations("echo '{}' | ailoud mcp")).toEqual(['ailoud mcp']);
  });

  it('ignores a URI scheme that merely starts with the word ailoud', () => {
    expect(extractInvocations('ailoud://recording/{id}/transcript')).toEqual([]);
  });

  it('ignores a JSON key or value naming the binary, not invoking it', () => {
    expect(extractInvocations('"ailoud": { "command": "ailoud", "args": ["mcp"] }')).toEqual([]);
  });

  it('ignores a scoped package name', () => {
    expect(
      extractInvocations('publishes `@ailoud/core`, `@ailoud/providers` and `ailoud`.'),
    ).toEqual(['ailoud']);
  });

  it('keeps a bare mention with nothing after it', () => {
    expect(extractInvocations('cd ailoud')).toEqual(['ailoud']);
  });

  it('normalises runs of whitespace', () => {
    expect(extractInvocations('ailoud   audio    ls')).toEqual(['ailoud audio ls']);
  });

  it('finds nothing on a line that never says ailoud', () => {
    expect(extractInvocations('nothing to see here')).toEqual([]);
  });
});

describe('extractSurface', () => {
  it('combines flags and invocations from one file, deduplicated', () => {
    const text = [
      'Run `ailoud audio ls --json` for machine output.',
      '',
      '```',
      'ailoud audio ls --json',
      '```',
    ].join('\n');

    expect(extractSurface(text)).toEqual(new Set(['--json', 'ailoud audio ls']));
  });
});

describe('collectDocFiles and buildSurface', () => {
  const made = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeRepo(files) {
    const root = mkdtempSync(join(tmpdir(), 'ailoud-docs-surface-lib-'));
    made.push(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    for (const [relativePath, content] of Object.entries(files)) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    return root;
  }

  it('collects README.md and every .md file under docs/, and nothing else', () => {
    const root = makeRepo({
      'README.md': '# readme',
      'CONTRIBUTING.md': '# not collected',
      'docs/index.md': '# index',
      'docs/usage/cli.md': '# cli',
      'docs/usage/notes.txt': 'not markdown',
    });

    const files = collectDocFiles(root).map((f) => f.slice(root.length + 1));
    expect(files).toEqual(['README.md', 'docs/index.md', 'docs/usage/cli.md']);
  });

  it('builds one sorted, deduplicated surface across every collected file', () => {
    const root = makeRepo({
      'README.md': '```shell\nailoud audio ls --json\n```\n',
      'docs/usage/recordings.md': 'Run `ailoud audio ls` again for the same thing.\n',
      'docs/mcp.md': '`ailoud mcp` serves the library. See `ailoud mcp install`.\n',
    });

    const surface = buildSurface(root);
    expect(surface).toEqual([...surface].sort());
    expect(new Set(surface).size).toBe(surface.length);
    expect(surface).toEqual(
      expect.arrayContaining(['--json', 'ailoud audio ls', 'ailoud mcp', 'ailoud mcp install']),
    );
  });
});
