import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEFAULT_TEMPLATE, buildSummaryRequest, transcribeRecording } from '@laud/core';
import type { SummarySource } from '@laud/core';
import type { CliContext } from '../wiring.js';
import { resolveRecording, resolveRecordings } from '../resolveId.js';
import { parseTags } from '../tags.js';
import {
  loadTemplate,
  loadTemplates,
  materializeBuiltIns,
  serializeTemplate,
  templatesDir,
  validateTemplateName,
} from '../templateStore.js';
import { transcriptBudget } from '../commands/summarize.js';
import type { McpDeps } from './deps.js';
import { fail, ok } from './reply.js';

const ID = z
  .string()
  .describe('A recording id, or any unambiguous prefix of at least two characters.');

export function registerWriteTools(server: McpServer, context: CliContext, _deps: McpDeps): void {
  server.registerTool(
    'annotate',
    {
      title: 'Add context to a recording',
      description:
        "Set a recording's title, notes, tags, and the real names of its speakers.\n\n" +
        'Cheap, reversible, and the highest-value thing you can do for a library. TAGS are how ' +
        'a recording is found by context later, and SPEAKER NAMES are what make every future ' +
        'summary attribute a point to a person instead of to "speaker_00".\n\n' +
        'A good move after reading a transcript: you now know who these people are, and nothing ' +
        'else in the system does.',
      inputSchema: {
        recordingId: ID,
        title: z.string().optional().describe('A short human title.'),
        notes: z.string().optional().describe('Free-form notes about the recording.'),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            'Tags to add; adding one it already has is harmless. Reuse a spelling from ' +
              'list_tags rather than inventing a variant.',
          ),
        speakerNames: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Diarizer label to real name, e.g. {"speaker_00": "Ann"}. Labels come from ' +
              'list_speakers. Names survive re-transcription.',
          ),
      },
      annotations: { idempotentHint: true },
    },
    async ({ recordingId, title, notes, tags, speakerNames }) => {
      const recording = await resolveRecording(context.store, recordingId);
      if (title !== undefined || notes !== undefined) {
        await context.store.annotateRecording(recording.id, {
          ...(title === undefined ? {} : { title }),
          ...(notes === undefined ? {} : { notes }),
        });
      }
      const parsed = parseTags(tags ?? []);
      if (parsed.length > 0) await context.store.addTags(recording.id, parsed);
      for (const [label, name] of Object.entries(speakerNames ?? {})) {
        await context.store.setSpeakerName(recording.id, label, name);
      }
      return ok({
        recordingId: recording.id,
        tags: await context.store.listTags(recording.id),
        speakers: await context.store.listSpeakerNames(recording.id),
      });
    },
  );

  server.registerTool(
    'import_recording',
    {
      title: 'Import audio or video into the library',
      description:
        'Copies a file, or every media file directly inside a directory, into the library. The ' +
        'file you point at is never modified or moved.\n\n' +
        'PASS TAGS. This is the cheapest moment to tag anything -- somebody is already thinking ' +
        'about what the file is -- and an untagged recording cannot be found by context later.\n\n' +
        'A file already in the library (same content) is reported as already present rather ' +
        'than duplicated.',
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .describe(
            'Files, or directories of media files. Directories are not walked recursively.',
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe('Tags for everything imported. Please supply some.'),
        title: z.string().optional().describe('A title, when importing a single file.'),
      },
    },
    async ({ paths, tags, title }) => {
      const { importPath } = await import('@laud/core');
      const parsed = parseTags(tags ?? []);
      const imported = [];
      for (const path of paths) {
        const results = await importPath(
          {
            fs: context.fs,
            store: context.store,
            audio: context.audio,
            clock: context.clock,
            ids: context.ids,
            mediaRoot: context.paths.mediaRoot,
          },
          { path, ...(title === undefined ? {} : { title }) },
        );
        for (const { recording, alreadyPresent } of results) {
          if (parsed.length > 0) await context.store.addTags(recording.id, parsed);
          imported.push({ id: recording.id, sourcePath: recording.sourcePath, alreadyPresent });
        }
      }
      return ok({
        imported,
        tags: parsed,
        ...(parsed.length === 0
          ? {
              warning:
                'Nothing was tagged. These recordings cannot be filtered by context; consider annotate.',
            }
          : {}),
        next: 'transcribe these ids to get a transcript',
      });
    },
  );

  server.registerTool(
    'transcribe',
    {
      title: 'Transcribe recordings',
      description:
        'Turns recordings into transcripts with the locally configured speech-to-text engine.\n\n' +
        'COSTS MINUTES OF CPU per recording -- roughly a tenth of the audio duration on a fast ' +
        "machine, more on a slow one. A long recording may outlast your client's tool timeout; " +
        'if that happens, the work is not lost, and calling again picks up what has no ' +
        'transcript yet.\n\n' +
        'Name the recordings. There is no default selection, deliberately.',
      inputSchema: {
        recordingIds: z.array(ID).min(1).describe('Recordings to transcribe. Prefixes accepted.'),
        languages: z
          .array(z.string())
          .optional()
          .describe(
            'Expected languages, e.g. ["ru","en"]. Giving more than one turns on per-segment ' +
              'detection and confines it to that set, which is far more reliable than letting ' +
              'it guess freely.',
          ),
        diarize: z
          .boolean()
          .optional()
          .describe('Attribute segments to speakers. Slower; needs the diarizer installed.'),
        tags: z.array(z.string()).optional().describe('Tags to add while you are here.'),
      },
    },
    async ({ recordingIds, languages, diarize, tags }) => {
      const warnings: string[] = [];
      const recordings = await resolveRecordings(context.store, recordingIds);
      const parsed = parseTags(tags ?? []);
      const declared = languages ?? [];
      const multilingual = declared.length > 1;
      const done = [];
      for (const recording of recordings) {
        const transcript = await transcribeRecording(
          {
            fs: context.fs,
            store: context.store,
            audio: context.audio,
            stt: context.createStt(),
            clock: context.clock,
            ids: context.ids,
            mediaRoot: context.paths.mediaRoot,
            // Warnings reach the caller in the result rather than a terminal:
            // there is no terminal here, and a diarizer that failed silently
            // would leave an agent believing it has speakers.
            onWarning: (message) => warnings.push(message),
            ...(multilingual ? { segmenter: context.createSegmenter() } : {}),
            ...(diarize === true ? { diarizer: context.createDiarizer() } : {}),
          },
          recording,
          {
            ...(!multilingual && declared.length === 1 ? { language: declared[0] } : {}),
            ...(multilingual ? { multilingual: true, declaredLanguages: declared } : {}),
            ...(diarize === true ? { diarize: true } : {}),
          },
        );
        if (parsed.length > 0) await context.store.addTags(recording.id, parsed);
        done.push({
          recordingId: recording.id,
          transcriptId: transcript.id,
          language: transcript.language,
          segments: (await context.store.listSegments(transcript.id)).length,
        });
      }
      return ok({ transcribed: done, ...(warnings.length === 0 ? {} : { warnings }) });
    },
  );

  server.registerTool(
    'summarize',
    {
      title: 'Summarise recordings into a saved report',
      description:
        'Writes a summary of one or several recordings with a language model, and saves it as a ' +
        'report.\n\n' +
        'COSTS TOKENS on a hosted model, or minutes on a local one. There is no default ' +
        'selection: name the recordings or a tag.\n\n' +
        'CALL list_templates FIRST and pass a template. The headings differ because the ' +
        'questions differ -- a one-to-one is about agreements and concerns, a design decision ' +
        'about what was rejected. The default meeting shape answers those badly.\n\n' +
        'PASS CONTEXT. One or two sentences the transcript does not say: who these people are ' +
        'to each other, what the project is called, what happened last week. laud does not ' +
        'remember it between calls -- keep it in your own memory and pass it again next time.\n\n' +
        'Several recordings are summarised together into one report, which is a different ' +
        'answer from summarising each and stapling them.',
      inputSchema: {
        recordingIds: z
          .array(ID)
          .optional()
          .describe('Recordings to summarise. Prefixes accepted.'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Instead of ids: summarise everything carrying all of these tags.'),
        template: z
          .string()
          .optional()
          .describe(`A template name from list_templates. Defaults to "${DEFAULT_TEMPLATE}".`),
        context: z
          .string()
          .optional()
          .describe(
            'One or two sentences of background the transcript does not contain. Short: every ' +
              "word here competes with the transcript for the model's attention.",
          ),
        language: z
          .string()
          .optional()
          .describe(
            'Write the summary in this language, e.g. "en". Defaults to the recording\'s own.',
          ),
        fresh: z
          .boolean()
          .optional()
          .describe(
            'Re-read transcripts instead of reusing stored reports. Only affects groups; a ' +
              'single recording is always read from its transcript.',
          ),
      },
    },
    async (args) => {
      const ids = args.recordingIds ?? [];
      const tags = parseTags(args.tags ?? []);
      if (ids.length === 0 && tags.length === 0) {
        return fail({
          error: 'summarize needs recordingIds or tags; it has no default',
          why: 'summarising a whole library by accident costs real money or a lot of time',
        });
      }
      if (ids.length > 0 && tags.length > 0) {
        return ok({ error: 'pass recordingIds or tags, not both' });
      }

      const dir = templatesDir(context.paths.configFile);
      const wanted = args.template ?? DEFAULT_TEMPLATE;
      const template = await loadTemplate(context.fs, dir, wanted);
      if (template === undefined) {
        return fail({
          error: `no template named "${wanted}"`,
          available: (await loadTemplates(context.fs, dir)).map((t) => t.name),
        });
      }

      const recordings =
        ids.length > 0
          ? await resolveRecordings(context.store, ids)
          : await context.store.listRecordings({ tags });
      if (recordings.length === 0) {
        return ok({ error: `no recordings carry ${tags.join(' and ')}` });
      }

      const summarizer = context.createSummarizer();
      const reuse = args.fresh !== true && recordings.length > 1;
      const sources: SummarySource[] = [];
      for (const recording of recordings) {
        const transcript = await context.store.latestTranscript(recording.id);
        const prior = reuse ? await context.store.latestSummaryOf(recording.id) : null;
        const speakers = await context.store.listSpeakerNames(recording.id);
        const carried = await context.store.listTags(recording.id);
        if (prior !== null) {
          sources.push({
            recording,
            segments: [],
            speakers,
            tags: carried,
            priorSummary: prior.body,
          });
          continue;
        }
        if (transcript === null) {
          return fail({
            error: `${recording.id} has no transcript yet`,
            fix: 'call transcribe first',
          });
        }
        sources.push({
          recording,
          segments: await context.store.listSegments(transcript.id),
          speakers,
          tags: carried,
        });
      }

      const request = buildSummaryRequest(sources, {
        budgetTokens: transcriptBudget(summarizer),
        template,
        ...(args.language === undefined ? {} : { language: args.language }),
        ...(args.context === undefined ? {} : { context: args.context }),
      });

      let body: string;
      if (request.parts.length === 1) {
        body = await summarizer.complete(request.parts[0]!);
      } else {
        const partial: string[] = [];
        for (const part of request.parts) partial.push(await summarizer.complete(part));
        body = await summarizer.complete(`${request.combine}\n\n${partial.join('\n\n')}`);
      }

      const id = context.ids.next();
      await context.store.insertSummary({
        id,
        createdAt: context.clock.nowIso(),
        language: args.language ?? 'auto',
        provider: summarizer.name,
        model: summarizer.model,
        body,
        template: template.name,
        context: args.context ?? '',
        recordingIds: recordings.map((recording) => recording.id),
      });

      return ok({
        reportId: id,
        template: template.name,
        model: `${summarizer.name} ${summarizer.model}`,
        recordingIds: recordings.map((recording) => recording.id),
        portions: request.parts.length,
        reusedStoredReports: sources.filter((source) => source.priorSummary !== undefined).length,
        summary: body,
      });
    },
  );

  server.registerTool(
    'create_template',
    {
      title: 'Create a summary template',
      description:
        'Adds a new summary shape as a YAML file beside the built-in ones.\n\n' +
        'RARELY THE RIGHT MOVE. Check list_templates first: one of the shipped shapes usually ' +
        'fits, and where it nearly does, the "context" argument to summarize adjusts the ' +
        'summary without adding a template nobody asked for. Create one when a kind of ' +
        'conversation genuinely divides differently and will recur.\n\n' +
        'A template needs a context sentence and at least two headings; one heading is a title, ' +
        'not a shape. An existing name is refused rather than overwritten.',
      inputSchema: {
        name: z.string().describe('Lowercase letters, digits and hyphens, e.g. "sprint-retro".'),
        context: z
          .string()
          .describe('One sentence telling the model what kind of conversation this is.'),
        headings: z
          .array(z.string())
          .min(2)
          .describe('The headings, in the order they should appear.'),
        summary: z.string().optional().describe('One line for listings.'),
      },
    },
    async ({ name, context: contextLine, headings, summary }) => {
      const dir = templatesDir(context.paths.configFile);
      const safe = validateTemplateName(name);
      await materializeBuiltIns(context.fs, dir);
      const path = `${dir}/${safe}.yaml`;
      if (await context.fs.exists(path)) {
        return fail({
          error: `a template named "${safe}" already exists`,
          path,
          suggestion: 'edit that file, pick another name, or use the "context" argument instead',
        });
      }
      await context.fs.writeTextFile(
        path,
        serializeTemplate({ name: safe, context: contextLine, headings, summary: summary ?? safe }),
      );
      return ok({ created: safe, path, use: `pass template: "${safe}" to summarize` });
    },
  );
}
