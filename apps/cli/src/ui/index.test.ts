import { describe, expect, it } from 'vitest';
import { createUi } from './index.js';
import { PlainUi } from './plain.js';
import { PrettyUi } from './pretty.js';

describe('createUi', () => {
  it('selects PrettyUi on a TTY that is wide enough', () => {
    expect(createUi(() => {}, true, 80)).toBeInstanceOf(PrettyUi);
    expect(createUi(() => {}, true, 200)).toBeInstanceOf(PrettyUi);
  });

  it('selects PlainUi when stdout is not a TTY, regardless of width', () => {
    expect(createUi(() => {}, false, 200)).toBeInstanceOf(PlainUi);
  });

  it('falls back to PlainUi below the width the pretty layout needs', () => {
    expect(createUi(() => {}, true, 79)).toBeInstanceOf(PlainUi);
    expect(createUi(() => {}, true, 1)).toBeInstanceOf(PlainUi);
  });

  it('falls back to PlainUi when the width is unmeasurable', () => {
    // An unsized pty reports `columns` as `undefined` or `0` -- clack's own
    // line-wrapping has nothing sane to divide by at either, and collapses
    // to one character per line with raw ANSI escapes leaking as text.
    expect(createUi(() => {}, true, undefined)).toBeInstanceOf(PlainUi);
    expect(createUi(() => {}, true, 0)).toBeInstanceOf(PlainUi);
  });
});
