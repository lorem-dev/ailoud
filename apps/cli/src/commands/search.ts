import type { Command } from 'commander';
import { FailureError, formatTimestamp, speakerNameMap, toMatchExpression } from '@ailoud/core';
import type { SegmentHit } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { resolveRecording } from '../resolveId.js';
import { collectTag, parseTags } from '../tags.js';
import { speakerPainter } from '../ui/speakerColor.js';

interface SearchOptions {
  readonly tag?: string[];
  readonly lang?: string;
  readonly recording?: string;
  readonly limit?: string;
  readonly json?: boolean;
  readonly all?: boolean;
}

/** Enough to stop a runaway query, loose enough that a real search is not clipped. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new FailureError(`--limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  }
  return value;
}

export function registerSearch(parent: Command, context: CliContext): void {
  parent
    .command('search')
    .argument('<query...>', 'words to find; "quoted" for a phrase, trailing * for a prefix')
    .option('--tag <tag>', 'only recordings carrying this tag; repeatable', collectTag)
    .option('--lang <code>', 'only segments spoken in this language')
    .option('--recording <id>', 'only this recording')
    .option('--limit <n>', `how many hits at most (default ${DEFAULT_LIMIT})`)
    .option('--all', "search every transcript, not only each recording's newest")
    .option('--json', 'print JSON instead of text')
    .description('Find where something was said, across the library')
    .action(async (query: string[], options: SearchOptions) => {
      await context.ui.frame('Searching', async () => {
        const limit = parseLimit(options.limit);
        const tags = parseTags(options.tag ?? []);
        const recordingIds =
          options.recording === undefined
            ? []
            : [(await resolveRecording(context.store, options.recording)).id];

        const hits = await context.store.searchSegments(toMatchExpression(query.join(' ')), {
          ...(tags.length === 0 ? {} : { tags }),
          ...(options.lang === undefined ? {} : { language: options.lang }),
          ...(recordingIds.length === 0 ? {} : { recordingIds }),
          limit,
          ...(options.all === true ? { allTranscripts: true } : {}),
        });

        if (options.json === true) {
          context.ui.content(JSON.stringify(hits));
          return;
        }
        if (hits.length === 0) {
          throw new FailureError(`Nothing matches ${query.map((q) => `"${q}"`).join(' ')}.`);
        }
        context.ui.content(await render(context, hits, limit));
      });
    });
}

/**
 * One line per hit: where it was said, by whom, and what was said.
 *
 * Grouped by recording, because a search that found six lines in one meeting
 * and one in another is telling the reader something, and a flat list ordered
 * by relevance hides it. The heading carries the tags, so "which context is
 * this" is answered without a second command.
 */
async function render(
  context: CliContext,
  hits: readonly SegmentHit[],
  limit: number,
): Promise<string> {
  const lines: string[] = [];
  const byRecording = new Map<string, SegmentHit[]>();
  for (const hit of hits) {
    byRecording.set(hit.recordingId, [...(byRecording.get(hit.recordingId) ?? []), hit]);
  }

  for (const [recordingId, group] of byRecording) {
    const first = group[0]!;
    const tags = first.tags.length === 0 ? 'no tags' : first.tags.join(', ');
    lines.push(
      `${recordingId}  ${first.recordingTitle ?? '(untitled)'}  [${tags}]  ` +
        `${group.length} hit${group.length === 1 ? '' : 's'}`,
    );
    const names = speakerNameMap(await context.store.listSpeakerNames(recordingId));
    const paint = speakerPainter(
      group.map((hit) => (hit.speaker === null ? '' : (names.get(hit.speaker) ?? hit.speaker))),
      // Same test show uses: colour only on a real terminal, never into a pipe.
      process.stdout.isTTY === true,
    );
    for (const hit of group) {
      const who = hit.speaker === null ? null : (names.get(hit.speaker) ?? hit.speaker);
      lines.push(
        `  [${formatTimestamp(hit.startMs, 'short')}] ${who === null ? '' : `${paint(who)}: `}${hit.text}`,
      );
    }
    lines.push('');
  }

  if (hits.length === limit) {
    // Never a silent cap: a listing that stops at the limit and says nothing
    // reads as "that is all there is".
    lines.push(`Stopped at ${limit} hits (--limit to raise it).`);
  }
  return lines.join('\n').trimEnd();
}
