import { UsageError } from '@laud/core';

/**
 * Parses the `--tag` values a command collected.
 *
 * Shared by `annotate` and `transcribe` rather than written twice: two
 * commands that each decide what a tag may look like end up disagreeing, and
 * the disagreement shows up as a tag you can set but cannot filter by.
 *
 * Lowercased, because a group is a group whether it was typed "Standup" or
 * "standup", and two spellings of one tag would silently split it in half.
 * Whitespace inside is allowed -- "team sync" is a reasonable tag -- but a
 * comma is not: `--tag a,b` almost always means two tags, and accepting it as
 * one would store something the user cannot later filter for.
 */
export function parseTags(raw: readonly string[]): string[] {
  const tags: string[] = [];
  for (const value of raw) {
    const tag = value.trim().toLowerCase();
    if (tag === '') throw new UsageError('--tag needs a value.');
    if (tag.includes(',')) {
      throw new UsageError(
        `--tag takes one tag at a time, and "${value}" contains a comma. Repeat the flag instead.`,
      );
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** commander's collector for a repeatable option. */
export function collectTag(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
