import type {
  AudioTool,
  Clock,
  Diarizer,
  Fs,
  Ids,
  RecordingStore,
  SpeakerTurn,
  SpeechSegmenter,
  SpeechSpan,
  TranscriptionProvider,
} from '../domain/ports.js';
import type { RawSegment, Recording, Segment, Transcript } from '../domain/model.js';
import type { WavPrepared } from '../domain/ports.js';
import { FailureError } from '../domain/errors.js';
import { assignSpeakers } from '../diarize/assign.js';
import type { DenoiseMode } from '../audio/noise.js';
import { snrDb } from '../audio/noise.js';
import type { OnProgress } from '../progress/events.js';
import { multilingualStages, singlePassStages, stageScale } from '../progress/scale.js';
import {
  detectionWindowMs,
  mergeRuns,
  resolveDeclaredLanguages,
  subdivideSpans,
  type DetectedSpan,
  type LanguageRun,
} from '../transcribe/merge.js';
import { resolveBySpeaker } from '../transcribe/bySpeaker.js';

export interface TranscribeDeps {
  readonly fs: Fs;
  readonly store: RecordingStore;
  readonly audio: AudioTool;
  readonly stt: TranscriptionProvider;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly mediaRoot: string;
  /** Only consulted when `TranscribeOptions.multilingual` is set. */
  readonly segmenter?: SpeechSegmenter;
  /** Only consulted when `TranscribeOptions.diarize` is set. */
  readonly diarizer?: Diarizer;
  /**
   * Reports non-fatal problems, e.g. a diarizer that failed. Core does no
   * I/O of its own, so the CLI supplies the sink (routed to `ui`); left
   * unset, such problems are simply not reported.
   */
  readonly onWarning?: (message: string) => void;
  /**
   * Routine facts worth recording but not worth interrupting anyone with.
   *
   * Distinct from `onWarning`, which reaches the terminal: the CLI wires this
   * to the job log only. A denoising decision is a routine decision, and a
   * foreground run has no log, so it correctly prints nothing.
   */
  readonly onNotice?: (message: string) => void;
  /**
   * Reports how far along the run is. Supplied by the caller for the same
   * reason `onWarning` is: core does no I/O and does not know whether this
   * becomes a spinner, a file, or nothing.
   *
   * Every call goes through `report` below, which swallows whatever this
   * throws. A progress observer that could abort a transcription would be
   * strictly worse than no progress at all.
   */
  readonly onProgress?: OnProgress;
}

export interface TranscribeOptions {
  readonly language?: string;
  readonly model?: string;
  /**
   * Segments the recording, detects each segment's language, and
   * transcribes each language run separately instead of assuming one
   * language for the whole file. Requires `TranscribeDeps.segmenter` and a
   * provider whose `capabilities.supportsLanguageDetection` is true; refuses
   * rather than silently falling back to single-language behaviour.
   */
  readonly multilingual?: boolean;
  /**
   * The languages the caller knows are present. Only meaningful alongside
   * `multilingual`.
   *
   * whisper's detector answers with any language in the world and cannot be
   * restricted, so on a Russian/English recording it will sometimes report
   * Polish for a Russian stretch -- and that stretch is then transcribed as
   * Polish, coming back as phonetic nonsense. Declaring the set turns that
   * answer from a discovery into a knowable mis-detection; see
   * `resolveDeclaredLanguages`. Empty means nothing was declared and every
   * detection is taken at face value.
   */
  readonly declaredLanguages?: readonly string[];
  /**
   * Runs speaker diarization over the recording and attributes each
   * transcribed segment to a speaker by time overlap. Requires
   * `TranscribeDeps.diarizer`.
   */
  readonly diarize?: true;
  /** Hint for the diarizer: the known number of speakers, when known. */
  readonly speakers?: number;
  /**
   * Whether to denoise the converted audio. Absent means no measurement and
   * no filtering, which is what every caller predating this option expects.
   */
  readonly denoise?: DenoiseMode;
}

/**
 * Emits one progress event, and cannot fail.
 *
 * The try is the whole point of the function existing. Every emitter in this
 * file goes through it, so "a progress sink cannot break a transcription" is
 * true by structure rather than by everyone remembering to wrap their call.
 * It absorbs both a synchronous throw and, via the guard below, a rejected
 * promise from a sink that ignored `OnProgress`'s "should be synchronous".
 */
