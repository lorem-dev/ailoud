import { PlainUi } from './plain.js';
import { PrettyUi } from './pretty.js';
import type { Ui } from './types.js';

export type { Check, RecordingRow, Ui } from './types.js';
export { PlainUi } from './plain.js';
export { PrettyUi } from './pretty.js';

/**
 * Below this width, `PrettyUi`'s `ls` table (id, duration, lang, and a
 * preview column) cannot lay out without wrapping mid-word -- and at an
 * unmeasurable width (`columns` undefined or 0, e.g. an unsized pty),
 * clack's own line-wrapping has nothing sane to divide by and collapses
 * to one character per line, leaking raw ANSI escapes as literal text.
 * Plain output stays correct and readable at any width, including zero,
 * so narrow or unmeasured terminals fall back to it instead of risking
 * that collapse.
 */
const MIN_PRETTY_WIDTH = 80;

/**
 * Picks the UI implementation for this process: `PrettyUi` on a real,
 * wide-enough terminal, `PlainUi` otherwise. `isTTY` and `columns` default
 * to the live checks so production code gets the real answer without
 * having to pass them, while tests can pin either explicitly.
 */
export function createUi(
  write: (line: string) => void,
  isTTY: boolean = process.stdout.isTTY === true,
  columns: number | undefined = process.stdout.columns,
): Ui {
  const wideEnough = typeof columns === 'number' && columns >= MIN_PRETTY_WIDTH;
  return isTTY && wideEnough ? new PrettyUi() : new PlainUi(write);
}
