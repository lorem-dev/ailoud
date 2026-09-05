import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { safePathComponent } from './safePath.js';

describe('safePathComponent', () => {
  it('cannot escape the directory it is joined onto', () => {
    // The bug this exists for: `speaker: "../../../../tmp/PWNED"` made
    // get_transcript write the transcript to /tmp/PWNED.txt.
    for (const attack of [
      '../../../../tmp/PWNED',
      '/etc/passwd',
      '..',
      '../',
      'a/../../b',
      '.ssh/authorized_keys',
    ]) {
      const component = safePathComponent(attack);
      // What actually matters: one path segment, and the join stays inside.
      expect(component, attack).not.toContain('/');
      expect(component, attack).not.toBe('..');
      expect(join('/run/dir', `${component}.txt`).startsWith('/run/dir/'), attack).toBe(true);
    }
  });

  it('leaves an ordinary name untouched', () => {
    for (const name of ['Ann', 'speaker_00', 'Ann-Marie', 'a.b_c-1']) {
      expect(safePathComponent(name), name).toBe(name);
    }
  });

  it('keeps two names that sanitise alike apart', () => {
    // Otherwise one speaker's transcript silently overwrites another's.
    expect(safePathComponent('Ann/Bob')).not.toBe(safePathComponent('Ann Bob'));
  });

  it('is stable for the same input', () => {
    expect(safePathComponent('Ann/Bob')).toBe(safePathComponent('Ann/Bob'));
  });

  it('handles a name of nothing but separators', () => {
    const out = safePathComponent('///');
    expect(out).not.toBe('');
    expect(join('/run', `${out}.txt`).startsWith('/run/')).toBe(true);
  });

  it('caps the length, so a long name cannot break the filesystem', () => {
    expect(safePathComponent('x'.repeat(500)).length).toBeLessThan(80);
  });

  it('handles a non-ASCII name without escaping', () => {
    const out = safePathComponent('Милена');
    expect(out).not.toContain('/');
    expect(join('/run', `${out}.txt`).startsWith('/run/')).toBe(true);
  });
});
