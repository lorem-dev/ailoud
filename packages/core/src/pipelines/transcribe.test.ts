import { describe, expect, it } from 'vitest';
import type { RawSegment, Recording } from '../domain/model.js';
import type { TranscriptionProvider } from '../domain/ports.js';
import {
  FakeAudioTool,
  FakeClock,
  FakeIds,
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
