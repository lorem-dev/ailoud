import type { Command } from 'commander';
import { FailureError, formatRecordedAt } from '@laud/core';
import type { Summary } from '@laud/core';
import { page, shouldPage } from '@laud/providers';
import type { CliContext } from '../wiring.js';
import { resolveRecording, resolveSummary } from '../resolveId.js';

interface ReportsOptions {
  readonly json?: boolean;
  readonly recording?: string;
}

/** How much of a report's first line the listing shows. */
const PREVIEW_LENGTH = 60;

/**
 * The first line of prose in a report.
 *
 * Headings are skipped rather than shown: every report opens with the same
 * heading, so a column of that one word would distinguish nothing. Bullets and
 * emphasis are stripped for the same reason -- the listing is one line of
 * plain text, not a rendering.
 */
export function reportPreview(body: string, limit = PREVIEW_LENGTH): string {
  const line = body
    .split('\n')
    .filter((raw) => !isHeading(raw))
    .map((raw) =>
      raw
        .replace(/^[\s>*_-]+/, '')
        .replace(/[*_`]/g, '')
        .trim(),
    )
    .find((candidate) => candidate.length > 0);
  if (line === undefined) return '';
  const points = [...line];
  return points.length <= limit ? line : `${points.slice(0, limit).join('')}...`;
}

/**
 * Whether a line is one of the report's headings rather than prose.
 *
 * Recognised by its markup, not by its words: a report is written in whatever
 * language was asked for, so a list of English heading names lets "Решения"
 * straight through -- which it did, and the listing showed that word as the
 * preview of every Russian report. A leading # and a wholly-bold line are what
 * the models actually emit.
 */
function isHeading(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.startsWith('#')) return true;
  return /^\*\*[^*]+\*\*:?$/.test(trimmed) || /^__[^_]+__:?$/.test(trimmed);
}

/** One listing row, aligned so the ids and dates line up. */
function listing(summaries: readonly Summary[]): string {
  const idWidth = Math.max(...summaries.map((summary) => summary.id.length));
  const modelWidth = Math.max(...summaries.map((summary) => summary.model.length));
  return summaries
    .map((summary) => {
      const over =
        summary.recordingIds.length === 1
          ? summary.recordingIds[0]!
          : `${summary.recordingIds.length} recordings`;
      return [
        summary.id.padEnd(idWidth),
        formatRecordedAt(summary.createdAt),
        summary.model.padEnd(modelWidth),
        summary.language,
        over,
        reportPreview(summary.body),
      ].join('  ');
    })
    .join('\n');
}

export function registerReports(program: Command, context: CliContext): void {
  program
    .command('reports')
    .argument('[id]', 'a report id, or enough of its start to be unambiguous')
    .option('--json', 'print JSON instead of text')
    .option('--recording <id>', 'only reports covering this recording')
    .description('List saved summaries, or print one in full')
    .action(async (id: string | undefined, options: ReportsOptions) => {
      await context.ui.frame('Reports', async () => {
        // One report, in full. Paged when it is long, for the same reason
        // summarize pages its own output.
        if (id !== undefined) {
          const summary = await resolveSummary(context.store, id);
          if (options.json === true) {
            context.ui.content(JSON.stringify(summary));
            return;
          }
          const covers = summary.recordingIds.join(', ');
          const heading =
            `Report of ${formatRecordedAt(summary.createdAt)} -- ` +
            `${summary.provider} ${summary.model}, ${summary.language}\n` +
            `Covers: ${covers}\n`;
          const payload = `${heading}\n${summary.body}`;
          if (shouldPage(payload, process.stdout.isTTY === true)) {
            await page(payload, (chunk) => context.ui.content(chunk));
            return;
          }
          context.ui.content(payload);
          return;
        }

        const summaries =
          options.recording === undefined
            ? await context.store.listAllSummaries()
            : await context.store.listSummaries(
                (await resolveRecording(context.store, options.recording)).id,
              );

        if (summaries.length === 0) {
          if (options.json === true) {
            context.ui.content('[]');
            return;
          }
          throw new FailureError(
            options.recording === undefined
              ? 'No reports yet. Run "laud summarize <id>" to make one.'
              : `No reports cover ${options.recording}.`,
          );
        }

        if (options.json === true) {
          context.ui.content(JSON.stringify(summaries));
          return;
        }
        const payload = listing(summaries);
        if (shouldPage(payload, process.stdout.isTTY === true)) {
          await page(payload, (chunk) => context.ui.content(chunk));
          return;
        }
        context.ui.content(payload);
      });
    });
}
