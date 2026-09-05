import { UsageError } from '../domain/errors.js';

/**
 * Turns what a person typed into an FTS5 match expression.
 *
 * FTS5's MATCH syntax has operators -- `AND`, `OR`, `NOT`, `NEAR`, `:`, `-`,
 * `(` -- so a query passed through raw fails on ordinary speech. "don't" is a
 * syntax error, "C++" is a syntax error, and a transcript containing the word
 * "AND" would be unsearchable for it. So every term is quoted, which makes it
 * a literal, and the quoted terms are joined by implicit AND.
 *
 * Two pieces of syntax survive on purpose, because they are the two people
 * actually reach for:
 *
 * - a double-quoted run is kept together as a phrase, so `"before sunrise"`
 *   finds those words adjacent rather than anywhere in the same segment;
 * - a trailing `*` is a prefix search, so `гаван*` finds every case of a
 *   Russian word without the user having to know its endings -- which matters
 *   far more in an inflected language than in English.
 */
export function toMatchExpression(query: string): string {
  const terms: string[] = [];
  // Walks the string rather than splitting it: a quoted phrase can contain the
  // spaces a split would use as boundaries.
  const pattern = /"([^"]*)"(\*?)|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    const [, phrase, phraseStar, bare] = match;
    if (phrase !== undefined) {
      if (phrase.trim() === '') continue;
      terms.push(`${quote(phrase)}${phraseStar === '*' ? '*' : ''}`);
      continue;
    }
    if (bare === undefined) continue;
    const prefix = bare.endsWith('*');
    const word = prefix ? bare.slice(0, -1) : bare;
    if (word === '') continue;
    terms.push(`${quote(word)}${prefix ? '*' : ''}`);
  }

  if (terms.length === 0) throw new UsageError('search needs something to look for.');
  return terms.join(' ');
}

/** A double quote inside an FTS5 string is escaped by doubling it. */
function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
