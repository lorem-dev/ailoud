import { describe, expect, it } from 'vitest';
import type { RawSegment, Recording } from '../domain/model.js';
import type { Diarizer, SpeechSpan, TranscriptionProvider } from '../domain/ports.js';
import {
  FakeAudioTool,
  FakeClock,
  FakeDiarizer,
  FakeIds,
  FakeSegmenter,
  FakeStt,
  InMemoryStore,
  MemFs,
} from '../testing/fakes.js';
import { transcribeRecording } from './transcribe.js';

const recording: Recording = {
  id: 'R1',
  sha256: 'sha-AUDIO',
  sourcePath: '/in/a.mp3',
  mediaPath: 'sh/sha-AUDIO.mp3',
  durationMs: 3200,
  mime: 'audio/mpeg',
  title: null,
  notes: null,
  importedAt: '2026-01-01T00:00:00.000Z',
};

const deps = () => ({
  fs: new MemFs({ '/data/media/sh/sha-AUDIO.mp3': 'AUDIO' }),
  store: new InMemoryStore(),
  audio: new FakeAudioTool(),
  stt: new FakeStt({
    language: 'ru',
    model: 'base.bin',
    segments: [
      { startMs: 0, endMs: 1500, text: 'Privet.' },
      { startMs: 1500, endMs: 3200, text: 'Kak dela?' },
    ],
  }),
  clock: new FakeClock(),
  ids: new FakeIds(),
  mediaRoot: '/data/media',
});

/** A minimal provider whose transcribe() always throws, for the failure path. */
class ThrowingStt implements TranscriptionProvider {
  readonly name = 'fake';
  readonly capabilities: TranscriptionProvider['capabilities'] = {
    maxBytes: null,
    supportsDiarization: false,
    supportsLanguageHint: true,
    supportsLanguageDetection: false,
  };
  async transcribe(): Promise<{ language: string; model: string; segments: RawSegment[] }> {
    throw new Error('boom');
  }
}