function report(deps: TranscribeDeps, stage: string, fraction?: number): void {
  try {
    const returned: unknown = deps.onProgress?.({
      stage,
      ...(fraction === undefined ? {} : { fraction }),
    });
    // `OnProgress` returns void, but TypeScript assigns `() => Promise<void>`
    // to `() => void` without complaint, and this project does not enable
    // no-misused-promises. So an async sink is reachable, and its rejection
    // would surface as an unhandled rejection -- which on Node can end the
    // process in the middle of an hour of transcription. The synchronous
    // catch below cannot see that, so the thenable is swallowed here.
    if (
      typeof returned === 'object' &&
      returned !== null &&
      typeof (returned as { readonly then?: unknown }).then === 'function'
    ) {
      void (returned as Promise<unknown>).catch(() => {
        // Same reason as the catch below. Deliberately empty.
      });
    }
  } catch {
    // See the doc comment. Deliberately empty.
  }
}

/**
 * Emits one job-log notice, and cannot fail.
 *
 * Same guarantee `report` gives, and for the same reason: an observer does
 * not get to fail a transcription.
 */
function notice(deps: TranscribeDeps, message: string): void {
  try {
    deps.onNotice?.(message);
  } catch {
    // Same guarantee report() gives: an observer does not get to fail a
    // transcription.
  }
}

/**
 * One line describing what the conversion did about noise, with the numbers
 * that decided it -- an agent reading a job log has to be able to tell that
 * the audio was altered, or that it deliberately was not.
 */
function denoiseMessage(prepared: WavPrepared): string {
  const snr = snrDb(prepared.profile);
  const measured = snr === null ? 'no measurable noise floor' : `snr ${snr.toFixed(1)} dB`;
  return prepared.denoised
    ? `audio denoised before transcription (${measured})`
    : `audio not denoised (${measured})`;
}

/**
 * Speakers are an enrichment, never a precondition. A diarizer that is
 * missing, crashes, or emits nothing parseable must cost the caller their
 * speaker labels and nothing else -- losing an expensive transcription to a
 * failed extra is the worst trade available here.
 *
 * Every outcome in which `diarize` was asked for and no speaker was
 * attributed warns, not just the one where the diarizer throws. Without that
 * a `--diarize` run whose diarizer was never wired up, or whose binary exited
 * cleanly having recognized nothing, produces output byte-identical to a
 * plain run and exits 0 -- the user is told they got speakers when they did
 * not. Section 5.7 of the diarization design names the "emits nothing
 * parseable" case explicitly.
 */
/**
 * Speaker turns for use as detection units, or nothing.
 *
 * Never throws, for the same reason withSpeakers does not: the diarizer is an
 * enrichment here too. If it is missing or fails, the run falls back to the
 * segmenter's spans and still produces a transcript -- losing the better
 * segmentation, not the words.
 *
 * The turns are fetched once and used twice: here to decide what to detect
 * language on, and later by withSpeakers to label the segments. Running the
 * diarizer twice over the same audio would double the cost for one answer.
 */
