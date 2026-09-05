import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  formatRecordedAt,
  recordedOrImportedAt,
  speakerNameMap,
  transcriptLine,
} from '@ailoud/core';
import type { CliContext } from '../wiring.js';

/**
 * Transcripts and reports as addressable resources.
 *
 * Alongside the tools rather than instead of them, because they answer a
 * different question: a tool is something to do, a resource is something to
 * refer to. A client that lets a user attach context can offer the library
 * directly, and an agent can cite `ailoud://recording/ID001/transcript` in a
 * conversation without a tool call.
 *
 * The completion callbacks matter more than they look: they are what turns a
 * 26-character ULID from something to be copied into something to be picked.
 */
export function registerResources(server: McpServer, context: CliContext): void {
  server.registerResource(
    'transcript',
    new ResourceTemplate('ailoud://recording/{id}/transcript', {
      list: async () => {
        const recordings = await context.store.listRecordings({});
        const resources = [];
        for (const recording of recordings) {
          if ((await context.store.latestTranscript(recording.id)) === null) continue;
          const tags = await context.store.listTags(recording.id);
          resources.push({
            uri: `ailoud://recording/${recording.id}/transcript`,
            name: recording.title ?? recording.sourcePath,
            description:
              `Transcript of ${formatRecordedAt(recordedOrImportedAt(recording))}` +
              `${tags.length === 0 ? ' (no tags)' : ` [${tags.join(', ')}]`}`,
            mimeType: 'text/plain',
          });
        }
        return { resources };
      },
      complete: {
        id: async (value) =>
          (await context.store.findRecordingsByIdPrefix(value.toUpperCase()))
            .slice(0, 20)
            .map((recording) => recording.id),
      },
    }),
    {
      title: 'Recording transcript',
      description:
        'The full transcript of one recording, as timestamped lines with speaker names. Large: ' +
        'prefer the search_transcripts tool when you only need to know where something was said.',
      mimeType: 'text/plain',
    },
    async (uri, { id }) => {
      const recordingId = (Array.isArray(id) ? id[0] : id) ?? '';
      const recording = await context.store.getRecording(recordingId);
      if (recording === null) {
        return { contents: [{ uri: uri.href, text: `No recording ${recordingId}.` }] };
      }
      const transcript = await context.store.latestTranscript(recording.id);
      if (transcript === null) {
        return { contents: [{ uri: uri.href, text: `${recording.id} has no transcript yet.` }] };
      }
      const names = speakerNameMap(await context.store.listSpeakerNames(recording.id));
      const segments = await context.store.listSegments(transcript.id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/plain',
            text: segments.map((segment) => transcriptLine(segment, names)).join('\n'),
          },
        ],
      };
    },
  );

  server.registerResource(
    'report',
    new ResourceTemplate('ailoud://report/{id}', {
      list: async () => ({
        resources: (await context.store.listAllSummaries()).map((summary) => ({
          uri: `ailoud://report/${summary.id}`,
          name: `${summary.template} report, ${formatRecordedAt(summary.createdAt)}`,
          description: `${summary.provider} ${summary.model}, covers ${summary.recordingIds.join(', ')}`,
          mimeType: 'text/markdown',
        })),
      }),
      complete: {
        id: async (value) =>
          (await context.store.findSummariesByIdPrefix(value.toUpperCase()))
            .slice(0, 20)
            .map((summary) => summary.id),
      },
    }),
    {
      title: 'Saved report',
      description: 'One saved summary, as markdown.',
      mimeType: 'text/markdown',
    },
    async (uri, { id }) => {
      const reportId = (Array.isArray(id) ? id[0] : id) ?? '';
      const summaries = await context.store.findSummariesByIdPrefix(reportId.toUpperCase());
      const only = summaries.length === 1 ? summaries[0] : undefined;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: only?.body ?? `No single report matches ${reportId}.`,
          },
        ],
      };
    },
  );
}
