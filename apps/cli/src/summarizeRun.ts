import { FailureError, buildSummaryRequest } from '@ailoud/core';
import type { Recording, Summarizer, Summary, SummarySource, SummaryTemplate } from '@ailoud/core';
import type { CliContext } from './wiring.js';

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

export interface SummaryRun {
  readonly recordings: readonly Recording[];
  readonly template: SummaryTemplate;
  readonly language?: string;
  readonly context?: string;
  /** Read transcripts again instead of reusing stored reports. */
  readonly fresh?: boolean;
  /** Store the result. Default true. */
  readonly save?: boolean;
}

export interface SummaryRunResult {
  readonly body: string;
  /** The stored report's id, or null when `save` was false. */
  readonly reportId: string | null;
  readonly portions: number;
  readonly reused: number;
  readonly provider: string;
  readonly model: string;
}

/** Reported as the work proceeds. `total` of one means there is nothing to count. */
export type OnProgress = (stage: string, done: number, total: number) => void;

export interface SummaryHooks {
  readonly onProgress?: OnProgress;
  /**
   * Called once the plan is known and before any model call.
   *
   * Both facts are worth having early: "reusing 9 stored summaries" explains
   * why a run is fast while it is happening, and "8 portions" explains why one
   * is slow. Reported afterwards, they only explain what already happened.
   */
  readonly onPlan?: (plan: { readonly reused: number; readonly portions: number }) => void;
  /**
   * Called once with every transcript file the request produced, before any
   * model call, so a caller can write them somewhere the user or an agent can
   * read.
   */
  readonly onFiles?: (files: readonly { name: string; content: string }[]) => Promise<void>;
}

/**
 * Gathers everything a summary needs for one recording.
 *
 * The stored summary is looked for FIRST, because when one is being reused the
 * transcript is not read at all -- and demanding one AILoud will not open would
 * refuse a recording it can perfectly well summarise.
 */
async function sourceFor(
  context: CliContext,
  recording: Recording,
  reuse: boolean,
): Promise<SummarySource> {
  const prior = reuse ? await context.store.latestSummaryOf(recording.id) : null;
  const speakers = await context.store.listSpeakerNames(recording.id);
  const tags = await context.store.listTags(recording.id);
  if (prior !== null) {
    return { recording, segments: [], speakers, tags, priorSummary: prior.body };
  }

  const transcript = await context.store.latestTranscript(recording.id);
  if (transcript === null) {
    throw new FailureError(
      `${recording.id} has no transcript yet. Run "ailoud audio transcribe ${recording.id}" first.`,
    );
  }
  return { recording, segments: await context.store.listSegments(transcript.id), speakers, tags };
}

/**
 * The whole summarisation pipeline, in one place.
 *
 * Shared by `ailoud audio summarize` and the MCP `summarize` tool, because it
 * was written twice and the copies drifted: the rule that a single recording
 * is never summarised from its own stored summary was fixed in the command
 * and had to be remembered separately for the tool. One implementation is the
 * only way that rule stays true for both callers.
 */
export async function runSummary(
  context: CliContext,
  run: SummaryRun,
  hooks: SummaryHooks = {},
): Promise<SummaryRunResult> {
  const summarizer = context.createSummarizer();

  // Stored summaries stand in for transcripts only when there are several
  // recordings, which is where they pay: ten meetings from ten stored
  // summaries costs a fraction of ten transcripts. For a single recording it
  // would be a game of telephone -- a summary of a summary, each pass further
  // from what anybody actually said.
  const reuse = run.fresh !== true && run.recordings.length > 1;

  const sources: SummarySource[] = [];
  for (const recording of run.recordings) {
    sources.push(await sourceFor(context, recording, reuse));
  }
  const reused = sources.filter((source) => source.priorSummary !== undefined).length;

  const request = buildSummaryRequest(sources, {
    budgetTokens: transcriptBudget(summarizer),
    template: run.template,
    ...(run.language === undefined ? {} : { language: run.language }),
    ...(run.context === undefined ? {} : { context: run.context }),
  });

  hooks.onPlan?.({ reused, portions: request.parts.length });
  await hooks.onFiles?.(request.files);

  let body: string;
  if (request.parts.length === 1) {
    // Nothing to count: one request, so a caller reports the stage and claims
    // no progress it cannot measure.
    hooks.onProgress?.('Summarising', 0, 1);
    body = await summarizer.complete(request.parts[0]!);
  } else {
    // The reduce pass is counted alongside the portions, because it is one
    // more request of the same order and a bar that reaches 100% and then
    // keeps spinning is worse than one that reaches 90%.
    const total = request.parts.length + 1;
    const partial: string[] = [];
    // Sequential, not parallel: a local model is one process using every core
    // it has, and running several would make all of them slower.
    for (const [index, part] of request.parts.entries()) {
      hooks.onProgress?.('Summarising portion', index, total);
      partial.push(await summarizer.complete(part));
    }
    hooks.onProgress?.('Combining portions', request.parts.length, total);
    body = await summarizer.complete(`${request.combine}\n\n${partial.join('\n\n')}`);
  }

  let reportId: string | null = null;
  if (run.save !== false) {
    const summary: Summary = {
      id: context.ids.next(),
      createdAt: context.clock.nowIso(),
      language: run.language ?? 'auto',
      provider: summarizer.name,
      model: summarizer.model,
      body,
      template: run.template.name,
      context: run.context ?? '',
      recordingIds: run.recordings.map((recording) => recording.id),
    };
    await context.store.insertSummary(summary);
    reportId = summary.id;
  }

  return {
    body,
    reportId,
    portions: request.parts.length,
    reused,
    provider: summarizer.name,
    model: summarizer.model,
  };
}
