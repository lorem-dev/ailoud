import { join } from 'node:path';
import type { Command } from 'commander';
import { Option } from 'commander';
import { DEFAULT_TEMPLATE, FailureError, UsageError } from '@ailoud/core';
import { page, shouldPage } from '@ailoud/providers';
import type { CliContext } from '../wiring.js';
import { resolveRecordings } from '../resolveId.js';
import { collectTag, parseTags } from '../tags.js';
import { loadTemplate, loadTemplates, templatesDir } from '../templateStore.js';
import { runSummary } from '../summarizeRun.js';
import { JobLog } from '../jobs/log.js';
import { JobReporter } from '../jobs/reporter.js';
import { getJob } from '../jobs/store.js';
import { withJobLock } from '../jobs/lock.js';

export { transcriptBudget } from '../summarizeRun.js';

interface SummarizeOptions {
  readonly tag?: string[];
  readonly lang?: string;
  readonly fresh?: boolean;
  readonly save?: boolean;
  readonly template?: string;
  readonly context?: string;
  readonly job?: string;
}

/**
 * Loads the job named by `--job`, or undefined when the flag was not given.
 *
 * A missing id is a UsageError naming it rather than a silent no-op: the id
 * came from whatever process started this one (a detached `--detach` child,
 * or the MCP server), and a wrong or stale one means something upstream is
 * confused, not that this run should quietly report nowhere.
 */
async function loadJob(
  context: CliContext,
  id: string | undefined,
): Promise<{ readonly reporter: JobReporter; readonly log: JobLog } | undefined> {
  if (id === undefined) return undefined;
  const state = await getJob(context.fs, context.paths.jobsDir, id);
  if (state === null) {
    throw new UsageError(`no such job "${id}".`);
  }
  const log = new JobLog(state.log);
  const reporter = new JobReporter({
    fs: context.fs,
    jobsDir: context.paths.jobsDir,
    initial: state,
    log,
  });
  return { reporter, log };
}

export function registerSummarize(program: Command, context: CliContext): void {
  program
    .command('summarize')
    .argument('[ids...]', 'recording ids, or enough of each start to be unambiguous')
    .option('--tag <tag>', 'summarise everything carrying this tag; repeatable', collectTag)
    .option('--lang <code>', "language to write the summary in (default: the transcript's)")
    .option('--fresh', 'read the transcripts again instead of reusing stored summaries')
    .option('--no-save', 'do not store the summary')
    .option(
      '--template <name>',
      'what kind of conversation this is, which decides the headings; ' +
        '"ailoud template ls" lists them',
    )
    .option(
      '--context <text>',
      'a sentence or two the transcript does not say: who these people are to each other, ' +
        'what the project is, what happened last week',
    )
    // Hidden, and not a feature: this is how the detached child started by
    // `--detach` and by the MCP server is told which job it is. A user has
    // no reason to pass it, and `--help` listing it would invite exactly the
    // hand-made half-registered job this avoids.
    .addOption(
      new Option(
        '--job <id>',
        'report into an existing job state file instead of the terminal',
      ).hideHelp(),
    )
    .description('Summarise one or several recordings with a language model')
    .action(async (ids: string[], options: SummarizeOptions) => {
      const job = await loadJob(context, options.job);

      const body = async (): Promise<unknown> => {
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
        // Resolved here, before anything is read or spawned: a mistyped template
        // should fail in milliseconds, not after a transcript has been chunked.
        // From disk, so an edited template takes effect and a template the user
        // wrote is a peer of the shipped ones.
        const dir = templatesDir(context.paths.configFile);
        const wanted = options.template ?? DEFAULT_TEMPLATE;
        const template = await loadTemplate(context.fs, dir, wanted);
        if (template === undefined) {
          const available = (await loadTemplates(context.fs, dir)).map((t) => t.name).join(', ');
          throw new UsageError(`unknown --template "${wanted}"; choose one of: ${available}`);
        }

        return context.ui.frame('Summarising', async () => {
          const recordings =
            ids.length > 0
              ? await resolveRecordings(context.store, ids)
              : await context.store.listRecordings({ tags });
          if (recordings.length === 0) {
            throw new FailureError(
              `No recordings carry ${tags.map((t) => `"${t}"`).join(' and ')}.`,
            );
          }

          // The transcripts are written out for the length of the run and no
          // longer. They exist as files because a long one goes to the model in
          // portions and because the prompt reaches a spawned binary through a
          // file rather than an argument -- an argv-sized transcript is a limit,
          // not a feature. The library in the database stays the only copy that
          // outlives the command.
          // Named before the run so the portion note can use it; createSummarizer
          // is cheap and runSummary makes its own.
          const summarizerName = context.createSummarizer().name;
          const runDir = await context.fs.tempDir();
          try {
            const result = await context.ui.summarising((report) =>
              runSummary(
                context,
                {
                  recordings,
                  template,
                  ...(options.lang === undefined ? {} : { language: options.lang }),
                  ...(options.context === undefined ? {} : { context: options.context }),
                  ...(options.fresh === true ? { fresh: true } : {}),
                  ...(options.save === false ? { save: false } : {}),
                },
                {
                  onProgress: (stage, done, total) => {
                    report(stage, done, total);
                    job?.reporter.report({ stage, fraction: done / total });
                  },
                  onPlan: ({ reused, portions }) => {
                    if (reused > 0) {
                      context.ui.note(
                        `Reusing ${reused} stored ${reused === 1 ? 'summary' : 'summaries'} ` +
                          'instead of transcripts (--fresh to read the transcripts again).',
                      );
                    }
                    if (portions > 1) {
                      context.ui.note(
                        `Too long for ${summarizerName} in one pass: ${portions} portions, then combined.`,
                      );
                    }
                  },
                  onFiles: async (files) => {
                    for (const file of files) {
                      await context.fs.writeTextFile(join(runDir.path, file.name), file.content);
                    }
                  },
                },
              ),
            );

            if (result.reportId !== null) context.ui.note(`Saved as ${result.reportId}.`);

            // A long report goes to the user's pager, where up, down and q
            // already work the way they do in git and man. Only when there is a
            // terminal to page on: shouldPage says no for a redirect or a pipe,
            // which want the bytes and would hang waiting for a keypress nobody
            // can give -- so "ailoud summarize ID > report.md" still writes a file.
            if (shouldPage(result.body, process.stdout.isTTY === true)) {
              await page(result.body, (chunk) => context.ui.content(chunk));
            } else {
              context.ui.content(result.body);
            }
            // Never the summary body -- see JobState.result's own comment.
            return {
              reportId: result.reportId,
              portions: result.portions,
              reused: result.reused,
              provider: result.provider,
              model: result.model,
            };
          } finally {
            await runDir.remove();
          }
        });
      };

      if (job === undefined) {
        await body();
        return;
      }
      await withJobLock(context.paths.dataDir, async () => {
        try {
          const result = await body();
          await job.reporter.finish(result);
        } catch (error) {
          await job.reporter.fail(error instanceof Error ? error.message : String(error));
          throw error;
        }
      });
    });
}
