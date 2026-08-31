import type { Command } from 'commander';
import { FailureError } from '@laud/core';
import type { Recording } from '@laud/core';
import type { CliContext } from '../wiring.js';
import { isInteractive, requireConsent } from './setup.js';

interface RmOptions {
  readonly force?: boolean;
}

/**
 * Describes what deletion will actually do, for the confirmation prompt.
 *
 * Names the storage copy explicitly. laud's `import` COPIES a file into its
 * own storage and leaves the original where it was, so "delete this
 * recording" removes laud's copy and nothing else. Someone about to confirm
 * an irreversible action should not have to go and read the source to find
 * that out.
 */
export function describeDeletion(recordings: readonly Recording[]): readonly string[] {
  const lines = recordings.map(
    (recording) => `  ${recording.id}  ${recording.title ?? recording.sourcePath}`,
  );
  return [
    recordings.length === 1
      ? 'This will permanently delete 1 recording, its transcripts, and its segments:'
      : `This will permanently delete ${recordings.length} recordings, their transcripts, and their segments:`,
    ...lines,
    "laud's own copy of the audio goes too. The file you imported from is not touched.",
  ];
}

export function registerRm(program: Command, context: CliContext): void {
  program
    .command('rm')
    .argument('<ids...>', 'recording ids to delete')
    .option('--force', 'delete without asking')
    .description("Delete recordings from the library, with laud's copy of their audio")
    .action(async (ids: string[], options: RmOptions) => {
      await context.ui.frame('Deleting recordings', async () => {
        const recordings = await context.store.listRecordings({ ids });

        // Every id is checked before anything is deleted. A typo in the third
        // of three ids must not leave the first two gone and the work half
        // done -- there is no undo to fall back on.
        const found = new Set(recordings.map((recording) => recording.id));
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length > 0) {
          throw new FailureError(
            missing.length === 1
              ? `No recording with id ${missing[0]}. Nothing was deleted.`
              : `No recordings with ids ${missing.join(', ')}. Nothing was deleted.`,
          );
        }

        for (const line of describeDeletion(recordings)) context.write(line);

        // Reuses setup's guard rather than writing a second one: same
        // question (may this run change things without being asked?), same
        // answer, and two copies would drift. It also gives the same refusal
        // with no terminal, which matters more here than there -- a script
        // that silently deleted a library would be the worst outcome in this
        // file.
        const consented = await requireConsent({
          yes: options.force === true,
          interactive: isInteractive(process.env, process.stdin.isTTY === true),
          commandName: 'rm',
          action: 'deleting recordings',
          consentFlag: '--force',
        });
        if (!consented) {
          context.write('Nothing was deleted.');
          return;
        }

        for (const recording of recordings) {
          const mediaFile = `${context.paths.mediaRoot}/${recording.mediaPath}`;
          const mediaExisted = await context.fs.exists(mediaFile);
          // Audio first, then the row. The other order can leave a file with
          // nothing pointing at it, which nothing would ever clean up; this
          // order can at worst leave a row whose audio is gone, which
          // `doctor` and `transcribe` both already report.
          await context.fs.removeFile(mediaFile);
          await context.store.deleteRecording(recording.id);
          context.ui.deleted(recording, mediaExisted);
        }
      });
    });
}
