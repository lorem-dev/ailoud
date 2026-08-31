import { describe, expect, it } from 'vitest';
import type { Recording } from './model.js';
import { normalizeRecordedAt, recordedOrImportedAt } from './recordedAt.js';

const recording = (recordedAt: string | null): Recording => ({
  id: 'R1',
  sha256: 'abc',
  sourcePath: '/in/a.mp3',
  mediaPath: 'ab/abc.mp3',
  durationMs: 1000,
  mime: 'audio/mpeg',
  title: null,
  notes: null,
  recordedAt,
  importedAt: '2026-01-01T00:00:00.000Z',
});

describe('recordedOrImportedAt', () => {
  it('prefers what the file says about itself', () => {
    expect(recordedOrImportedAt(recording('2024-03-15T10:23:45.000Z'))).toBe(
      '2024-03-15T10:23:45.000Z',
    );
  });

  it('falls back to the import date when the file said nothing', () => {
    expect(recordedOrImportedAt(recording(null))).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('normalizeRecordedAt', () => {
  it('accepts what an mp4 actually carries, to the microsecond', () => {
    expect(normalizeRecordedAt('2024-03-15T10:23:45.000000Z')).toBe('2024-03-15T10:23:45.000Z');
  });

  it('treats a missing tag as no date', () => {
    expect(normalizeRecordedAt(undefined)).toBeNull();
    expect(normalizeRecordedAt(null)).toBeNull();
    expect(normalizeRecordedAt('')).toBeNull();
    expect(normalizeRecordedAt('   ')).toBeNull();
  });

  it('refuses a placeholder rather than storing 1970', () => {
    // The reason this function exists. A tool with nothing to write sometimes
    // writes one of these anyway, and storing it would be silently wrong --
    // every such recording would sort to the beginning of time. Null is
    // honest: it falls back to the import date, which is at least true.
    expect(normalizeRecordedAt('1970-01-01T00:00:00Z')).toBeNull();
    expect(normalizeRecordedAt('1969-12-31T23:59:59Z')).toBeNull();
  });

  it('refuses something that is not a date at all', () => {
    expect(normalizeRecordedAt('0000-00-00T00:00:00Z')).toBeNull();
    expect(normalizeRecordedAt('not a date')).toBeNull();
  });

  it('normalises a valid date to a single ISO shape', () => {
    // Containers disagree on format; storage should not have to.
    expect(normalizeRecordedAt('2024-03-15 10:23:45Z')).toBe('2024-03-15T10:23:45.000Z');
  });
});
