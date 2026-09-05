import { describe, expect, it } from 'vitest';
import { END, START, hasBlock, rulesBlock, withBlock, withoutBlock } from './rulesBlock.js';

describe('rulesBlock', () => {
  it('is wrapped in the markers an update looks for', () => {
    const block = rulesBlock();
    expect(block.startsWith(START)).toBe(true);
    expect(block.endsWith(END)).toBe(true);
  });

  it('tells the agent the three things it gets wrong unprompted', () => {
    const block = rulesBlock();
    expect(block).toMatch(/search_transcripts/);
    expect(block).toMatch(/BEFORE/);
    expect(block).toMatch(/file path rather than text/);
    expect(block).toMatch(/list_untagged/);
  });

  it('offers a shell fallback, for an agent with no MCP', () => {
    expect(rulesBlock()).toMatch(/ailoud audio search/);
  });

  it('stays short, since it shares a file with the project instructions', () => {
    expect(rulesBlock().split('\n').length).toBeLessThan(30);
  });
});

describe('withBlock', () => {
  it('creates the file content when there was none', () => {
    expect(withBlock('')).toBe(`${rulesBlock()}\n`);
  });

  it('appends after existing content, with one blank line', () => {
    const out = withBlock('# Project\n\nSome rules.\n');
    expect(out).toBe(`# Project\n\nSome rules.\n\n${rulesBlock()}\n`);
  });

  it('is idempotent: twice gives the same bytes as once', () => {
    // What makes `update` safe to run on a schedule, and a diff after it show
    // only what actually changed.
    const once = withBlock('# Project\n');
    expect(withBlock(once)).toBe(once);
  });

  it('replaces an older block in place, leaving everything around it alone', () => {
    const older = `${START}\n## AILoud\n\nold text\n${END}`;
    const file = `# Project\n\n${older}\n\n## After\n\nkeep me\n`;
    const out = withBlock(file);
    expect(out).toContain('# Project');
    expect(out).toContain('keep me');
    expect(out).not.toContain('old text');
    expect(out.match(new RegExp(START, 'g'))).toHaveLength(1);
  });

  it("leaves another tool's block untouched", () => {
    const file = `# Project\n\n<!-- CODEGRAPH_START -->\nCodeGraph rules\n<!-- CODEGRAPH_END -->\n`;
    const out = withBlock(file);
    expect(out).toContain('CodeGraph rules');
    expect(out).toContain(START);
  });
});

describe('withoutBlock', () => {
  it('says nothing was there rather than reporting a change it did not make', () => {
    // An uninstall that claims to have cleaned a file it never touched teaches
    // the user to distrust it.
    expect(withoutBlock('# Project\n')).toBeNull();
  });

  it('removes the block and the blank line it introduced', () => {
    const file = withBlock('# Project\n\nSome rules.\n');
    expect(withoutBlock(file)).toBe('# Project\n\nSome rules.\n');
  });

  it('round-trips: add then remove gives back the original', () => {
    for (const original of ['# Project\n', '# P\n\nrules\n', 'one line\n']) {
      expect(withoutBlock(withBlock(original))).toBe(original);
    }
  });

  it('empties a file that held nothing else', () => {
    expect(withoutBlock(withBlock(''))).toBe('');
  });

  it('keeps content that followed the block', () => {
    const file = `# Project\n\n${rulesBlock()}\n\n## After\n\nkeep me\n`;
    const out = withoutBlock(file);
    expect(out).toBe('# Project\n\n## After\n\nkeep me\n');
  });

  it("keeps another tool's block", () => {
    const file = withBlock('<!-- CODEGRAPH_START -->\nx\n<!-- CODEGRAPH_END -->\n');
    const out = withoutBlock(file);
    expect(out).toContain('CODEGRAPH_START');
    expect(out).not.toContain(START);
  });
});

describe('hasBlock', () => {
  it('needs both markers, in order', () => {
    expect(hasBlock(rulesBlock())).toBe(true);
    expect(hasBlock(START)).toBe(false);
    expect(hasBlock(`${END}\n${START}`)).toBe(false);
  });
});
