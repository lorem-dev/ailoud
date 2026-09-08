/** One stage of a run, and how much of the whole it is worth. */
export interface StageWeight {
  readonly name: string;
  readonly weight: number;
}

function bounded(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Maps "half way through the detection stage" onto "23% of the run".
 *
 * Weights are normalised by their sum rather than required to add to 100, so
 * a caller can hand over whatever units the work is naturally measured in --
 * see multilingualStages, where detection is counted in model loads and
 * transcription in seconds of audio.
 *
 * An unknown stage name answers 0 rather than throwing. This function sits
 * on the progress path, and the progress path may not fail a transcription.
 */
export function stageScale(
  stages: readonly StageWeight[],
): (name: string, within: number) => number {
  const total = stages.reduce((sum, stage) => sum + Math.max(0, stage.weight), 0);
  const offsets = new Map<string, { offset: number; weight: number }>();
  let running = 0;
  for (const stage of stages) {
    const weight = Math.max(0, stage.weight);
    offsets.set(stage.name, { offset: running, weight });
    running += weight;
  }
  return (name, within) => {
    if (total <= 0) return 0;
    const found = offsets.get(name);
    if (found === undefined) return 0;
    return bounded((found.offset + found.weight * bounded(within)) / total);
  };
}

/**
 * The larger of the two, bounded to 0..1.
 *
 * A bar that goes backwards is worse than a bar that stalls: the reader
 * stops believing the number. The multilingual path can genuinely produce a
 * lower fraction than it last reported -- a run merged differently than the
 * detection pass suggested -- and this is where that is absorbed.
 *
 * A non-finite `next` is treated as no news rather than as zero, so a
 * division that went wrong upstream cannot reset the bar.
 */
export function clampMonotonic(previous: number, next: number): number {
  const floor = bounded(previous);
  if (!Number.isFinite(next)) return floor;
  return Math.max(floor, bounded(next));
}

/**
 * How far through a batch of recordings, weighted by their durations.
 *
 * Counting recordings instead would report 60% at "3 of 5" when the fifth is
 * longer than the first four together, which is the single most misleading
 * number this feature could produce. Durations come from `Recording.
 * durationMs`, which import already stores.
 *
 * Falls back to counting when every duration is zero or missing, which is
 * the only honest thing left to do.
 */
export function weightedOverall(
  durationsMs: readonly number[],
  index: number,
  within: number,
): number {
  if (durationsMs.length === 0) return 0;
  const safe = durationsMs.map((ms) => (Number.isFinite(ms) && ms > 0 ? ms : 0));
  const total = safe.reduce((sum, ms) => sum + ms, 0);
  if (total <= 0) return bounded((Math.min(index, durationsMs.length) + 0) / durationsMs.length);
  if (index >= safe.length) return 1;
  const done = safe.slice(0, index).reduce((sum, ms) => sum + ms, 0);
  return bounded((done + (safe[index] ?? 0) * bounded(within)) / total);
}

/**
 * The single-language path: one whisper call over the whole file.
 *
 * whisper is nearly all of it, and its own reported percentage fills that
 * stage. The conversion is a couple of seconds of ffmpeg. Diarization is
 * omitted entirely when it is off, rather than left in at its full weight of
 * 8: a stage that is present but never reports progress is a stage the bar
 * can never move through, and leaving diarizing's 8 in unused would strand
 * the bar at 92% forever. (Leaving it in at weight zero would not stall it --
 * see multilingualStages below for what a zero-weight stage does instead.)
 *
 * Four rather than two since denoising: the stage can now hold a conversion,
 * a noise scan and a re-encode. No new stage was added for them -- a stage
 * that is present but never reported is exactly how the bar gets stranded,
 * per the note below.
 */
export function singlePassStages(diarize: boolean): StageWeight[] {
  return [
    { name: 'converting', weight: 4 },
    { name: 'transcribing', weight: 90 },
    ...(diarize ? [{ name: 'diarizing', weight: 8 }] : []),
  ];
}

/**
 * The multilingual path, where the split between detection and transcription
 * cannot be hardcoded.
 *
 * Every detection unit is a SEPARATE whisper process, and detectLanguage's
 * own comment says it "costs about the same as a short transcription because
 * almost all of it is loading the model". So detection is counted in model
 * loads and transcription in tenths of its audio (whisper runs roughly ten
 * times faster than real time), and stageScale normalises the two against
 * each other. A forty-unit recording therefore does not sit at 20% for most
 * of the run, which a fixed split would have produced.
 *
 * Both computed weights have a floor of 1. Without it, a stage with weight 0
 * that turns out to be the LAST one in the list would make the bar jump to
 * 100% the moment that stage's name is first reported, not once its work is
 * actually done: stageScale gives a terminal stage's offset the full total
 * already, so weight 0 there contributes nothing further and the fraction
 * reads as complete immediately. The floor keeps every stage genuinely worth
 * one unit of the bar, at the cost of overweighting it slightly on a very
 * short recording.
 */
export function multilingualStages(input: {
  readonly unitCount: number;
  readonly audioSeconds: number;
  readonly diarize: boolean;
}): StageWeight[] {
  const detecting = Math.max(1, Math.round(input.unitCount));
  const transcribing = Math.max(1, Math.round(input.audioSeconds / 10));
  return [
    { name: 'converting', weight: 4 },
    { name: 'segmenting', weight: 8 },
    { name: 'detecting', weight: detecting },
    { name: 'transcribing', weight: transcribing },
    ...(input.diarize ? [{ name: 'labelling', weight: 2 }] : []),
  ];
}
