import { describe, expect, it } from 'vitest';
import { createUi } from './index.js';
import { PlainUi } from './plain.js';
import { PrettyUi } from './pretty.js';

describe('createUi', () => {
  it('selects PrettyUi when stdout is a TTY', () => {
    expect(createUi(() => {}, true)).toBeInstanceOf(PrettyUi);
  });

  it('selects PlainUi when stdout is not a TTY', () => {
    expect(createUi(() => {}, false)).toBeInstanceOf(PlainUi);
  });
});
