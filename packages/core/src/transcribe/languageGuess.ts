/** A guess and where it came from, so the guess can be shown with its evidence. */
export interface LanguageGuess {
  readonly languages: readonly string[];
  /** Human phrasing of the evidence, e.g. `filename "standup-ru-en.m4a"`. */
  readonly from: string;
}

/**
 * Language names worth recognising, mapped to their codes.
 *
 * Deliberately short. This is a hint offered to a human for confirmation,
 * not a language identification library, and every entry added is another
 * chance to guess confidently wrong. English names only: the interface is
 * English-only, and a name in its own language would be caught by the
 * script check below anyway for the cases that matter.
 */
const NAMES: Readonly<Record<string, string>> = {
  english: 'en',
  russian: 'ru',
  german: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  polish: 'pl',
  portuguese: 'pt',
  dutch: 'nl',
  turkish: 'tr',
  ukrainian: 'uk',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
  arabic: 'ar',
  hindi: 'hi',
};

/**
 * Codes recognised bare, e.g. the `ru` and `en` in `standup-ru-en.m4a`.
 *
 * A closed list, not "any two letters": every filename contains two-letter
 * tokens, and accepting them all would turn `2026-08-14-q3-review` into a
 * confident guess. Kept to the languages whisper is actually good at, plus
 * the ones this tool's users record in.
 */
const CODES = new Set(Object.values(NAMES));

/** Any Cyrillic letter. A Cyrillic filename is ru far more often than not. */
const CYRILLIC = /[\u0400-\u04FF]/;

/** The filename without its directories or its extension. */
function basename(path: string): string {
  const last = path.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

/**
 * Languages the recording's own name suggests, or null.
 *
 * Null, never a fabrication. A guess invented from nothing is worse than no
 * guess: it reaches a user who is skimming, gets confirmed, and then whisper
 * is forced into the wrong language for an hour of audio. The caller shows
 * this to a human for confirmation and never acts on it alone.
 *
 * Tokens are matched whole rather than as substrings, because "standup"
 * contains "an" and "rendered" contains "en", and a substring match would
 * make almost every filename look multilingual.
 */
export function guessLanguages(input: {
  readonly sourcePath: string;
  readonly title?: string | null;
  readonly tags?: readonly string[];
}): LanguageGuess | null {
  const name = basename(input.sourcePath);
  const rawName = input.sourcePath.split('/').pop() ?? '';
  const sources: { readonly text: string; readonly label: string }[] = [
    { text: name, label: `filename "${rawName}"` },
    ...(input.title === undefined || input.title === null || input.title === ''
      ? []
      : [{ text: input.title, label: `title "${input.title}"` }]),
    ...(input.tags === undefined || input.tags.length === 0
      ? []
      : [{ text: input.tags.join(' '), label: `tags ${input.tags.join(', ')}` }]),
  ];

  const found: string[] = [];
  const evidence: string[] = [];
  for (const source of sources) {
    const before = found.length;
    for (const token of source.text.toLowerCase().split(/[^a-z\u0400-\u04FF]+/)) {
      if (token === '') continue;
      const code = CODES.has(token) ? token : NAMES[token];
      if (code !== undefined && !found.includes(code)) found.push(code);
    }
    if (CYRILLIC.test(source.text) && !found.includes('ru')) found.push('ru');
    if (found.length > before) evidence.push(source.label);
  }

  if (found.length === 0) return null;
  return { languages: found, from: evidence.join(', ') };
}
