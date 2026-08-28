import { PlainUi } from './plain.js';
import { PrettyUi } from './pretty.js';
import type { Ui } from './types.js';

export type { Check, RecordingRow, Ui } from './types.js';
export { PlainUi } from './plain.js';
export { PrettyUi } from './pretty.js';

/**
 * Picks the UI implementation for this process: `PrettyUi` on a real
 * terminal, `PlainUi` otherwise. `isTTY` defaults to the live check so
 * production code gets the real answer without having to pass it, while
 * tests can pin either branch explicitly.
 */
export function createUi(
  write: (line: string) => void,
  isTTY: boolean = process.stdout.isTTY === true,
): Ui {
  return isTTY ? new PrettyUi() : new PlainUi(write);
}
