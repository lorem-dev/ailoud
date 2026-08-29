import { FailureError } from '../domain/errors.js';
import type { ModelChoice } from './catalogue.js';
import { VAD_MODEL, findModel } from './catalogue.js';
import type { Remedy } from './remedy.js';

/** A remedy with everything needed to execute it resolved. */
export type Action =
  | { readonly kind: 'install-ffmpeg' }
  | { readonly kind: 'install-whisper' }
  | {
      readonly kind: 'download-model';
      readonly slot: 'transcription' | 'vad';
      readonly model: ModelChoice;
    }
  | { readonly kind: 'create-directory'; readonly path: string };

export interface PlanOptions {
  readonly modelName: string;
}

/**
 * Directories before binaries before models. The order matters: the media
 * root must exist before anything writes near it, and the whisper binaries
 * should land before the models they will be checked against, so that a
 * re-check after a partial run reports the more useful failure.
 */
const ORDER: readonly Action['kind'][] = [
  'create-directory',
  'install-ffmpeg',
  'install-whisper',
  'download-model',
];

/** Two remedies are the same job when this key matches. */
function keyOf(remedy: Remedy): string {
  switch (remedy.kind) {
    case 'create-directory':
      return `create-directory:${remedy.path}`;
    case 'download-model':
      return `download-model:${remedy.slot}`;
    default:
      return remedy.kind;
  }
}

function resolve(remedy: Remedy, options: PlanOptions): Action {
  if (remedy.kind !== 'download-model') return remedy;
  if (remedy.slot === 'vad') return { ...remedy, model: VAD_MODEL };
  const model = findModel(options.modelName);
  if (model === undefined) {
    throw new FailureError(
      `unknown model "${options.modelName}"; run "laud setup" without --model to choose one`,
    );
  }
  return { ...remedy, model };
}

/**
 * Turns the remedies of failing checks into an ordered, deduplicated action
 * list. Pure: it decides WHAT to do, never does it. Callers pass only the
 * remedies they want acted on, which is the whole difference between `setup`
 * (everything missing) and `doctor --fix` (only what failed) -- the
 * restriction is an input here, not a second code path.
 */
export function planProvisioning(
  remedies: readonly Remedy[],
  options: PlanOptions,
): readonly Action[] {
  const unique = new Map<string, Remedy>();
  for (const remedy of remedies) {
    const key = keyOf(remedy);
    if (!unique.has(key)) unique.set(key, remedy);
  }
  return [...unique.values()]
    .map((remedy) => resolve(remedy, options))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** Total bytes the plan will download, for the confirmation prompt. */
export function planDownloadBytes(actions: readonly Action[]): number {
  return actions.reduce(
    (total, action) => (action.kind === 'download-model' ? total + action.model.bytes : total),
    0,
  );
}
