import type { Command } from 'commander';
import { UsageError } from '@laud/core';
import type { CliContext } from '../wiring.js';
import { resolveRecording } from '../resolveId.js';

interface AnnotateOptions {
  readonly title?: string;
  readonly notes?: string;
  readonly speaker?: string[];
}

/**
 * Parses one `--speaker label=name` pair.
 *
 * Split on the FIRST `=` only: a name may contain one, a label may not, so
 * splitting on every occurrence would reject "spk0=Ann = the manager" for no
 * reason. An empty label or name is rejected rather than stored, since
 * neither identifies anyone and both would silently produce a speaker that
 * cannot be referred to again.
 */
export function parseSpeakerAssignment(raw: string): { label: string; name: string } {
  const at = raw.indexOf('=');
  if (at === -1) {
    throw new UsageError(`--speaker expects "label=name", got "${raw}".`);
  }
  const label = raw.slice(0, at).trim();
  const name = raw.slice(at + 1).trim();
  if (label === '') throw new UsageError(`--speaker has an empty label, in "${raw}".`);
  if (name === '') throw new UsageError(`--speaker has an empty name, in "${raw}".`);
  return { label, name };
}

/** Rejects a set of assignments that names the same label twice. */
export function parseSpeakerAssignments(raw: readonly string[]): { label: string; name: string }[] {
  const parsed = raw.map(parseSpeakerAssignment);
  const seen = new Set<string>();
  for (const { label } of parsed) {
    if (seen.has(label)) {
      // Last-one-wins would be a coin toss the user did not know they were
      // tossing; they meant one of the two and should say which.
      throw new UsageError(`--speaker names "${label}" twice; give it one name.`);
    }
    seen.add(label);
  }
  return parsed;
}

export function registerAnnotate(program: Command, context: CliContext): void {
  program
    .command('annotate')
    .argument('<id>', 'recording id, or enough of its start to be unambiguous')
    .option('--title <text>', "the recording's title")
    .option('--notes <text>', 'free-form context about the recording')
    .option(
      '--speaker <label=name>',
      'a real name for one diarizer label, e.g. speaker_00=Ann; repeatable',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .description('Add context to a recording: a title, notes, and real speaker names')
    .action(async (id: string, options: AnnotateOptions) => {
      await context.ui.frame('Annotating', async () => {
        const assignments = parseSpeakerAssignments(options.speaker ?? []);
        if (
          options.title === undefined &&
          options.notes === undefined &&
          assignments.length === 0
        ) {
          // A command that succeeded having done nothing is indistinguishable
          // from one that worked, which is the wrong thing to be ambiguous
          // about.
          throw new UsageError(
            'annotate needs something to set: --title, --notes, or --speaker label=name.',
          );
        }

        const recording = await resolveRecording(context.store, id);

        if (options.title !== undefined || options.notes !== undefined) {
          await context.store.annotateRecording(recording.id, {
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.notes === undefined ? {} : { notes: options.notes }),
          });
        }

        // Labels are NOT checked against the segments on purpose. Annotating
        // before transcribing is a reasonable order to work in -- you know
        // who is in the recording before laud does -- and refusing a label
        // that has no segments yet would forbid it. `show --speakers` lists
        // names with no matching segments, which is where a typo surfaces.
        for (const { label, name } of assignments) {
          await context.store.setSpeakerName(recording.id, label, name);
        }

        const parts = [
          ...(options.title === undefined ? [] : ['title']),
          ...(options.notes === undefined ? [] : ['notes']),
          ...(assignments.length === 0
            ? []
            : [`${assignments.length} speaker name${assignments.length === 1 ? '' : 's'}`]),
        ];
        context.write(`${recording.id}  set ${parts.join(', ')}`);
      });
    });
}
