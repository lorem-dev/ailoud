import { spawn } from 'node:child_process';

/**
 * Output longer than this goes through a pager, when there is a terminal to
 * page on. Below it, paging would put a full-screen program in front of
 * something that already fitted.
 */
export const PAGER_LINE_THRESHOLD = 30;

/**
 * Whether this output should be paged at all.
 *
 * Never when stdout is not a terminal. A redirect or a pipe wants the bytes,
 * and handing them to `less` would either hang waiting for a keypress nobody
 * can give or write escape sequences into a file. This is the same
 * distinction `show` already draws between the frame and the payload.
 *
 * Also never when PAGER is set to the empty string, which is the
 * conventional way to say "do not page".
 */
export function shouldPage(
  text: string,
  isTTY: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isTTY) return false;
  if (env['PAGER'] === '') return false;
  return text.split('\n').length > PAGER_LINE_THRESHOLD;
}

/**
 * Shows `text` in the user's pager, resolving when they leave it.
 *
 * Uses the system pager rather than scrolling in-process. Up, down, page
 * keys, search, and quitting on `q` all arrive already implemented and
 * already behaving the way the user's other tools do -- git, man and less
 * itself -- which is what "native" means here. A hand-rolled scroller would
 * be a worse version of `less` that nobody had configured.
 *
 * Defaults to `less -R`: -R lets colour through rather than printing escape
 * sequences literally. LESS is set only if the user has not, so their own
 * configuration keeps winning.
 *
 * Falls back to writing the text out plainly if the pager cannot be started
 * at all -- a machine without `less` should still be able to read a
 * transcript.
 */
export async function page(
  text: string,
  write: (chunk: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const command = env['PAGER'] ?? 'less';
  const [program, ...args] = command.split(/\s+/).filter((part) => part !== '');
  if (program === undefined) {
    write(text);
    return;
  }

  await new Promise<void>((resolve) => {
    const child = spawn(program, args, {
      // The pager owns the terminal while it runs: it needs the real stdout
      // to draw on and the real stdin to read keys from. Only its input is a
      // pipe, because that is what we are filling.
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...env, ...(env['LESS'] === undefined ? { LESS: '-R' } : {}) },
    });

    child.on('error', () => {
      // No pager on this machine. Printing beats failing.
      write(text);
      resolve();
    });
    // EPIPE, which is what quitting the pager early looks like from here. It
    // is the user saying "I have read enough", not a failure.
    child.stdin.on('error', () => undefined);
    child.on('close', () => resolve());

    child.stdin.end(text);
  });
}
