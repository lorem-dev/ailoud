import { describe, expect, it } from 'vitest';
import { blockRange, hasBlock, withBlock, withoutBlock } from './markerBlock.js';

const HASH = { start: '# >>> ailoud >>>', end: '# <<< ailoud <<<' };
const block = `${HASH.start}\nexport PATH=x\n${HASH.end}`;

describe('markerBlock', () => {
  it('inserts into an empty file with no leading blank line', () => {
    expect(withBlock('', block, HASH)).toBe(`${block}\n`);
  });

  it('appends after existing content with exactly one blank line', () => {
    // Running install twice must produce the same bytes as running it once,
    // or `update` on a schedule shows a diff every time it runs.
    const once = withBlock('# my rc\n', block, HASH);
    expect(once).toBe(`# my rc\n\n${block}\n`);
    expect(withBlock(once, block, HASH)).toBe(once);
  });

  it('replaces an existing block and leaves the text around it alone', () => {
    const before = `# top\n\n${HASH.start}\nold\n${HASH.end}\n\n# bottom\n`;
    const after = withBlock(before, block, HASH);
    expect(after).toContain('# top');
    expect(after).toContain('# bottom');
    expect(after).toContain('export PATH=x');
    expect(after).not.toContain('old');
  });

  it('pairs the LAST start before the first end, not the first start', () => {
    // A file that merely MENTIONS the marker once made the range run from
    // that sentence to the end of the real block, deleting everything
    // between -- including the user's own lines.
    const before = `# we wrap ours in ${HASH.start} markers\n\n${block}\n`;
    const range = blockRange(before, HASH)!;
    expect(before.slice(range.from, range.to)).toBe(block);
    expect(withoutBlock(before, HASH)).toContain('we wrap ours in');
  });

  it('reports absence rather than an empty range', () => {
    expect(blockRange('# nothing here\n', HASH)).toBeNull();
    expect(hasBlock('# nothing here\n', HASH)).toBe(false);
    expect(withoutBlock('# nothing here\n', HASH)).toBeNull();
  });

  it('returns an empty string when the block was the whole file', () => {
    expect(withoutBlock(`${block}\n`, HASH)).toBe('');
  });

  it('keeps two different marker pairs independent', () => {
    // The whole reason this module is parameterised: the rules writer and
    // the completions writer must not see each other's blocks.
    const other = { start: '<!-- A -->', end: '<!-- B -->' };
    const text = withBlock('', block, HASH);
    expect(hasBlock(text, other)).toBe(false);
    expect(withoutBlock(text, other)).toBeNull();
  });
});