async function diarizeQuietly(
  deps: TranscribeDeps,
  options: TranscribeOptions,
  wavPath: string,
): Promise<readonly SpeakerTurn[]> {
  if (deps.diarizer === undefined) return [];
  try {
    return await deps.diarizer.turns(wavPath, {
      ...(options.speakers === undefined ? {} : { speakers: options.speakers }),
    });
  } catch (error) {
    deps.onWarning?.(
      `speaker diarization failed, so language detection fell back to speech segmentation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

async function withSpeakers(
  deps: TranscribeDeps,
  options: TranscribeOptions,
  wavPath: string,
  segments: readonly RawSegment[],
  /**
   * Turns already fetched by the caller, reused rather than asked for again.
   * The multilingual path needs them earlier, to decide what to detect
   * language on, and diarizing the same audio twice would double the cost
   * for one answer. Empty means "not fetched yet, go and get them".
   */
  alreadyFetched: readonly SpeakerTurn[] = [],
): Promise<RawSegment[]> {
  if (options.diarize !== true) return [...segments];
  if (alreadyFetched.length > 0) {
    try {
      return assignSpeakers(segments, alreadyFetched);
    } catch (error) {
      deps.onWarning?.(
        `assigning speakers failed, so this transcript has no speakers: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [...segments];
    }
  }
  if (deps.diarizer === undefined) {
    // Unreachable from the CLI: `CliContext.createDiarizer()` is
    // non-nullable, so `--diarize` either yields a diarizer or throws an
    // EnvironmentError naming the unconfigured model. Kept as a guard for
    // library callers, who can build deps without one -- and it must warn
    // rather than throw, because the transcript is already worth keeping.
    //
    // Names no install command on purpose. `ailoud setup` and `ailoud doctor
    // --fix` both refuse Windows, so naming them here would rebuild the same
    // dead end checkDiarizerBinary's fix text was just cured of (see
    // installHint in ../provision/remedy.ts). `ailoud doctor` is safe on every
    // platform and reports the per-platform remedy itself.
    deps.onWarning?.(
      'speaker diarization was requested but no diarizer is available, so this transcript ' +
        'has no speakers. Run "ailoud doctor" to see which diarization pieces are missing.',
    );
    return [...segments];
  }

  // Only the call that can genuinely fail lives inside the try -- the
  // diarizer, and nothing else. A warning raised in here would be
  // caught below, relabelled as "diarization failed" against the sink's own
  // error rather than the real cause, and rethrown out of withSpeakers --
  // taking the finished transcription with it. Keeping every onWarning call
  // outside makes "withSpeakers cannot throw" true by structure instead of
  // by an argument about what a sink happens to do.
  let turns: readonly SpeakerTurn[];
  try {
    turns = await deps.diarizer.turns(wavPath, {
      ...(options.speakers === undefined ? {} : { speakers: options.speakers }),
    });
  } catch (error) {
    deps.onWarning?.(
      `speaker diarization failed, so this transcript has no speakers: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [...segments];
  }

  if (turns.length === 0) {
    // The binary can exit 0 having emitted nothing this side can parse --
    // too little speech to cluster, or output in a shape the adapter's
    // parser does not recognize. assignSpeakers on an empty turn list is
    // a no-op, so without this branch the run is silent and indetectable.
    deps.onWarning?.(
      'speaker diarization found no speaker turns, so this transcript has no speakers. ' +
        'Passing --speakers <n> is more reliable than letting the count be inferred; ' +
        'a lower "stt.diarization.threshold" also splits more readily.',
    );
    return [...segments];
  }
  try {
    return assignSpeakers(segments, turns);
  } catch (error) {
    // assignSpeakers is pure arithmetic over typed spans and has no realistic
    // way to throw, but the guarantee this function offers its callers -- that
    // a diarization problem costs speaker labels and nothing else -- is worth
    // holding by structure rather than by an argument about what pure code
    // happens to do. Every escape hatch above returns the segments unchanged;
    // so does this one.
    deps.onWarning?.(
      `assigning speakers failed, so this transcript has no speakers: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [...segments];
  }
}

export async function transcribeRecording(
  deps: TranscribeDeps,
  recording: Recording,
  options: TranscribeOptions,
): Promise<Transcript> {
  if (deps.stt.capabilities.maxBytes !== null) {
    throw new FailureError(
      `${deps.stt.name} declares a request size limit, and ailoud cannot split audio yet. Use a provider without a limit.`,
    );
  }

  if (options.multilingual === true) {
    return transcribeMultilingual(deps, recording, options);
  }

  const scale = stageScale(singlePassStages(options.diarize === true));
  const tempWav = await deps.fs.tempFile('.wav');
  try {
    report(deps, 'converting', scale('converting', 0));
    const prepared = await deps.audio.toWav16kMono(
      `${deps.mediaRoot}/${recording.mediaPath}`,
      tempWav.path,
      options.denoise === undefined ? undefined : { denoise: options.denoise },
    );
    if (options.denoise !== undefined) {
      notice(deps, denoiseMessage(prepared));
      // The terminal hears about it only when the audio actually changed: the
      // transcript no longer comes from the file the user imported, and that
      // is worth one line.
      if (prepared.denoised) deps.onWarning?.(denoiseMessage(prepared));
    }
    report(deps, 'transcribing', scale('transcribing', 0));
    const result = await deps.stt.transcribe(tempWav.path, {
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(options.model === undefined ? {} : { model: options.model }),
      onProgress: (fraction) => report(deps, 'transcribing', scale('transcribing', fraction)),
    });

    if (result.segments.length === 0) {
      throw new FailureError(`${deps.stt.name} found no speech in ${recording.sourcePath}`);
    }

    // No fraction: the diarizer reports nothing about its own progress, and
    // a number invented here would be indistinguishable from a measured one.
    if (options.diarize === true) report(deps, 'diarizing');

    // One diarizer pass over the whole recording, on the same full-recording
    // wav the transcript just came from -- before tempWav.remove() runs in
    // this try's finally.
    const withSpeakerLabels = await withSpeakers(deps, options, tempWav.path, result.segments);

    const transcript: Transcript = {
      id: deps.ids.next(),
      recordingId: recording.id,
      provider: deps.stt.name,
      model: result.model,
      language: result.language,
      text: withSpeakerLabels.map((s) => s.text).join(' '),
      createdAt: deps.clock.nowIso(),
    };

    const segments = buildSegments(deps, transcript.id, withSpeakerLabels);

    // Nothing progress-related between the assembled transcript and its
    // write to the store -- that boundary stays exactly as bare as it was
    // before this feature existed. The closing report lands right after,
    // once the transcript this run exists to produce is already durable.
    await deps.store.insertTranscript(transcript, segments);
    report(deps, options.diarize === true ? 'diarizing' : 'transcribing', 1);
    return transcript;
  } finally {
    await tempWav.remove();
  }
}

/** Turns provider output into stored segments: assigns ids and 0-based indices. */
function buildSegments(
  deps: TranscribeDeps,
  transcriptId: string,
  raw: readonly RawSegment[],
): Segment[] {
  return raw.map((seg, idx) => ({
    id: deps.ids.next(),
    transcriptId,
    idx,
    startMs: seg.startMs,
    endMs: seg.endMs,
    text: seg.text,
    speaker: seg.speaker ?? null,
    language: seg.language ?? null,
  }));
}

/** One language run's transcription, with segment timestamps already shifted to absolute. */
interface RunOutcome {
  readonly run: LanguageRun;
  readonly model: string;
  readonly segments: RawSegment[];
}

async function transcribeMultilingual(
  deps: TranscribeDeps,
  recording: Recording,
  options: TranscribeOptions,
): Promise<Transcript> {
  if (deps.segmenter === undefined) {
    throw new FailureError(
      'multilingual transcription requires a segmenter, and none is wired up for this run.',
    );
  }
  if (!deps.stt.capabilities.supportsLanguageDetection) {
    throw new FailureError(
      `${deps.stt.name} cannot detect a language, and multilingual transcription needs a provider that can.`,
    );
  }
  // supportsLanguageDetection is true, and the port promises detectLanguage
  // is defined whenever that capability is; a provider violating its own
  // contract is a provider bug, not a recoverable user error. Bind it to
  // deps.stt now: a bare reference to a method loses its `this` when called
  // later, and providers are free to rely on instance state.
  if (deps.stt.detectLanguage === undefined) {
    throw new Error(
      `${deps.stt.name} declares supportsLanguageDetection but has no detectLanguage`,
    );
  }
  const detectLanguage = deps.stt.detectLanguage.bind(deps.stt);

  const segmenter = deps.segmenter;

  const tempWav = await deps.fs.tempFile('.wav');
  try {
    // The scale cannot be built until the units are known -- their count is
    // one of its weights. Until then, report stages without a fraction.
    report(deps, 'converting');
    const prepared = await deps.audio.toWav16kMono(
      `${deps.mediaRoot}/${recording.mediaPath}`,
      tempWav.path,
      options.denoise === undefined ? undefined : { denoise: options.denoise },
    );
    if (options.denoise !== undefined) {
      notice(deps, denoiseMessage(prepared));
      // The terminal hears about it only when the audio actually changed: the
      // transcript no longer comes from the file the user imported, and that
      // is worth one line.
      if (prepared.denoised) deps.onWarning?.(denoiseMessage(prepared));
    }
    report(deps, 'segmenting');

    const declared = options.declaredLanguages ?? [];

    // Speaker turns are better detection units than windows cut from speech
    // spans, when they are available: they are the boundaries language
    // actually changes on in a bilingual exchange, and pooling a speaker's
    // turns gives detection far more audio to judge by than any one turn
    // does. See resolveBySpeaker. Falls back to the segmenter when no
    // diarizer was wired up, which is every run without --diarize.
    const speakerTurns =
      options.diarize === true && deps.diarizer !== undefined
        ? await diarizeQuietly(deps, options, tempWav.path)
        : [];

    const units: readonly (SpeechSpan & { readonly speaker?: string })[] =
      speakerTurns.length > 0
        ? speakerTurns
        : subdivideSpans(
            await segmenter.segments(tempWav.path),
            detectionWindowMs(declared.length),
          );

    const audioSeconds = recording.durationMs / 1000;
    const scale = stageScale(
      multilingualStages({
        unitCount: units.length,
        audioSeconds,
        diarize: options.diarize === true,
      }),
    );
    report(deps, 'segmenting', scale('segmenting', 1));

    const detected: (DetectedSpan & { speaker?: string })[] = [];
    for (const unit of units) {
      const slice = await deps.fs.tempFile('.wav');
      try {
        await deps.audio.slice(tempWav.path, slice.path, unit.startMs, unit.endMs);
        const language = await detectLanguage(slice.path, {
          ...(options.model === undefined ? {} : { model: options.model }),
        });
        detected.push({ ...unit, language });
        report(deps, 'detecting', scale('detecting', detected.length / Math.max(1, units.length)));
      } finally {
        await slice.remove();
      }
    }

    // Resolved before merging, not after: mergeRuns groups by language, so a
    // unit still carrying a mis-detected language would split a run that
    // should have been continuous -- which is how the first half of a phrase
    // ends up transcribed in the wrong language and lost.
    //
    // With speaker labels the resolution is per speaker (their own turns
    // outvote a bad one); without them it can only be per declared set.
    const resolved =
      speakerTurns.length > 0
        ? resolveBySpeaker(
            detected.map((unit) => ({ ...unit, speaker: unit.speaker ?? '' })),
            declared,
          )
        : resolveDeclaredLanguages(detected, declared);
    const runs = mergeRuns(resolved);
    if (runs.length === 0) {
      throw new FailureError(`${deps.stt.name} found no speech in ${recording.sourcePath}`);
    }

    const outcomes: RunOutcome[] = [];
    const totalRunMs = runs.reduce((sum, run) => sum + (run.endMs - run.startMs), 0);
    let doneRunMs = 0;
    for (const run of runs) {
      const runMs = run.endMs - run.startMs;
      const slice = await deps.fs.tempFile('.wav');
      try {
        await deps.audio.slice(tempWav.path, slice.path, run.startMs, run.endMs);
        const result = await deps.stt.transcribe(slice.path, {
          language: run.language,
          ...(options.model === undefined ? {} : { model: options.model }),
          // Weighted by audio, not by run: runs differ in length by an order
          // of magnitude, and counting them makes a bar that crawls then jumps.
          onProgress: (fraction) =>
            report(
              deps,
              'transcribing',
              scale(
                'transcribing',
                totalRunMs <= 0 ? 0 : (doneRunMs + runMs * fraction) / totalRunMs,
              ),
            ),
        });
        outcomes.push({
          run,
          model: result.model,
          // The run's own transcription starts its timestamps at zero:
          // whisper only ever saw this slice. Shift back into the
          // recording's absolute timeline before anything is stored, and
          // stamp the run's own (forced, known) language onto each segment
          // rather than trusting whatever the provider echoes back.
          segments: result.segments.map((seg) => ({
            ...seg,
            startMs: seg.startMs + run.startMs,
            endMs: seg.endMs + run.startMs,
            language: run.language,
          })),
        });
        doneRunMs += runMs;
      } finally {
        await slice.remove();
      }
    }

    const allSegments = outcomes.flatMap((o) => o.segments);
    if (allSegments.length === 0) {
      throw new FailureError(`${deps.stt.name} found no speech in ${recording.sourcePath}`);
    }

    // No fraction: the diarizer reports nothing about its own progress, and
    // a number invented here would be indistinguishable from a measured one.
    // Announced here, immediately before the labelling work itself, and
    // deliberately not next to the closing report below -- moving it there
    // would announce the stage only after it already finished.
    if (options.diarize === true) report(deps, 'labelling');

    // Every run's segments are already shifted onto the recording's absolute
    // timeline (see the comment above), so one diarizer pass over the whole
    // wav -- not one per run -- lines up with all of them at once.
    const withSpeakerLabels = await withSpeakers(
      deps,
      options,
      tempWav.path,
      allSegments,
      speakerTurns,
    );

    // The file has no single language; the longest run by duration is the
    // least wrong answer for a column that must hold one value. Strictly
    // greater-than, deliberately: a tie keeps whichever run was seen first,
    // i.e. the earlier one in the recording. Any tie-break is arbitrary, so
    // the simplest one was chosen rather than left as an accident.
    let longest = outcomes[0]!;
    for (const outcome of outcomes) {
      const duration = outcome.run.endMs - outcome.run.startMs;
      const longestDuration = longest.run.endMs - longest.run.startMs;
      if (duration > longestDuration) longest = outcome;
    }

    const transcript: Transcript = {
      id: deps.ids.next(),
      recordingId: recording.id,
      provider: deps.stt.name,
      model: longest.model,
      language: longest.run.language,
      text: withSpeakerLabels.map((s) => s.text).join(' '),
      createdAt: deps.clock.nowIso(),
    };

    const segments = buildSegments(deps, transcript.id, withSpeakerLabels);

    // Nothing progress-related between the assembled transcript and its
    // write to the store, for the same reason the single-pass path holds
    // that boundary bare. The closing report lands right after.
    await deps.store.insertTranscript(transcript, segments);
    report(deps, options.diarize === true ? 'labelling' : 'transcribing', 1);
    return transcript;
  } finally {
    await tempWav.remove();
  }
}
