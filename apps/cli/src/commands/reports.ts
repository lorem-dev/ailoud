import type { Command } from 'commander';
import { FailureError, formatRecordedAt } from '@laud/core';
import type { Summary } from '@laud/core';
import { page, shouldPage } from '@laud/providers';
import type { CliContext } from '../wiring.js';
import { resolveRecording, resolveSummary } from '../resolveId.js';
import { isInteractive, requireConsent } from './setup.js';

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

/** Prints a report, paging it when it is long, as summarize pages its own output. */
async function printReport(context: CliContext, summary: Summary, asJson: boolean): Promise<void> {
  if (asJson) {
    context.ui.content(JSON.stringify(summary));
    return;
  }
  const payload =
    `Report of ${formatRecordedAt(summary.createdAt)} -- ` +
    `${summary.provider} ${summary.model}, ${summary.language}\n` +
    `Covers: ${summary.recordingIds.join(', ')}\n\n${summary.body}`;
  if (shouldPage(payload, process.stdout.isTTY === true)) {
    await page(payload, (chunk) => context.ui.content(chunk));
    return;
  }
  context.ui.content(payload);
}

export function registerReports(parent: Command, context: CliContext): void {
  parent
    .command('ls')
    .option('--json', 'print JSON instead of text')
    .option('--recording <id>', 'only reports covering this recording')
    .description('List saved reports, newest first')
    .action(async (options: ReportsOptions) => {
      await context.ui.frame('Reports', async () => {
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

  parent
    .command('show')
    .argument('<id>', 'a report id, or enough of its start to be unambiguous')
    .option('--json', 'print JSON instead of text')
    .description('Print one report in full')
    .action(async (id: string, options: ReportsOptions) => {
      await context.ui.frame('Report', async () => {
        await printReport(context, await resolveSummary(context.store, id), options.json === true);
      });
    });

  parent
    .command('rm')
    .argument('<ids...>', 'report ids to delete')
    .option('--force', 'delete without asking')
    .description('Delete saved reports')
    .action(async (ids: string[], options: { readonly force?: boolean }) => {
      await context.ui.frame('Deleting reports', async () => {
        const summaries: Summary[] = [];
        for (const id of ids) summaries.push(await resolveSummary(context.store, id));

        context.write(
          summaries.length === 1
            ? 'This will permanently delete 1 report:'
            : `This will permanently delete ${summaries.length} reports:`,
        );
        for (const summary of summaries) {
          context.write(
            `  ${summary.id}  ${formatRecordedAt(summary.createdAt)}  ${summary.model}  ` +
              reportPreview(summary.body, 40),
          );
        }
        // The recordings and transcripts stay: a report is derived, and what it
        // was derived from is the library itself.
        context.write('The recordings and their transcripts are not touched.');

        // The same guard rm and setup use, for the same reason: one question,
        // one answer, and the same refusal with no terminal so a script cannot
        // delete without being asked.
        const consented = await requireConsent({
          yes: options.force === true,
          interactive: isInteractive(process.env, process.stdin.isTTY === true),
          // The command the user actually typed. Naming plain "rm" here is the
          // same drift CommandName exists to prevent: it would send someone to
          // a command that deletes recordings.
          commandName: 'report rm',
          action: 'deleting reports',
          consentFlag: '--force',
        });
        if (!consented) {
          context.write('Nothing was deleted.');
          return;
        }

        for (const summary of summaries) {
          const deleted = await context.store.deleteSummary(summary.id);
          context.write(`${summary.id}  ${deleted ? 'deleted' : 'was already gone'}`);
        }
      });
    });
}
