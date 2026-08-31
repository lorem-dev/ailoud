import { join } from 'node:path';
import type { Command } from 'commander';
import { FailureError, UsageError, buildSummaryRequest } from '@laud/core';
import type { Recording, Summary, SummarySource, Summarizer } from '@laud/core';
import { page, shouldPage } from '@laud/providers';
import type { CliContext } from '../wiring.js';
import { resolveRecordings } from '../resolveId.js';
import { collectTag, parseTags } from '../tags.js';

interface SummarizeOptions {
  readonly tag?: string[];
  readonly lang?: string;
  readonly fresh?: boolean;
  readonly save?: boolean;
}

/**
 * How much of the model's context to leave for the instruction and the answer.
 *
 * The transcript is not the only thing in the window: the prompt sits in front
 * of it and the summary has to come out. Reserving a third is generous, and
 * generous is the right direction -- overshooting means the model is handed
 * more than it can hold and says so only after the work is done, while
 * undershooting costs one extra portion.
 */
const RESERVED_FRACTION = 1 / 3;

export function transcriptBudget(summarizer: Summarizer): number {
  return Math.max(256, Math.floor(summarizer.contextTokens * (1 - RESERVED_FRACTION)));
}

/**
 * Gathers everything a summary needs for one recording.
 *
 * An earlier summary is used in place of the transcript when there is one and
 * the caller did not ask for a fresh read: summarising ten meetings from ten
 * stored summaries costs a fraction of ten transcripts, and the map step it
 * would otherwise repeat has already been paid for once.
 */
async function sourceFor(
  context: CliContext,
  recording: Recording,
  fresh: boolean,
): Promise<SummarySource> {
  // The stored summary is looked for first, because when one is being reused
  // the transcript is not read at all -- and demanding one laud will not open
  // would refuse a recording it can perfectly well summarise.
  const prior = fresh ? null : await context.store.latestSummaryOf(recording.id);
  const speakers = await context.store.listSpeakerNames(recording.id);
  const tags = await context.store.listTags(recording.id);
  if (prior !== null) {
    return { recording, segments: [], speakers, tags, priorSummary: prior.body };
  }

  const transcript = await context.store.latestTranscript(recording.id);
  if (transcript === null) {
    throw new FailureError(
      `${recording.id} has no transcript yet. Run "laud transcribe ${recording.id}" first.`,
    );
  }
  return { recording, segments: await context.store.listSegments(transcript.id), speakers, tags };
}

export function registerSummarize(program: Command, context: CliContext): void {
  program
    .command('summarize')
    .argument('[ids...]', 'recording ids, or enough of each start to be unambiguous')
    .option('--tag <tag>', 'summarise everything carrying this tag; repeatable', collectTag)
    .option('--lang <code>', "language to write the summary in (default: the transcript's)")
    .option('--fresh', 'read the transcripts again instead of reusing stored summaries')
    .option('--no-save', 'do not store the summary')
    .description('Summarise one or several recordings with a language model')
    .action(async (ids: string[], options: SummarizeOptions) => {
      const tags = parseTags(options.tag ?? []);
      if (ids.length === 0 && tags.length === 0) {
        // Summarising the entire library by accident would be an expensive
        // mistake -- minutes of local inference, or real money on a hosted
        // model -- so there is no default selection here, unlike transcribe.
        throw new UsageError('summarize needs recording ids or --tag; it has no default.');
      }
      if (ids.length > 0 && tags.length > 0) {
        throw new UsageError('summarize takes ids or --tag, not both.');
      }

      await context.ui.frame('Summarising', async () => {
        const recordings =
          ids.length > 0
            ? await resolveRecordings(context.store, ids)
            : await context.store.listRecordings({ tags });
        if (recordings.length === 0) {
          throw new FailureError(`No recordings carry ${tags.map((t) => `"${t}"`).join(' and ')}.`);
        }

        const summarizer = context.createSummarizer();
        // Stored summaries stand in for transcripts only when there are
        // several recordings, which is where they pay: ten meetings summarised
        // from ten stored summaries costs a fraction of ten transcripts. For a
        // single recording it would be a game of telephone -- a summary of a
        // summary, each pass further from what anybody actually said -- so
        // asking again, or asking in another language, re-reads the transcript.
        const reuse = options.fresh !== true && recordings.length > 1;
        const sources: SummarySource[] = [];
        for (const recording of recordings) {
          sources.push(await sourceFor(context, recording, !reuse));
        }
        const reused = sources.filter((source) => source.priorSummary !== undefined).length;
        if (reused > 0) {
          context.ui.note(
            `Reusing ${reused} stored ${reused === 1 ? 'summary' : 'summaries'} instead of ` +
              'transcripts (--fresh to read the transcripts again).',
          );
        }

        const request = buildSummaryRequest(sources, {
          budgetTokens: transcriptBudget(summarizer),
          ...(options.lang === undefined ? {} : { language: options.lang }),
        });

        // The transcripts are written out for the length of the run and no
        // longer. They exist as files because a long one goes to the model in
        // portions and because the prompt reaches a spawned binary through a
        // file rather than an argument -- an argv-sized transcript is a limit,
        // not a feature. The library in the database stays the only copy that
        // outlives the command.
        const dir = await context.fs.tempDir();
        try {
          for (const file of request.files) {
            await context.fs.writeTextFile(join(dir.path, file.name), file.content);
          }

          if (request.parts.length > 1) {
            context.ui.note(
              `Too long for ${summarizer.name} in one pass: ${request.parts.length} portions, ` +
                'then combined.',
            );
          }

          const body = await context.ui.summarising(async (report) => {
            if (request.parts.length === 1) {
              // Nothing to count: one request, so the spinner says what is
              // happening and claims no progress it cannot measure.
              report('Summarising', 0, 1);
              return summarizer.complete(request.parts[0]!);
            }
            // The reduce pass is counted alongside the portions, because it is
            // one more request of the same order and a bar that reaches 100%
            // and then keeps spinning is worse than one that reaches 90%.
            const total = request.parts.length + 1;
            const partial: string[] = [];
            // Sequential, not parallel: a local model is one process using
            // every core it has, and running several would make all of them
            // slower.
            for (const [index, part] of request.parts.entries()) {
              report('Summarising portion', index, total);
              partial.push(await summarizer.complete(part));
            }
            report('Combining portions', request.parts.length, total);
            return summarizer.complete(`${request.combine}\n\n${partial.join('\n\n')}`);
          });

          if (options.save !== false) {
            const summary: Summary = {
              id: context.ids.next(),
              createdAt: context.clock.nowIso(),
              language: options.lang ?? 'auto',
              provider: summarizer.name,
              model: summarizer.model,
              body,
              recordingIds: recordings.map((recording) => recording.id),
            };
            await context.store.insertSummary(summary);
            context.ui.note(`Saved as ${summary.id}.`);
          }

          // A long report goes to the user's pager, where up, down and q
          // already work the way they do in git and man. Only when there is a
          // terminal to page on: shouldPage says no for a redirect or a pipe,
          // which want the bytes and would hang waiting for a keypress nobody
          // can give -- so "laud summarize ID > report.md" still writes a file.
          if (shouldPage(body, process.stdout.isTTY === true)) {
            await page(body, (chunk) => context.ui.content(chunk));
            return;
          }
          context.ui.content(body);
        } finally {
          await dir.remove();
        }
      });
    });
}