describe('transcribeRecording', () => {
  it('stores a transcript whose text is the segments joined', async () => {
    const d = deps();
    const transcript = await transcribeRecording(d, recording, {});
    expect(transcript).toEqual({
      id: 'ID001',
      recordingId: 'R1',
      provider: 'fake',
      model: 'base.bin',
      language: 'ru',
      text: 'Privet. Kak dela?',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('numbers segments from zero and gives each an id', async () => {
    const d = deps();
    const transcript = await transcribeRecording(d, recording, {});
    const segments = await d.store.listSegments(transcript.id);
    expect(segments.map((s) => [s.idx, s.id, s.startMs, s.text])).toEqual([
      [0, 'ID002', 0, 'Privet.'],
      [1, 'ID003', 1500, 'Kak dela?'],
    ]);
    expect(segments.every((s) => s.speaker === null && s.language === null)).toBe(true);
  });

  it('converts the media to wav before handing it to the provider', async () => {
    const d = deps();
    await transcribeRecording(d, recording, {});
    expect(d.audio.converted).toEqual([['/data/media/sh/sha-AUDIO.mp3', '/tmp/fake-1.wav']]);
  });

  it('deletes the temporary wav afterwards', async () => {
    const d = deps();
    await transcribeRecording(d, recording, {});
    expect(d.fs.files.has('/tmp/fake-1.wav')).toBe(false);
  });

  it('forwards an explicit model override to the provider', async () => {
    const d = deps();
    await transcribeRecording(d, recording, { model: '/models/large.bin' });
    expect(d.stt.calls[0]).toEqual(expect.objectContaining({ model: '/models/large.bin' }));
  });

  it('deletes the temporary wav even when the provider fails', async () => {
    const d = deps();
    const failing = { ...d, stt: new ThrowingStt() };
    await expect(transcribeRecording(failing, recording, {})).rejects.toThrow('boom');
    expect(d.fs.files.has('/tmp/fake-1.wav')).toBe(false);
  });

  it('refuses a provider that declares a size limit', async () => {
    const d = deps();
    const limited = {
      ...d,
      stt: new FakeStt(
        { language: 'ru', model: 'base.bin', segments: [] },
        { maxBytes: 25_000_000 },
      ),
    };
    await expect(transcribeRecording(limited, recording, {})).rejects.toThrow(/cannot split/);
  });

  it('rejects a provider that returns no segments', async () => {
    const d = { ...deps(), stt: new FakeStt({ language: 'ru', model: 'b', segments: [] }) };
    await expect(transcribeRecording(d, recording, {})).rejects.toThrow(/no speech/);
  });
});

describe('transcribeRecording --diarize', () => {
  it('does not call the diarizer without --diarize', async () => {
    const d = deps();
    const diarizer = new FakeDiarizer([{ startMs: 0, endMs: 3200, speaker: 'speaker_00' }]);
    await transcribeRecording({ ...d, diarizer }, recording, {});
    expect(diarizer.calls).toHaveLength(0);
  });

  it('still writes the transcript with no speakers when --diarize is set but no diarizer was wired', async () => {
    // The inverse of the case above: a caller can pass diarize: true while
    // building deps without a diarizer (e.g. the CLI only calls
    // createDiarizer() when --diarize is set, but nothing in the type
    // system stops some other caller from doing this). withSpeakers's guard
    // must treat this exactly like "diarization disabled", not throw.
    const d = deps();
    const transcript = await transcribeRecording(d, recording, { diarize: true });
    expect(transcript).not.toBeNull();
    const segments = await d.store.listSegments(transcript.id);
    expect(segments.map((s) => s.text)).toEqual(['Privet.', 'Kak dela?']);
    expect(segments.every((s) => s.speaker === null)).toBe(true);
  });

  it('warns when --diarize is set but no diarizer was wired, naming what to run', async () => {
    // Otherwise this run is indistinguishable from a non-diarized one: same
    // bytes out, exit 0, and nothing saying the flag did nothing.
    const warnings: string[] = [];
    await transcribeRecording(
      { ...deps(), onWarning: (message) => warnings.push(message) },
      recording,
      { diarize: true },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no diarizer is available/);
    expect(warnings[0]).toMatch(/laud doctor/);
    // Not "laud setup" / "doctor --fix": both refuse Windows, so naming them
    // here would rebuild the dead end checkDiarizerBinary was cured of.
    expect(warnings[0]).not.toMatch(/laud setup/);
    expect(warnings[0]).not.toMatch(/--fix/);
  });

  it('warns when the diarizer succeeds but yields no turns, pointing at --speakers', async () => {
    // The "emits nothing parseable" case of design section 5.7: exit 0, no
    // parseable turns, every speaker null.
    const warnings: string[] = [];
    const d = deps();
    const diarizer = new FakeDiarizer([]);
    const transcript = await transcribeRecording(
      { ...d, diarizer, onWarning: (message) => warnings.push(message) },
      recording,
      { diarize: true },
    );
    const segments = await d.store.listSegments(transcript.id);
    expect(segments.map((s) => s.text)).toEqual(['Privet.', 'Kak dela?']);
    expect(segments.every((s) => s.speaker === null)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no speaker turns/);
    expect(warnings[0]).toMatch(/--speakers/);
  });

  it('does not warn when turns were found', async () => {
    const warnings: string[] = [];
    const diarizer = new FakeDiarizer([{ startMs: 0, endMs: 3200, speaker: 'speaker_00' }]);
    await transcribeRecording(
      { ...deps(), diarizer, onWarning: (message) => warnings.push(message) },
      recording,
      { diarize: true },
    );
    expect(warnings).toEqual([]);
  });

  it('attributes each segment to a speaker by time overlap', async () => {
    const d = deps();
    const diarizer = new FakeDiarizer([
      { startMs: 0, endMs: 1500, speaker: 'speaker_00' },
      { startMs: 1500, endMs: 3200, speaker: 'speaker_01' },
    ]);
    const transcript = await transcribeRecording({ ...d, diarizer }, recording, { diarize: true });
    const segments = await d.store.listSegments(transcript.id);
    expect(segments.map((s) => s.speaker)).toEqual(['speaker_00', 'speaker_01']);
  });

  it('runs the diarizer on the same full-recording wav the provider transcribed', async () => {
    const d = deps();
    const diarizer = new FakeDiarizer([{ startMs: 0, endMs: 3200, speaker: 'speaker_00' }]);
    await transcribeRecording({ ...d, diarizer }, recording, { diarize: true });
    expect(diarizer.calls).toEqual([{ audioPath: '/tmp/fake-1.wav' }]);
  });

  it('forwards --speakers to the diarizer as a hint', async () => {
    const d = deps();
    const diarizer = new FakeDiarizer([{ startMs: 0, endMs: 3200, speaker: 'speaker_00' }]);
    await transcribeRecording({ ...d, diarizer }, recording, { diarize: true, speakers: 3 });
    expect(diarizer.calls).toEqual([{ audioPath: '/tmp/fake-1.wav', speakers: 3 }]);
  });

  it('still writes the transcript when the diarizer throws', async () => {
    const d = deps();
    const diarizer: Diarizer = {
      turns: async () => {
        throw new Error('boom');
      },
    };
    const transcript = await transcribeRecording({ ...d, diarizer }, recording, {
      diarize: true,
    });
    expect(transcript).not.toBeNull();
    // The words survive; only the attribution is missing.
    const segments = await d.store.listSegments(transcript.id);
    expect(segments.map((s) => s.text)).toEqual(['Privet.', 'Kak dela?']);
    expect(segments.every((s) => s.speaker === null)).toBe(true);
  });

  it('warns, but does not throw, when the diarizer fails', async () => {
    const d = deps();
    const warnings: string[] = [];
    const diarizer: Diarizer = {
      turns: async () => {
        throw new Error('boom');
      },
    };
    await transcribeRecording(
      { ...d, diarizer, onWarning: (message) => warnings.push(message) },
      recording,
      { diarize: true },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/boom/);
  });

  it('deletes the temporary wav even when the diarizer fails', async () => {
    const d = deps();
    const diarizer: Diarizer = {
      turns: async () => {
        throw new Error('boom');
      },
    };
    await transcribeRecording({ ...d, diarizer }, recording, { diarize: true });
    expect(d.fs.files.has('/tmp/fake-1.wav')).toBe(false);
  });
});

interface MultilingualScenario {
  readonly spans?: readonly SpeechSpan[];
  readonly languages?: readonly string[];
  readonly texts?: ReadonlyArray<readonly RawSegment[]>;
  readonly supportsLanguageDetection?: boolean;
}

/** Deps for the multilingual path: a segmenter, a queue of detected languages, and one transcribe result per run. */
function multilingualDeps(scenario: MultilingualScenario) {
  const spans = scenario.spans ?? [{ startMs: 0, endMs: 1750 }];
  const languages = scenario.languages ?? ['en'];
  const texts =
    scenario.texts ??
    spans.map((span, i) => [{ startMs: 0, endMs: span.endMs - span.startMs, text: `run ${i}` }]);
  const results = texts.map((segments, i) => ({
    language: languages[i] ?? 'en',
    model: 'base.bin',
    segments: [...segments],
  }));
  const fs = new MemFs({ '/data/media/sh/sha-AUDIO.mp3': 'AUDIO' });
  return {
    fs,
    store: new InMemoryStore(),
    audio: new FakeAudioTool(60_000, fs),
    stt: new FakeStt(
      results,
      { supportsLanguageDetection: scenario.supportsLanguageDetection ?? true },
      languages,
    ),
    segmenter: new FakeSegmenter(spans),
    clock: new FakeClock(),
    ids: new FakeIds(),
    mediaRoot: '/data/media',
  };
}

describe('transcribeRecording --multilingual', () => {
  it('transcribes each language run with its own language', async () => {
    const d = multilingualDeps({
      spans: [
        { startMs: 0, endMs: 1750 },
        { startMs: 1800, endMs: 3430 },
      ],
      languages: ['en', 'ru'],
      texts: [
        [{ startMs: 0, endMs: 1750, text: 'I will call you tomorrow morning.' }],
        [{ startMs: 0, endMs: 1630, text: 'Pozvoni mne segodnya vecherom.' }],
      ],
    });
    const transcript = await transcribeRecording(d, recording, { multilingual: true });
    const segments = await d.store.listSegments(transcript.id);
    expect(segments.map((s) => s.language)).toEqual(['en', 'ru']);
    expect(segments.map((s) => s.text)).toEqual([
      'I will call you tomorrow morning.',
      'Pozvoni mne segodnya vecherom.',
    ]);
  });

  it('shifts each run timestamps back into absolute positions', async () => {
    // The second run's whisper output starts at zero because whisper only
    // saw that slice. Storing it unshifted would stack both runs on top of
    // each other at the start of the recording.
    const d = multilingualDeps({
      spans: [
        { startMs: 0, endMs: 1750 },
        { startMs: 1800, endMs: 3430 },
      ],
      languages: ['en', 'ru'],
      texts: [
        [{ startMs: 0, endMs: 1750, text: 'first' }],
        [{ startMs: 0, endMs: 1630, text: 'second' }],
      ],
    });
    const transcript = await transcribeRecording(d, recording, { multilingual: true });
    const segments = await d.store.listSegments(transcript.id);
    expect(segments[1]!.startMs).toBeGreaterThanOrEqual(1750);
  });

  it("slices the audio at each detection window's and each run's own absolute bounds", async () => {
    // FakeAudioTool.sliced records every slice() call; this is the one place
    // the offset contract (a run's bounds are absolute, and can differ from
    // the detection windows that fed into it once mergeRuns has split at a
    // language boundary) meets the audio tool that actually has to cut
    // there. The first two entries are the per-window slices language
    // detection ran on; the last two are the per-run slices transcription
    // ran on, at the merged boundary (1775, the midpoint of the 1750-1800
    // gap) rather than either window's own edge.
    const d = multilingualDeps({
      spans: [
        { startMs: 0, endMs: 1750 },
        { startMs: 1800, endMs: 3430 },
      ],
      languages: ['en', 'ru'],
    });
    await transcribeRecording(d, recording, { multilingual: true });
    expect(d.audio.sliced.map((call) => [call.startMs, call.endMs])).toEqual([
      [0, 1750],
      [1800, 3430],
      [0, 1775],
      [1775, 3430],
    ]);
  });

  it('refuses a provider that cannot detect a language', async () => {
    const d = multilingualDeps({ supportsLanguageDetection: false });
    await expect(transcribeRecording(d, recording, { multilingual: true })).rejects.toThrow(
      /detect/i,
    );
  });

  it('refuses when no segmenter was wired', async () => {
    const d = { ...multilingualDeps({}), segmenter: undefined };
    await expect(transcribeRecording(d, recording, { multilingual: true })).rejects.toThrow(
      /segmenter|multilingual/i,
    );
  });

  it('leaves the single-pass path untouched without the flag', async () => {
    const d = multilingualDeps({});
    await transcribeRecording(d, recording, {});
    expect(d.segmenter.calls).toHaveLength(0);
  });

  it('removes every temporary slice it created', async () => {
    const d = multilingualDeps({
      spans: [
        { startMs: 0, endMs: 1750 },
        { startMs: 1800, endMs: 3430 },
      ],
      languages: ['en', 'ru'],
    });
    const filesBefore = d.fs.files.size;
    await transcribeRecording(d, recording, { multilingual: true });
    // The fake allocates slices through fs.tempFile, which does not name
    // them "run-*"; asserting on names would pass even if cleanup were
    // broken. The file count is the real assertion: nothing is left behind.
    expect(d.fs.files.size).toBeLessThanOrEqual(filesBefore);
  });

  it('splits a single span the segmenter could not cut into a language switch', async () => {
    // Regression test for the bilingual fixture itself: it is 3.46s long,
    // its two clauses are spoken back to back with no measurable pause, and
    // the segmenter returns it as one span covering the whole recording.
    // Detecting it as a whole would report only its first language and
    // silently drop the second -- the exact bug this feature exists to fix.
    // At the 2-second default window, this 3.46s span subdivides into two
    // ~1.73s windows, which is exactly what mergeRuns needs to cut on.
    const d = multilingualDeps({
      spans: [{ startMs: 0, endMs: 3460 }],
      languages: ['en', 'ru'],
      texts: [
        [{ startMs: 0, endMs: 1730, text: 'I will call you tomorrow morning.' }],
        [{ startMs: 0, endMs: 1730, text: 'Pozvoni mne segodnya vecherom.' }],
      ],
    });
    const transcript = await transcribeRecording(d, recording, { multilingual: true });
    const segments = await d.store.listSegments(transcript.id);
    expect(segments.map((s) => s.language)).toEqual(['en', 'ru']);
    expect(segments.map((s) => s.text)).toEqual([
      'I will call you tomorrow morning.',
      'Pozvoni mne segodnya vecherom.',
    ]);
    // The whole-recording span was actually subdivided before detection.
    expect(d.stt.detectLanguageCalls).toHaveLength(2);
  });

  it('sets the transcript language to the longest run by duration', async () => {
    const d = multilingualDeps({
      spans: [
        { startMs: 0, endMs: 1750 },
        { startMs: 1800, endMs: 3700 },
      ],
      languages: ['en', 'ru'],
    });
    const transcript = await transcribeRecording(d, recording, { multilingual: true });
    expect(transcript.language).toBe('ru');
  });

  it('refuses when the segmenter finds no speech', async () => {
    const d = multilingualDeps({ spans: [], languages: [] });
    await expect(transcribeRecording(d, recording, { multilingual: true })).rejects.toThrow(
      /no speech/,
    );
  });

  it('forwards a model override to language detection as well as transcription', async () => {
    // detectLanguage and transcribe are separate provider calls; forwarding
    // options.model to transcribe alone would leave every detection pass
    // running on the configured default while transcription used the
    // override.
    const d = multilingualDeps({
      spans: [{ startMs: 0, endMs: 1750 }],
      languages: ['en'],
    });
    await transcribeRecording(d, recording, { multilingual: true, model: '/models/large.bin' });
    expect(d.stt.detectLanguageOpts).toEqual([{ model: '/models/large.bin' }]);
    expect(d.stt.calls[0]).toEqual(expect.objectContaining({ model: '/models/large.bin' }));
  });

  it('refuses when every run transcribes to no segments', async () => {
    const d = multilingualDeps({
      spans: [{ startMs: 0, endMs: 1750 }],
      languages: ['en'],
      texts: [[]],
    });
    await expect(transcribeRecording(d, recording, { multilingual: true })).rejects.toThrow(
      /no speech/,
    );
  });

  it('diarizes once over the whole recording, not once per language run', async () => {
    const d = multilingualDeps({
      spans: [
        { startMs: 0, endMs: 1750 },
        { startMs: 1800, endMs: 3430 },
      ],
      languages: ['en', 'ru'],
      texts: [
        [{ startMs: 0, endMs: 1750, text: 'first' }],
        [{ startMs: 0, endMs: 1630, text: 'second' }],
      ],
    });
    const diarizer = new FakeDiarizer([
      { startMs: 0, endMs: 1775, speaker: 'speaker_00' },
      { startMs: 1775, endMs: 3430, speaker: 'speaker_01' },
    ]);
    const transcript = await transcribeRecording({ ...d, diarizer }, recording, {
      multilingual: true,
      diarize: true,
    });
    // One call, on the full-recording wav -- never one per merged run.
    expect(diarizer.calls).toEqual([{ audioPath: '/tmp/fake-1.wav' }]);
    const segments = await d.store.listSegments(transcript.id);
    expect(segments.map((s) => s.speaker)).toEqual(['speaker_00', 'speaker_01']);
  });
});
