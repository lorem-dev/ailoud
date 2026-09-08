// Pure extraction logic behind scripts/docs-surface.mjs.
//
// Kept out of the CLI file on purpose: this repository has twice had to move
// logic out of a `scripts/*.mjs` entry point into `scripts/lib/` because a
// test that imported the CLI file ran the CLI. Nothing here touches the
// filesystem except `collectDocFiles` and `buildSurface`, which only read.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Every long flag anywhere in the text, in the order it appears.
 *
 * Deliberately not scoped to `ailoud` commands: a flag belonging to `git`,
 * `pnpm` or `uv` shown in a documented example is exactly as real a piece of
 * documented surface as one of ours, and scoping this would need to know the
 * CLI's vocabulary -- which is the one thing a throwaway script should not
 * have to keep in step with the binary.
 */
export function extractFlags(text) {
  return text.match(/--[a-z][a-z0-9-]*/g) ?? [];
}

const CLEAN_WORD = /^[a-z][a-z0-9|-]*$/;
const TRAILING_PUNCTUATION = /[`,.;:!?)\]}'"]+$/;

/**
 * Every `ailoud ...` invocation on one line of text -- backticked inline,
 * shown bare in a fenced code block, or piped into from something else.
 *
 * Markdown fencing makes no difference here: a real invocation is always the
 * literal word "ailoud" followed by whitespace, a closing backtick or the end
 * of the line, and a mention that is not one -- a URI scheme
 * (`ailoud://recording/...`), a JSON key (`"ailoud": {`), a scoped package
 * name (`@ailoud/core`) -- never is. That one check does the job of telling a
 * command from a mention, so the caller does not need to track whether it is
 * inside a fence or a backtick span.
 *
 * Only the command words survive. Starting from "ailoud", each following
 * token is kept only while it is a bare lowercase word (letters, digits,
 * `-` and `|`, for aliases like `audio|recordings`): a flag, an id, a quoted
 * argument, a path, anything else stops the line right there. Markdown
 * attaches punctuation to the last real word of an invocation -- a closing
 * backtick, a comma from a list, a sentence's full stop -- so that is peeled
 * off a token before it is judged, and finding any there also ends the
 * invocation: punctuation there means the words after it belong to the
 * sentence, not the command.
 */
export function extractInvocations(line) {
  const invocations = [];
  const pattern = /\bailoud\b/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    const after = line[match.index + 'ailoud'.length];
    if (after !== undefined && after !== '`' && !/\s/.test(after)) continue;

    // Sliced after "ailoud" itself, not from the match start: a bare mention
    // right against a closing backtick (`` `ailoud`. `` has nothing to
    // separate the word from that punctuation, and a whitespace split of the
    // whole match would keep it glued into one unrecognisable first token.
    const tokens = line
      .slice(match.index + 'ailoud'.length)
      .split(/\s+/)
      .filter(Boolean);
    const kept = ['ailoud'];
    for (const token of tokens) {
      const core = token.replace(TRAILING_PUNCTUATION, '');
      if (core === '' || !CLEAN_WORD.test(core)) break;
      kept.push(core);
      if (core.length !== token.length) break; // punctuation ended the thought
    }
    invocations.push(kept.join(' '));
  }
  return invocations;
}

/** Every documented surface -- flags and invocations alike -- in one file's text. */
export function extractSurface(text) {
  const surface = new Set(extractFlags(text));
  for (const line of text.split('\n')) {
    for (const invocation of extractInvocations(line)) surface.add(invocation);
  }
  return surface;
}

/** Every markdown file this project documents commands in: README.md, then docs/ recursively. */
export function collectDocFiles(root) {
  const files = [join(root, 'README.md')];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && extname(entry.name) === '.md') files.push(full);
    }
  };
  walk(join(root, 'docs'));
  return files;
}

/** The sorted, deduplicated documented surface across every file in the repository at `root`. */
export function buildSurface(root) {
  const surface = new Set();
  for (const file of collectDocFiles(root)) {
    for (const item of extractSurface(readFileSync(file, 'utf8'))) surface.add(item);
  }
  return [...surface].sort();
}
