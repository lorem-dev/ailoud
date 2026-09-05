import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatRecordedAt, recordedOrImportedAt } from '@ailoud/core';
import type { CliContext } from '../wiring.js';
import { resolveRecording, resolveSummary } from '../resolveId.js';
import { reportPreview } from '../commands/reports.js';
import type { Confirmations } from './confirm.js';
import { fail, ok } from './reply.js';

const CONFIRM = z
  .string()
  .optional()
  .describe(
    'Leave this out on the first call. You will get back a description of exactly what would ' +
      'be deleted, and a confirmationToken. SHOW THAT DESCRIPTION TO THE USER AND GET THEIR ' +
      'AGREEMENT, then call again with the token to carry it out. The token is single-use and ' +
      'expires in ten minutes.',
  );

/**
 * Deletion, in two steps, always.
 *
 * The tools describe what would go and hand back a token; only a second call
 * carrying it deletes. One step is a step an agent can take from a misread
 * sentence, and a recording deleted with its transcripts cannot be recovered.
 * Two steps put the list of what will be lost in front of the user in between.
 *
 * `destructiveHint` is set as well, so a client that gates destructive tools
 * gates these -- belt and braces, because the token protects against accident
 * and the annotation against a client that would not have asked at all.
 */
export function registerDeleteTools(
  server: McpServer,
  context: CliContext,
  confirmations: Confirmations,
): void {
  server.registerTool(
    'delete_recording',
    {
      title: 'Delete recordings from the library',
      description:
        "Deletes recordings, their transcripts, their segments and ailoud's own copy of the " +
        'audio. THE FILE THE USER IMPORTED FROM IS NOT TOUCHED.\n\n' +
        'NOT RECOVERABLE. Two calls are required: the first describes what would go and returns ' +
        'a confirmationToken, the second carries it out. Show the user the description from the ' +
        'first call and get their agreement before making the second. Do not chain the two ' +
        'calls on your own initiative.\n\n' +
        'If the goal is to tidy up rather than to destroy, consider that reports can be deleted ' +
        'separately with delete_report, and that a recording can be re-transcribed instead.',
      inputSchema: {
        recordingIds: z
          .array(z.string())
          .min(1)
          .describe(
            'Recordings to delete. Prefixes accepted; every one is resolved before any is deleted.',
          ),
        confirmationToken: CONFIRM,
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ recordingIds, confirmationToken }) => {
      // Every id is resolved before anything is deleted: half a deletion is
      // the worst outcome when the user was asked about a set.
      const recordings = [];
      for (const id of recordingIds) recordings.push(await resolveRecording(context.store, id));
      const ids = recordings.map((recording) => recording.id);

      const describe = [];
      for (const recording of recordings) {
        const transcript = await context.store.latestTranscript(recording.id);
        describe.push({
          id: recording.id,
          title: recording.title,
          recordedAt: formatRecordedAt(recordedOrImportedAt(recording)),
          sourcePath: recording.sourcePath,
          tags: await context.store.listTags(recording.id),
          hasTranscript: transcript !== null,
          reportCount: (await context.store.listSummaries(recording.id)).length,
        });
      }

      if (confirmationToken === undefined) {
        return ok({
          status: 'confirmation required',
          willDelete: describe,
          alsoDeleted:
            "each recording's transcripts, segments, tags, speaker names, reports, and ailoud's copy of the audio",
          notDeleted: 'the original files these were imported from',
          recoverable: false,
          confirmationToken: confirmations.issue('recordings', ids),
          nextStep:
            'Show willDelete to the user. If they agree, call delete_recording again with the same ids and this confirmationToken.',
        });
      }

      const refusal = confirmations.redeem(confirmationToken, 'recordings', ids);
      if (refusal !== null) return fail({ status: 'refused', reason: refusal });

      const deleted = [];
      for (const recording of recordings) {
        deleted.push({
          id: recording.id,
          deleted: await context.store.deleteRecording(recording.id),
        });
        await context.fs.removeFile(`${context.paths.mediaRoot}/${recording.mediaPath}`);
      }
      return ok({ status: 'deleted', deleted });
    },
  );

  server.registerTool(
    'delete_report',
    {
      title: 'Delete saved reports',
      description:
        'Deletes saved summaries. The recordings and their transcripts are NOT touched -- a ' +
        'report is derived, and it can be made again with summarize.\n\n' +
        'Two calls, as with delete_recording: the first describes and returns a token, the ' +
        'second carries it out. Less costly to get wrong than deleting a recording, since the ' +
        'material it came from remains, but still a deliberate act.',
      inputSchema: {
        reportIds: z.array(z.string()).min(1).describe('Report ids, or unambiguous prefixes.'),
        confirmationToken: CONFIRM,
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ reportIds, confirmationToken }) => {
      const summaries = [];
      for (const id of reportIds) summaries.push(await resolveSummary(context.store, id));
      const ids = summaries.map((summary) => summary.id);

      if (confirmationToken === undefined) {
        return ok({
          status: 'confirmation required',
          willDelete: summaries.map((summary) => ({
            id: summary.id,
            createdAt: formatRecordedAt(summary.createdAt),
            template: summary.template,
            model: `${summary.provider} ${summary.model}`,
            recordingIds: summary.recordingIds,
            firstLine: reportPreview(summary.body, 80),
          })),
          notDeleted: 'the recordings and their transcripts',
          remakeable: 'yes, with summarize',
          confirmationToken: confirmations.issue('reports', ids),
          nextStep:
            'Show willDelete to the user. If they agree, call delete_report again with the same ids and this confirmationToken.',
        });
      }

      const refusal = confirmations.redeem(confirmationToken, 'reports', ids);
      if (refusal !== null) return fail({ status: 'refused', reason: refusal });

      const deleted = [];
      for (const summary of summaries) {
        deleted.push({ id: summary.id, deleted: await context.store.deleteSummary(summary.id) });
      }
      return ok({ status: 'deleted', deleted });
    },
  );
}
