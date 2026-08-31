import { describe, expect, it } from 'vitest';
import { toPlainText } from './text.js';

describe('toPlainText speaker alignment', () => {
  const seg = (startMs: number, speaker: string | null, text: string) => ({
    id: `s${startMs}`,
    transcriptId: 't',
    idx: startMs,
    startMs,
    endMs: startMs + 1000,
    text,
    speaker,
    language: null,
  });

  it('pads short names so every line of text starts in the same column', () => {
    const out = toPlainText(
      [seg(0, 'a', 'one'), seg(1000, 'b', 'two')],
      new Map([
        ['a', 'Andrew'],
        ['b', 'Donat'],
      ]),
    );
    const columns = out
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (line.indexOf('one') === -1 ? line.indexOf('two') : line.indexOf('one')));
    expect(columns[0]).toBe(columns[1]);
  });

  it('pads by the plain name, so a decorated name is not under-indented', () => {
    // The trap: padding after decorating would count the escape sequence's
    // invisible bytes and indent coloured lines short by exactly that width.
    const decorate = (name: string) => `<<${name}>>`;
    const plain = toPlainText(
      [seg(0, 'a', 'one'), seg(1000, 'b', 'two')],
      new Map([
        ['a', 'Andrew'],
        ['b', 'Donat'],
      ]),
    );
    const decorated = toPlainText(
      [seg(0, 'a', 'one'), seg(1000, 'b', 'two')],
      new Map([
        ['a', 'Andrew'],
        ['b', 'Donat'],
      ]),
      decorate,
    );
    // Strip the decoration back out; the result must match the plain layout.
    expect(decorated.replaceAll('<<', '').replaceAll('>>', '')).toBe(plain);
  });

  it('adds no padding at all when nothing has a speaker', () => {
    // Non-diarized transcripts must render exactly as they did before any of
    // this existed.
    expect(toPlainText([seg(0, null, 'hello')])).toBe('[00:00:00] hello\n');
  });
});
