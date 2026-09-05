import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  formatRecordedAt,
  formatTimestamp,
  recordedOrImportedAt,
  speakerNameMap,
  toMatchExpression,
  transcriptFileHeader,
  transcriptLine,
} from '@laud/core';
import type { CliContext } from '../wiring.js';
import { resolveRecording, resolveSummary } from '../resolveId.js';
import { loadTemplates, templatesDir } from '../templateStore.js';
import type { McpDeps } from './deps.js';
import { fail, ok } from './reply.js';

const ID = z
  .string()
  .describe(
    'A recording id, or any unambiguous prefix of at least two characters (as in docker). ' +
      'An ambiguous prefix is reported with the candidates so you can lengthen it.',
  );

const TAGS = z
  .array(z.string())
  .describe(
    'Tags. Several NARROW rather than widen: ["release","backend"] means recordings carrying ' +
      'both. Lowercase words.',
  );

export function registerReadTools(server: McpServer, context: CliContext, deps: McpDeps): void {
  server.registerTool(
    'list_recordings',
    {
      title: 'List recordings',
      description:
        'The library, newest first: id, title, date, duration, language, tags, and whether a ' +
        'transcript and a report exist yet.\n\n' +
        'Use this to orient yourself before anything else. It does NOT return transcript text; ' +
        'use search_transcripts to find what was said, and get_transcript only when you need a ' +
        'whole conversation.\n\n' +
        'Recordings with no tags are flagged: untagged recordings cannot be grouped or filtered ' +
        'by context, so offer to tag them.',
      inputSchema: {
        tags: TAGS.optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('At most this many. Defaults to 50; you are told when the cap was hit.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tags, limit }) => {
      const cap = limit ?? 50;
      const recordings = await context.store.listRecordings(
        tags === undefined || tags.length === 0 ? {} : { tags },
      );
      const rows = [];
      for (const recording of recordings.slice(0, cap)) {
        const transcript = await context.store.latestTranscript(recording.id);
        const carried = await context.store.listTags(recording.id);
        rows.push({
          id: recording.id,
          title: recording.title,
          recordedAt: formatRecordedAt(recordedOrImportedAt(recording)),
          durationMs: recording.durationMs,
          tags: carried,
          untagged: carried.length === 0,
          hasTranscript: transcript !== null,
          language: transcript?.language ?? null,
          reportCount: (await context.store.listSummaries(recording.id)).length,
        });
      }
      return ok({
        recordings: rows,
        total: recordings.length,
        truncated: recordings.length > cap,
        untaggedCount: rows.filter((row) => row.untagged).length,
      });
    },
  );

  server.registerTool(
    'list_untagged',
    {
      title: 'List recordings with no tags',
      description:
        'Recordings that carry no tags, and so cannot be found by context -- only by id or ' +
        'full-text search.\n\n' +
        'Tags are how anyone asks for "the recordings about this project" or "my one-to-ones". ' +
        'Use this to find what needs tagging, then annotate them. Worth doing before any work ' +
        'that will need to filter.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = [];
      for (const recording of await context.store.listRecordings({})) {
        if ((await context.store.listTags(recording.id)).length > 0) continue;
        const transcript = await context.store.latestTranscript(recording.id);
        rows.push({
          id: recording.id,
          title: recording.title,
          recordedAt: formatRecordedAt(recordedOrImportedAt(recording)),
          sourcePath: recording.sourcePath,
          transcriptPreview: transcript === null ? null : transcript.text.slice(0, 200),
        });
      }
      return ok({ untagged: rows, count: rows.length });
    },
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags in use',
      description:
        'Every tag in the library with how many recordings carry it, most-used first. Cheap. ' +
        'Call it before filtering by tag, so you filter by one that exists rather than one you ' +
        'guessed, and before adding a tag, so you reuse the spelling already in use.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok({ tags: await context.store.listAllTags() }),
  );

  server.registerTool(
    'search_transcripts',
    {
      title: 'Search transcripts',
      description:
        'Find WHERE something was said, across the library. Returns the matching lines with ' +
        'timestamp, speaker and recording -- typically a few hundred bytes.\n\n' +
        'THIS IS THE TOOL TO REACH FOR FIRST. Reading a transcript costs thousands of tokens; ' +
        'this answers "when did they discuss the rollback" for almost none. Only fall back to ' +
        'get_transcript when you genuinely need the whole conversation.\n\n' +
        'Full text, case-insensitive in every language including Russian. A trailing * is a ' +
        'prefix search, which matters in inflected languages: "гаван*" matches every ending. ' +
        'A "quoted run" matches those words adjacent. Everything else is literal, so ' +
        'punctuation and words like "AND" are searched for rather than interpreted.',
      inputSchema: {
        query: z
          .string()
          .describe(
            'Words to find. "quoted" for a phrase; a trailing * for a prefix. Several words ' +
              'all have to appear in the same segment.',
          ),
        tags: TAGS.optional(),
        language: z
          .string()
          .optional()
          .describe('Only segments spoken in this language, e.g. "ru". Rarely needed.'),
        recordingId: ID.optional().describe('Only this recording. Accepts a prefix.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('At most this many hits (default 50).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, tags, language, recordingId, limit }) => {
      const cap = limit ?? 50;
      const ids =
        recordingId === undefined ? [] : [(await resolveRecording(context.store, recordingId)).id];
      const hits = await context.store.searchSegments(toMatchExpression(query), {
        ...(tags === undefined || tags.length === 0 ? {} : { tags }),
        ...(language === undefined ? {} : { language }),
        ...(ids.length === 0 ? {} : { recordingIds: ids }),
        limit: cap,
      });

      const named = [];
      for (const hit of hits) {
        const names = speakerNameMap(await context.store.listSpeakerNames(hit.recordingId));
        named.push({
          recordingId: hit.recordingId,
          recordingTitle: hit.recordingTitle,
          recordedAt: formatRecordedAt(hit.recordedAt),
          tags: hit.tags,
          at: formatTimestamp(hit.startMs, 'short'),
          startMs: hit.startMs,
          speaker: hit.speaker === null ? null : (names.get(hit.speaker) ?? hit.speaker),
          language: hit.language,
          text: hit.text,
        });
      }
      return ok({
        hits: named,
        count: named.length,
        // Never a silent cap: at the limit, there may be more.
        stoppedAtLimit: named.length === cap,
      });
    },
  );

  server.registerTool(
    'get_transcript',
    {
      title: 'Write a transcript to a file',
      description:
        "Writes a recording's transcript to a temporary FILE and returns its path, line count " +
        'and duration. It does NOT return the text.\n\n' +
        'That is deliberate: a transcript is thousands of tokens and putting one in your ' +
        'context to answer a narrow question is waste. Read the part you need from the path ' +
        'with your own file tools, or grep it.\n\n' +
        'The file opens with a header giving the title, date, tags and participants, then lines ' +
        'of "[mm:ss] Speaker: text". It lives for the length of this server\'s run.\n\n' +
        'Prefer search_transcripts unless you need the whole conversation.',
      inputSchema: {
        recordingId: ID,
        speaker: z
          .string()
          .optional()
          .describe("Only this speaker's lines, by the name or label shown in list_speakers."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ recordingId, speaker }) => {
      const recording = await resolveRecording(context.store, recordingId);
      const transcript = await context.store.latestTranscript(recording.id);
      if (transcript === null) {
        return fail({
          error: `${recording.id} has no transcript yet`,
          fix: 'call transcribe first',
        });
      }
      const all = await context.store.listSegments(transcript.id);
      const speakers = await context.store.listSpeakerNames(recording.id);
      const names = speakerNameMap(speakers);
      const segments =
        speaker === undefined
          ? all
          : all.filter((segment) => {
              const shown =
                segment.speaker === null ? null : (names.get(segment.speaker) ?? segment.speaker);
              return shown === speaker || segment.speaker === speaker;
            });

      const tags = await context.store.listTags(recording.id);
      const body = segments.map((segment) => transcriptLine(segment, names)).join('\n');
      const header = transcriptFileHeader({ recording, segments: all, speakers, tags });
      const dir = await deps.runDir();
      const path = join(dir, `${recording.id}${speaker === undefined ? '' : `-${speaker}`}.txt`);
      await context.fs.writeTextFile(path, `${header}\n\n${body}\n`);

      return ok({
        path,
        recordingId: recording.id,
        lines: segments.length,
        durationMs: recording.durationMs,
        language: transcript.language,
        tags,
        note: 'Read this file with your own tools. Do not ask for it again; it will not change.',
      });
    },
  );

  server.registerTool(
    'list_speakers',
    {
      title: "List a recording's speakers",
      description:
        'Who spoke in a recording, how much, and what they are called. A label like ' +
        '"speaker_00" means the diarizer separated them but nobody has said who they are -- ' +
        'annotate can fix that, and it makes every later summary attribute points to a person ' +
        'rather than a number.',
      inputSchema: { recordingId: ID },
      annotations: { readOnlyHint: true },
    },
    async ({ recordingId }) => {
      const recording = await resolveRecording(context.store, recordingId);
      const transcript = await context.store.latestTranscript(recording.id);
      if (transcript === null) return ok({ speakers: [], note: 'no transcript yet' });
      const segments = await context.store.listSegments(transcript.id);
      const names = speakerNameMap(await context.store.listSpeakerNames(recording.id));
      const totals = new Map<string, number>();
      for (const segment of segments) {
        if (segment.speaker === null) continue;
        totals.set(
          segment.speaker,
          (totals.get(segment.speaker) ?? 0) + (segment.endMs - segment.startMs),
        );
      }
      return ok({
        speakers: [...totals.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([label, ms]) => ({ label, name: names.get(label) ?? null, spokenMs: ms })),
        diarized: totals.size > 0,
      });
    },
  );

  server.registerTool(
    'list_reports',
    {
      title: 'List saved reports',
      description:
        'Summaries already made, newest first, with which template shaped each, what context ' +
        'it was given, which model wrote it and which recordings it covers.\n\n' +
        'Check here before summarising: a report that already exists costs nothing to read and ' +
        'a new one costs tokens or minutes.',
      inputSchema: {
        recordingId: ID.optional().describe('Only reports covering this recording.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ recordingId }) => {
      const summaries =
        recordingId === undefined
          ? await context.store.listAllSummaries()
          : await context.store.listSummaries(
              (await resolveRecording(context.store, recordingId)).id,
            );
      return ok({
        reports: summaries.map((summary) => ({
          id: summary.id,
          createdAt: formatRecordedAt(summary.createdAt),
          template: summary.template,
          context: summary.context,
          language: summary.language,
          model: `${summary.provider} ${summary.model}`,
          recordingIds: summary.recordingIds,
          firstLine: summary.body.split('\n').find((line) => line.trim() !== '') ?? '',
        })),
      });
    },
  );

  server.registerTool(
    'get_report',
    {
      title: 'Write a report to a file',
      description:
        'Writes a saved report to a temporary FILE and returns its path. Like get_transcript, ' +
        'it does not return the text: read what you need from the path.\n\n' +
        'Short reports are cheap to read whole; this keeps the habit uniform so a long one does ' +
        'not surprise you.',
      inputSchema: { reportId: z.string().describe('A report id, or an unambiguous prefix.') },
      annotations: { readOnlyHint: true },
    },
    async ({ reportId }) => {
      const summary = await resolveSummary(context.store, reportId);
      const dir = await deps.runDir();
      const path = join(dir, `${summary.id}.md`);
      await context.fs.writeTextFile(path, summary.body);
      return ok({
        path,
        reportId: summary.id,
        template: summary.template,
        context: summary.context,
        model: `${summary.provider} ${summary.model}`,
        recordingIds: summary.recordingIds,
        lines: summary.body.split('\n').length,
      });
    },
  );

  server.registerTool(
    'list_templates',
    {
      title: 'List summary templates',
      description:
        'The shapes a summary can take, with the headings each produces and the sentence each ' +
        'tells the model about the kind of conversation.\n\n' +
        'CALL THIS BEFORE summarize. The headings differ because the questions differ: the ' +
        'default meeting shape answers a one-to-one or a design decision badly. Pick the ' +
        'closest existing template; creating a new one is rarely the right move.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok({
        templates: await loadTemplates(context.fs, templatesDir(context.paths.configFile)),
        directory: templatesDir(context.paths.configFile),
        note: 'These are editable YAML files. Prefer an existing one; use create_template only when none fits.',
      }),
  );
}
