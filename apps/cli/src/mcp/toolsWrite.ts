import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEFAULT_TEMPLATE, guessLanguages } from '@ailoud/core';
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
import { JobLog } from '../jobs/log.js';
import { JobReporter } from '../jobs/reporter.js';
import { createJob } from '../jobs/store.js';
import { jobBusyMessage, jobLockHolder } from '../jobs/lock.js';
import { spawnDetachedJob } from '../jobs/spawn.js';
import type { McpDeps } from './deps.js';
import { fail, ok } from './reply.js';

const ID = z
  .string()
  .describe('A recording id, or any unambiguous prefix of at least two characters.');

/**
 * Mirrors parseLanguages's guarantees (apps/cli/src/commands/transcribe.ts) on
 * the array shape this tool receives, given a non-empty `languages`.
 *
 * This is not cosmetic parity: the result reaches resolveDeclaredLanguages
 * (@ailoud/core) exactly the way the CLI's does, and that function does not
 * reject a code it cannot use. When no detected span falls inside the
 * declared set, its fallback branch stamps declared[0] onto every span,
 * silently writing whatever was passed as though it were a real language
 * code. "auto" mixed with a real code guarantees that fallback fires --
 * whisper never detects a span as "auto" -- but a mis-typed code, a
 * duplicate, or a case mismatch against the lower-case codes providers
 * return can trigger the exact same corruption. All are refused here, before
 * any recording is resolved, for the same reason the CLI validates before
 * starting: the alternative is an hour of transcription whose segments carry
 * a language that was never real.
 *
 * Lower-cases before comparing, same as parseLanguages, so `["RU"]` is
 * treated as `["ru"]` rather than silently missing every detected span whose
 * language a provider reports in lower case.
 *
 * Returns the normalised list to declare (empty for a lone "auto"), or a
 * refusal reason to hand to `fail`.
 */
function validateLanguages(
  languages: readonly string[],
): { readonly declared: readonly string[] } | { readonly refusal: Record<string, string> } {
  const lowered = languages.map((code) => code.toLowerCase());
  if (lowered.length > 1 && lowered.includes('auto')) {
    return {
      refusal: {
        error: `"auto" cannot be mixed with a real language, got [${languages.join(', ')}]`,
        why:
          '"auto" means detect everything, so naming a language alongside it says two ' +
          'contradictory things',
      },
    };
  }
  if (lowered.length === 1 && lowered[0] === 'auto') return { declared: [] };
  for (const code of lowered) {
    if (!/^[a-z]{2,3}$/.test(code)) {
      return {
        refusal: {
          error: `"${code}" is not a two- or three-letter language code, in [${languages.join(', ')}]`,
        },
      };
    }
  }
  const duplicate = lowered.find((code, index) => lowered.indexOf(code) !== index);
  if (duplicate !== undefined) {
    return { refusal: { error: `"${duplicate}" is listed twice, in [${languages.join(', ')}]` } };
  }
  return { declared: lowered };
}

/**
 * Builds the detached child's argv for `transcribe`, explicitly from this
 * tool's own validated inputs -- never from `process.argv`. Under the MCP
 * server that argv is `mcp`, not `transcribe`, so there would be nothing to
 * filter anyway; see `spawn.ts`'s `buildDetachedArgs` for the rest of the
 * assembly (the entry path and `--job`).
 *
 * A sibling of `transcribeChildArgs` in `../commands/transcribe.ts` rather
 * than a reuse of it: that one's `TranscribeOptions` speaks the CLI's own
 * shapes -- one comma-joined `--lang` string, a numeric `--speakers` string
 * with no "unknown" -- and adapting this tool's already-validated array and
 * `number | 'unknown'` inputs to that shape would be more indirection than
 * the function below.
 */
function transcribeChildArgs(
  recordingIds: readonly string[],
  input: {
    readonly declared: readonly string[];
    readonly speakers: number | 'unknown';
    readonly diarize: boolean | undefined;
    readonly tags: readonly string[];
  },
): string[] {
  const args: string[] = ['transcribe', ...recordingIds];
  args.push('--lang', input.declared.length === 0 ? 'auto' : input.declared.join(','));
  if (input.diarize === true) args.push('--diarize');
  // Same guard the inline pipeline used to apply: --speakers only informs
  // the diarizer, and only when a real count was declared.
  if (input.diarize === true && typeof input.speakers === 'number') {
    args.push('--speakers', String(input.speakers));
  }
  for (const tag of input.tags) args.push('--tag', tag);
  return args;
}

