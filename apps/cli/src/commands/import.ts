import type { Command } from 'commander';
import { importPath } from '@laud/core';
import type { CliContext } from '../wiring.js';
import { collectTag, parseTags } from '../tags.js';

interface ImportOptions {
  readonly title?: string;
  readonly notes?: string;
  readonly tag?: string[];
}

export function registerImport(program: Command, context: CliContext): void {
  program
    .command('import')
    .argument('<path...>', 'audio or video files, or directories of them')
    .option('--title <text>', 'title for the imported recording')
    .option('--notes <text>', 'free-form notes')
    // Tagging at import, not later: a tag is how a recording is found again by
    // context, and the moment it is easiest to supply is the moment somebody
    // is already thinking about what this file is. Postponed, it stays undone.
    .option('--tag <tag>', 'tag the imported recordings; repeatable', collectTag)
    .description('Add recordings to the library')
    .action(async (paths: string[], options: ImportOptions) => {
      const tags = parseTags(options.tag ?? []);
      await context.ui.frame('Importing recordings', async () => {
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
            {
              path,
              ...(options.title === undefined ? {} : { title: options.title }),
              ...(options.notes === undefined ? {} : { notes: options.notes }),
            },
          );
          for (const { recording, alreadyPresent } of results) {
            // Applied to something already present too: re-importing with a
            // tag is a reasonable way to say "and this belongs to that group",
            // and addTags is idempotent.
            if (tags.length > 0) await context.store.addTags(recording.id, tags);
            context.ui.imported(recording, alreadyPresent);
          }
        }
      });
    });
}
