import type { Command } from 'commander';
import { FailureError } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { getJob, listJobs, removeJob } from '../jobs/store.js';
import type { JobState } from '../jobs/state.js';

interface JobsOptions {
  readonly json?: boolean;
}

/**
 * Fetches a job by its exact id, or explains that ailoud has lost track of
 * it.
 *
 * Reported as UNKNOWN rather than folded into the generic "no such job"
 * phrasing every other resolver in this codebase uses: a pruned or
 * mistyped id means "ailoud never had this job, or no longer does", which
 * is a different fact from the job itself having failed. Saying "unknown"
 * keeps a reader from chasing an error that never happened.
 *
 * A plain exact match, unlike `resolveRecording`/`resolveSummary`: a job id
 * is copied whole from a `--detach` result or an `ls`, never typed by
 * hand, so there is no prefix to resolve and no ambiguity to report.
 */
async function requireJob(context: CliContext, id: string): Promise<JobState> {
  const job = await getJob(context.fs, context.paths.jobsDir, id);
  if (job !== null) return job;
  throw new FailureError(
    `Job "${id}" is UNKNOWN -- ailoud has no record of it. It may have been ` +
      'removed already, pruned automatically, or never existed. This is not ' +
      'the same as the job having failed.',
  );
}

/** One listing row, aligned so ids and states line up, as `report ls` does for summaries. */
function listing(jobs: readonly JobState[]): string {
  const idWidth = Math.max(...jobs.map((job) => job.id.length));
  const kindWidth = Math.max(...jobs.map((job) => job.kind.length));
  const stateWidth = Math.max(...jobs.map((job) => job.state.length));
  return jobs
    .map((job) =>
      [
        job.id.padEnd(idWidth),
        job.kind.padEnd(kindWidth),
        job.state.padEnd(stateWidth),
        `${job.percent}%`.padStart(4),
        job.stage,
      ].join('  '),
    )
    .join('\n');
}

/** The full state of one job, in the order a reader wants to check it. */
function details(job: JobState): string {
  const lines = [
    `Job ${job.id} -- ${job.kind}, ${job.state}`,
    `Progress: ${job.percent}% (${job.stage})`,
    `Recordings: ${job.recordings.done}/${job.recordings.total}`,
    `Started: ${job.startedAt}`,
  ];
  if (job.finishedAt !== null) lines.push(`Finished: ${job.finishedAt}`);
  if (job.etaSeconds !== undefined) lines.push(`ETA: ${job.etaSeconds}s`);
  if (job.error !== null) lines.push(`Error: ${job.error}`);
  lines.push(`Log: ${job.log}`);
  return lines.join('\n');
}

export function registerJobs(parent: Command, context: CliContext): void {
  parent
    .command('ls')
    .option('--json', 'print JSON instead of text')
    .description('List background jobs, newest first')
    .action(async (options: JobsOptions) => {
      await context.ui.frame('Jobs', async () => {
        const jobs = await listJobs(context.fs, context.paths.jobsDir);

        if (jobs.length === 0) {
          if (options.json === true) {
            context.ui.content('[]');
            return;
          }
          // Exit 0, not a failure -- the same bargain `report ls` struck for
          // an empty library: nothing here yet is not an error.
          context.ui.note('No background jobs yet. Run a command with --detach to start one.');
          return;
        }

        if (options.json === true) {
          context.ui.content(JSON.stringify(jobs));
          return;
        }
        context.ui.content(listing(jobs));
      });
    });

  parent
    .command('show')
    .argument('<id>', 'a job id, exactly as printed by --detach or by "job ls"')
    .option('--json', 'print JSON instead of text')
    .description('Print one job in full, including its log path')
    .action(async (id: string, options: JobsOptions) => {
      await context.ui.frame('Job', async () => {
        const job = await requireJob(context, id);
        if (options.json === true) {
          context.ui.content(JSON.stringify(job));
          return;
        }
        context.ui.content(details(job));
      });
    });

  parent
    .command('rm')
    .argument('<id>', 'a job id to forget')
    .description('Forget a finished job and its log')
    .action(async (id: string) => {
      await context.ui.frame('Removing job', async () => {
        const job = await requireJob(context, id);
        if (job.state === 'running') {
          // The only place a user meets this limitation, so it is spelled
          // out rather than hinted at: forgetting the state file does not
          // touch the process it describes, and ailoud cannot stop that
          // process yet -- not "will not", "cannot".
          throw new FailureError(
            `Job ${id} is still running. Removing it here would only forget ` +
              'about it -- it would not stop the underlying process, and ' +
              'ailoud cannot stop a running job yet. Wait for it to finish, ' +
              `or stop pid ${job.pid} yourself, then remove it.`,
          );
        }

        const removed = await removeJob(context.fs, context.paths.jobsDir, id);
        const line = `${id}  ${removed ? 'removed' : 'was already gone'}`;
        if (removed) {
          context.ui.success(line);
        } else {
          context.ui.note(line);
        }
      });
    });
}
