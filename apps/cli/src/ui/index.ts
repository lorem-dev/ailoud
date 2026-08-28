import { PlainUi } from './plain.js';
import { PrettyUi } from './pretty.js';
import type { Ui } from './types.js';

export type { Check, RecordingRow, Ui } from './types.js';
export { PlainUi } from './plain.js';
export { PrettyUi } from './pretty.js';

/**
 * Picks the UI implementation for this process.
 *
 * `PrettyUi` needs a real terminal and a width it can divide by: at an
 * unmeasurable width (`columns` undefined or 0, as an unsized pty reports)
 * clack's line wrapping collapses to one character per line and leaks raw
 * ANSI escapes as literal text. Any other width is fine -- the frame, the
 * gutter and the checklist lay out at 40 columns as happily as at 200, and
 * the one component that genuinely needs room, the `ls` table, narrows
 * itself instead of costing every other command its frame.
 */
export function createUi(
  write: (line: string) => void,
  isTTY: boolean = process.stdout.isTTY === true,
  columns: number | undefined = process.stdout.columns,
): Ui {
  const measurable = typeof columns === 'number' && columns > 0;
  return isTTY && measurable ? new PrettyUi(columns) : new PlainUi(write);
}
