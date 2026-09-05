import { describe, expect, it } from 'vitest';
import { PAGER_LINE_THRESHOLD, page, shouldPage } from './pager.js';

const lines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `l${i}`).join('\n');

describe('shouldPage', () => {
  it('pages output past the threshold on a terminal', () => {
    expect(shouldPage(lines(PAGER_LINE_THRESHOLD + 1), true, {})).toBe(true);
  });

  it('leaves output that already fits alone', () => {
    // Paging would put a full-screen program in front of something that was
    // readable where it was.
    expect(shouldPage(lines(PAGER_LINE_THRESHOLD), true, {})).toBe(false);
    expect(shouldPage(lines(3), true, {})).toBe(false);
  });

  it('never pages when stdout is not a terminal', () => {
    // "ailoud summarize ID > report.md" wants the bytes. Handing them to less
    // would hang waiting for a keypress nobody can give.
    expect(shouldPage(lines(500), false, {})).toBe(false);
  });

  it('honours PAGER="" as "do not page"', () => {
    expect(shouldPage(lines(500), true, { PAGER: '' })).toBe(false);
  });

  it('still pages when PAGER names something', () => {
    expect(shouldPage(lines(500), true, { PAGER: 'more' })).toBe(true);
  });
});

describe('page', () => {
  it('prints plainly rather than failing when the pager is not there', async () => {
    // A machine without less should still be able to read a report.
    const chunks: string[] = [];
    await page('the report', (chunk) => chunks.push(chunk), {
      PAGER: 'ailoud-no-such-pager-binary',
    });
    expect(chunks).toEqual(['the report']);
  });

  it('prints plainly when PAGER is only whitespace', async () => {
    const chunks: string[] = [];
    await page('the report', (chunk) => chunks.push(chunk), { PAGER: '   ' });
    expect(chunks).toEqual(['the report']);
  });

  it('feeds the text through a pager that does exist, printing nothing itself', async () => {
    // `cat` stands in for less: it drains stdin and exits, which is the
    // contract page() depends on. Nothing reaches the fallback writer.
    const chunks: string[] = [];
    await page('the report', (chunk) => chunks.push(chunk), { PAGER: 'cat' });
    expect(chunks).toEqual([]);
  });

  it('returns when the pager exits early instead of rejecting on EPIPE', async () => {
    // Quitting with q before the text is drained looks like EPIPE from here.
    // It is the user saying "I have read enough", not a failure.
    const chunks: string[] = [];
    await expect(
      page(lines(50_000), (chunk) => chunks.push(chunk), { PAGER: 'true' }),
    ).resolves.toBeUndefined();
  });
});
