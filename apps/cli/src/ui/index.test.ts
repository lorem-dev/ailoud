import { describe, expect, it } from 'vitest';
import { createUi, PlainUi, PrettyUi } from './index.js';

describe('createUi', () => {
  it('picks PrettyUi on a terminal, at any usable width', () => {
    // The frame, the gutter and the doctor checklist lay out at any width.
    // Only the `ls` table needs room, and it degrades on its own (see
    // pretty.test.ts) rather than costing every other command its frame.
    expect(createUi(() => {}, true, 40)).toBeInstanceOf(PrettyUi);
    expect(createUi(() => {}, true, 75)).toBeInstanceOf(PrettyUi);
    expect(createUi(() => {}, true, 200)).toBeInstanceOf(PrettyUi);
  });

  it('picks PlainUi when stdout is not a terminal', () => {
    expect(createUi(() => {}, false, 200)).toBeInstanceOf(PlainUi);
  });

  it('picks PlainUi when the width cannot be measured', () => {
    // An unsized pty reports 0 or undefined. Clack divides by that width
    // when wrapping and collapses to one character per line, leaking raw
    // ANSI escapes as literal text, so plain output is the only safe answer.
    expect(createUi(() => {}, true, undefined)).toBeInstanceOf(PlainUi);
    expect(createUi(() => {}, true, 0)).toBeInstanceOf(PlainUi);
  });
});
