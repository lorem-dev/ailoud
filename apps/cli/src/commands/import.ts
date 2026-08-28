import type { Command } from 'commander';
import { importPath } from '@laud/core';
import type { CliContext } from '../wiring.js';

interface ImportOptions {
  readonly title?: string;
  readonly notes?: string;
}

export function registerImport(program: Command, context: CliContext): void {
  program
    .command('import')
    .argument('<path...>', 'audio or video files, or directories of them')
    .option('--title <text>', 'title for the imported recording')
    .option('--notes <text>', 'free-form notes')
    .description('Add recordings to the library')
    .action(async (paths: string[], options: ImportOptions) => {
      await context.ui.frame('import', async () => {
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
            context.ui.imported(recording, alreadyPresent);
          }
        }
      });
    });
}
