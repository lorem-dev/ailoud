/** Characters appended to show that a sample was cut short. ASCII, per the repo's convention. */
const ELLIPSIS = '...';

/**
 * Shortens `text` to `maxLength` characters, marking that it was cut.
 *
 * Slices by code point rather than by UTF-16 code unit: a plain `.slice()`
 * can land inside a surrogate pair -- any astral-plane character, so emoji
 * and some CJK extensions -- and emit a lone surrogate. Transcripts are
 * multilingual by design, so this is not a hypothetical edge case.
 *
 * The ellipsis is appended, not counted against `maxLength`: the caller asked
 * for that many characters of content, and silently returning three fewer
 * would be a surprising reading of the request.
 */
export function truncateSample(text: string, maxLength: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;
  return characters.slice(0, maxLength).join('') + ELLIPSIS;
}

/**
 * Renders a piece of recording text for display in a terminal: wrapped in
 * double quotes, with anything that would confuse a reader or the terminal
 * itself escaped.
 *
 * Quoting matters because a preview sits in a column beside other fields, and
 * without delimiters there is no way to tell trailing whitespace, an empty
 * transcript, and a missing one apart.
 *
 * Escaping control characters is not cosmetic. Transcript text comes from
 * whatever audio a user fed in, and a transcript containing an escape
 * character would otherwise emit a real ANSI control sequence when printed --
 * repositioning the cursor, recolouring the rest of the session, or worse.
 * Rendering it as a visible \\u001b shows the user what is actually in their
 * data and leaves the terminal alone.
 */
export function quoteSample(text: string): string {
  let out = '';
  for (const character of text) {
    switch (character) {
      // Backslash first: it is the escape character, so escaping it after
      // anything else would double-escape what those produced.
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = character.codePointAt(0) ?? 0;
        // C0 controls and DEL. Everything printable, including every
        // non-Latin script, passes through untouched -- escaping Cyrillic or
        // CJK would make a multilingual transcript unreadable.
        out +=
          code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : character;
      }
    }
  }
  return `"${out}"`;
}
