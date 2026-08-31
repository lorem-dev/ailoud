import type { Command } from 'commander';
import { FailureError, UsageError, buildSummaryRequest } from '@laud/core';
import type { Recording, SummarySource, Summarizer } from '@laud/core';
import type { CliContext } from '../wiring.js';
import { resolveRecordings } from '../resolveId.js';
import { collectTag, parseTags } from '../tags.js';

interface SummarizeOptions {
  readonly tag?: string[];
}

/**
 * How much of the model's context to leave for the instruction and the answer.
 *
 * The transcript is not the only thing in the window: the prompt sits in front
 * of it and the summary has to come out. Reserving a third is generous, and
 * generous is the right direction -- overshooting means the model is handed
 * more than it can hold and says so only after the work is done, while
 * undershooting costs one extra chunk.
 */
const RESERVED_FRACTION = 1 / 3;

export function transcriptBudget(summarizer: Summarizer): number {
  return Math.max(256, Math.floor(summarizer.contextTokens * (1 - RESERVED_FRACTION)));
}

/** Gathers everything a summary needs for one recording, or explains what is missing. */
async function sourceFor(context: CliContext, recording: Recording): Promise<SummarySource> {
  const transcript = await context.store.latestTranscript(recording.id);
  if (transcript === null) {
    throw new FailureError(
      `${recording.id} has no transcript yet. Run "laud transcribe ${recording.id}" first.`,
    );
  }
  return {
    recording,
    segments: await context.store.listSegments(transcript.id),
    speakers: await context.store.listSpeakerNames(recording.id),
  };
}

export function registerSummarize(program: Command, context: CliContext): void {
  program
    .command('summarize')
    .argument('[ids...]', 'recording ids, or enough of each start to be unambiguous')
    .option('--tag <tag>', 'summarise everything carrying this tag; repeatable', collectTag)
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
        const sources: SummarySource[] = [];
        for (const recording of recordings) sources.push(await sourceFor(context, recording));

        const request = buildSummaryRequest(sources, transcriptBudget(summarizer));

        // One request when it fits, map-then-reduce when it does not. The
        // split is decided in core, from the model's own context size, so this
        // command does not have to know anything about tokens.
        let summary: string;
        if (request.parts.length === 0) {
          summary = await summarizer.complete(request.prompt);
        } else {
          context.ui.note(
            `Too long for ${summarizer.name} in one pass: summarising ${request.parts.length} parts, then combining.`,
          );
          const partial: string[] = [];
          // Sequential, not parallel: a local model is one process using every
          // core it has, and running several would make all of them slower.
          for (const part of request.parts) partial.push(await summarizer.complete(part));
          summary = await summarizer.complete(`${request.prompt}\n\n${partial.join('\n\n')}`);
        }

        context.ui.content(summary);
      });
    });
}