/**
 * Builds the detached child's argv for `summarize`. See
 * `transcribeChildArgs` above for why this duplicates, rather than reuses,
 * `summarizeChildArgs` in `../commands/summarize.ts`: that one also handles
 * `--no-save`, which this tool has no equivalent input for, and takes the
 * CLI's raw option shapes rather than this tool's already-parsed ones.
 */
function summarizeChildArgs(
  recordingIds: readonly string[],
  input: {
    readonly tags: readonly string[];
    readonly template: string | undefined;
    readonly context: string | undefined;
    readonly language: string | undefined;
    readonly fresh: boolean | undefined;
  },
): string[] {
  const args: string[] = ['summarize', ...recordingIds];
  for (const tag of input.tags) args.push('--tag', tag);
  if (input.language !== undefined) args.push('--lang', input.language);
  if (input.fresh === true) args.push('--fresh');
  if (input.template !== undefined) args.push('--template', input.template);
  if (input.context !== undefined) args.push('--context', input.context);
  return args;
}

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
      const { importPath } = await import('@ailoud/core');
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
        'machine, more on a slow one. RUNS IN THE BACKGROUND: this call returns at once with a ' +
        'job id, and the work continues after it returns. Poll job_status with that id rather ' +
        'than waiting on this call -- a few minutes between polls is usually enough, since ' +
        'polling does not make the work go faster.\n\n' +
        'Name the recordings. There is no default selection, deliberately.\n\n' +
        'REFUSES until speakers and languages are both given. Whisper cannot be restricted to a ' +
        'set of languages unless told what to expect, so the first call without them comes back ' +
        'with a guess and instructions to ask the user, instead of running.',
      inputSchema: {
        recordingIds: z.array(ID).min(1).describe('Recordings to transcribe. Prefixes accepted.'),
        languages: z
          .array(z.string())
          .optional()
          .describe(
            'Expected languages, e.g. ["ru","en"]. Giving more than one turns on per-segment ' +
              'detection and confines it to that set, which is far more reliable than letting ' +
              'it guess freely.\n\n' +
              "ASK THE USER, and offer your own reading of the recording's name as a starting " +
              'point. Pass ["auto"] only when they do not know.',
          ),
        speakers: z
          .union([z.number().int().positive(), z.literal('unknown')])
          .optional()
          .describe(
            'How many people speak on this recording. ASK THE USER -- do not guess. Pass ' +
              '"unknown" if they genuinely do not know; that is recorded, and is better than a ' +
              'number nobody believes.',
          ),
        diarize: z
          .boolean()
          .optional()
          .describe('Attribute segments to speakers. Slower; needs the diarizer installed.'),
        tags: z.array(z.string()).optional().describe('Tags to add while you are here.'),
      },
    },
    async ({ recordingIds, languages, speakers, diarize, tags }) => {
      // Refused rather than defaulted, and refused BEFORE the work starts.
      // Declared languages are the difference between a Russian stretch
      // transcribed as Russian and the same stretch reported as Polish and
      // returned as phonetic nonsense -- see TranscribeOptions.declaredLanguages
      // in @ailoud/core. A default would silently pick the worse outcome for
      // every caller who never read the rules.
      if (speakers === undefined || languages === undefined || languages.length === 0) {
        const first = await resolveRecording(context.store, recordingIds[0]!);
        const guess = guessLanguages({
          sourcePath: first.sourcePath,
          title: first.title,
          tags: await context.store.listTags(first.id),
        });
        return fail({
          error: 'transcribe needs the speaker count and the expected languages',
          why:
            'declared languages stop whisper reporting Polish for a Russian stretch, which then ' +
            'comes back as phonetic nonsense; a known speaker count is more reliable than ' +
            'letting the diarizer infer one',
          guess,
          ask:
            'Ask the user how many people speak on this recording and in which languages. Offer ' +
            'the guess above, plus your own reading of the name, and let them correct it. Ask ' +
            'per recording when the recordings differ.',
          then: 'call transcribe again with speakers and languages',
        });
      }

      const validated = validateLanguages(languages);
      if ('refusal' in validated) return fail(validated.refusal);
      const declared = validated.declared;

      // Resolved before the lock check, same order the CLI's --detach uses:
      // an unknown or ambiguous id should cost a refusal, not a job id for a
      // job about to fail on it.
      const recordings = await resolveRecordings(context.store, recordingIds);
      const tagList = parseTags(tags ?? []);

      // Synchronous refusal: handing back an id for a job about to die
      // against the lock is a worse answer than a plain refusal. Advisory,
      // like every other read of this lock -- the answer can be stale --
      // but refusing up front on it is still better than not checking.
      const holder = await jobLockHolder(context.paths.dataDir);
      if (holder !== null) return fail({ error: jobBusyMessage(holder) });

      const job = await createJob(
        { fs: context.fs, ids: context.ids, clock: context.clock, jobsDir: context.paths.jobsDir },
        {
          kind: 'transcribe',
          recordings: recordings.length,
          // The caller's literal declaration, not `declared` (validateLanguages's
          // normalised set, which is what reaches the pipeline via
          // transcribeChildArgs below). ["auto"] means "the user does not
          // know"; an absent `languages` is refused before this point and
          // never reaches here at all -- so unlike the CLI's --lang, there is
          // no "nothing declared" case to preserve, only this one.
          declared: { speakers, languages },
        },
      );

      try {
        await spawnDetachedJob(
          { fs: context.fs, jobsDir: context.paths.jobsDir },
          transcribeChildArgs(recordingIds, { declared, speakers, diarize, tags: tagList }),
          job,
        );
      } catch (error) {
        // The id below must always resolve: if the child never started, the
        // job file must say so rather than "running" forever.
        const message = error instanceof Error ? error.message : String(error);
        await new JobReporter({
          fs: context.fs,
          jobsDir: context.paths.jobsDir,
          initial: job,
          log: new JobLog(job.log),
        }).fail(message);
        return fail({ jobId: job.id, error: `failed to start the job: ${message}` });
      }

      return ok({
        jobId: job.id,
        kind: job.kind,
        poll: 'call job_status with this id; a few minutes apart is often enough',
      });
    },
  );

  server.registerTool(
    'summarize',
    {
      title: 'Summarise recordings into a saved report',
      description:
        'Writes a summary of one or several recordings with a language model, and saves it as a ' +
        'report.\n\n' +
        'COSTS TOKENS on a hosted model, or minutes on a local one. RUNS IN THE BACKGROUND: this ' +
        'call returns at once with a job id rather than the summary text. Poll job_status with ' +
        'it; once its state is "done", the result carries the saved report\'s id -- read the ' +
        'text with get_report only when you actually need it, the same trade get_transcript ' +
        'makes with a transcript. There is no default selection: name the recordings or a ' +
        'tag.\n\n' +
        'CALL list_templates FIRST and pass a template. The headings differ because the ' +
        'questions differ -- a one-to-one is about agreements and concerns, a design decision ' +
        'about what was rejected. The default meeting shape answers those badly.\n\n' +
        'PASS CONTEXT. One or two sentences the transcript does not say: who these people are ' +
        'to each other, what the project is called, what happened last week. ailoud does not ' +
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
        return fail({ error: 'pass recordingIds or tags, not both' });
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
        return fail({ error: `no recordings carry ${tags.join(' and ')}` });
      }

      // Synchronous refusal: handing back an id for a job about to die
      // against the lock is a worse answer than a plain refusal.
      const holder = await jobLockHolder(context.paths.dataDir);
      if (holder !== null) return fail({ error: jobBusyMessage(holder) });

      const job = await createJob(
        { fs: context.fs, ids: context.ids, clock: context.clock, jobsDir: context.paths.jobsDir },
        { kind: 'summarize', recordings: recordings.length, declared: null },
      );

      try {
        await spawnDetachedJob(
          { fs: context.fs, jobsDir: context.paths.jobsDir },
          summarizeChildArgs(ids, {
            tags,
            template: args.template,
            context: args.context,
            language: args.language,
            fresh: args.fresh,
          }),
          job,
        );
      } catch (error) {
        // The id below must always resolve: if the child never started, the
        // job file must say so rather than "running" forever.
        const message = error instanceof Error ? error.message : String(error);
        await new JobReporter({
          fs: context.fs,
          jobsDir: context.paths.jobsDir,
          initial: job,
          log: new JobLog(job.log),
        }).fail(message);
        return fail({ jobId: job.id, error: `failed to start the job: ${message}` });
      }

      return ok({
        jobId: job.id,
        kind: job.kind,
        poll: 'call job_status with this id; a few minutes apart is often enough',
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
