import { describe, expect, it } from 'vitest';
import { assignSpeakerColors, speakerColorCode, speakerPainter } from './speakerColor.js';

/** The 6x6x6 cube index back to its components. */
function components(code: number): { r: number; g: number; b: number } {
  const offset = code - 16;
  return { r: Math.floor(offset / 36), g: Math.floor((offset % 36) / 6), b: offset % 6 };
}

function luminance(code: number): number {
  const { r, g, b } = components(code);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 5;
}

describe('speakerColorCode', () => {
  it('gives the same name the same preferred colour every time', () => {
    expect(speakerColorCode('Ann')).toBe(speakerColorCode('Ann'));
  });

  it('stays inside the 256-colour cube', () => {
    for (const name of ['Ann', 'Bob', 'speaker_00', '', 'a very long speaker name indeed']) {
      const code = speakerColorCode(name);
      expect(code).toBeGreaterThanOrEqual(16);
      expect(code).toBeLessThanOrEqual(231);
    }
  });

  it('only ever picks colours legible on both a light and a dark terminal', () => {
    // The constraint that made this a hand-picked palette rather than a hash
    // into all 256 colours: too bright washes out on white, too dark sinks
    // into black. Every reachable colour has to sit in the middle.
    const reachable = new Set(
      Array.from({ length: 300 }, (_, i) => speakerColorCode(`speaker_${i}`)),
    );
    for (const code of reachable) {
      expect(luminance(code)).toBeGreaterThan(0.2);
      expect(luminance(code)).toBeLessThan(0.6);
    }
  });
});

describe('assignSpeakerColors', () => {
  it('never gives two speakers of one recording the same colour', () => {
    // The regression this exists for. Hashing alone put "Andrew" and
    // "speaker_01" on the same purple in a real two-speaker transcript, which
    // defeats the entire point of colouring them.
    const colors = assignSpeakerColors(['Andrew', 'speaker_01']);
    expect(colors.get('Andrew')).not.toBe(colors.get('speaker_01'));
  });

  it('keeps every colour distinct across a crowd', () => {
    const names = Array.from({ length: 12 }, (_, i) => `speaker_${i}`);
    const colors = assignSpeakerColors(names);
    expect(new Set(colors.values()).size).toBe(names.length);
  });

  it('leaves a speaker on their preferred colour when nothing contends', () => {
    expect(assignSpeakerColors(['Ann']).get('Ann')).toBe(speakerColorCode('Ann'));
  });

  it('does not depend on the order the speakers arrive in', () => {
    // Sorted before assigning, so the result depends on WHO is in the
    // recording and not on who happened to speak first.
    const a = assignSpeakerColors(['Andrew', 'speaker_01', 'Bob']);
    const b = assignSpeakerColors(['Bob', 'speaker_01', 'Andrew']);
    expect([...a].sort()).toEqual([...b].sort());
  });

  it('ignores a repeated name rather than assigning it twice', () => {
    const colors = assignSpeakerColors(['Ann', 'Ann']);
    expect(colors.size).toBe(1);
  });

  it('reuses colours rather than failing when there are more speakers than colours', () => {
    // Sixteen simultaneous speakers is not a transcript anyone reads by
    // colour; refusing to render it would be worse than repeating a hue.
    const names = Array.from({ length: 40 }, (_, i) => `speaker_${i}`);
    expect(() => assignSpeakerColors(names)).not.toThrow();
    expect(assignSpeakerColors(names).size).toBe(40);
  });
});

/**
 * Drops every SGR sequence. Spelled from \u001b, not a literal byte, so this
 * file stays ASCII. The lint rule guards against a control character landing
 * in a pattern by accident; here one is the whole point.
 */
function stripColor(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(new RegExp('\u001b\\[[0-9;]*m', 'g'), '');
}

describe('speakerPainter', () => {
  it('paints only the name, and resets the foreground only afterwards', () => {
    const paint = speakerPainter(['Ann'], true);
    // 39 rather than 0: a blanket reset would cancel styling the surrounding
    // UI had set.
    // Built from a string rather than written literally: source files here
    // stay ASCII, so the escape byte is spelled \u001b.
    expect(paint('Ann')).toMatch(new RegExp(`^\u001b\\[38;5;\\d+mAnn\u001b\\[39m$`));
  });

  it('leaves the name itself untouched', () => {
    const paint = speakerPainter(['Ann Smith'], true);
    expect(stripColor(paint('Ann Smith'))).toBe('Ann Smith');
  });

  it('does nothing at all when disabled', () => {
    // What keeps escape sequences out of a redirected transcript.
    const paint = speakerPainter(['Ann'], false);
    expect(paint('Ann')).toBe('Ann');
  });

  it('passes an unknown name through unpainted rather than guessing', () => {
    const paint = speakerPainter(['Ann'], true);
    expect(paint('Someone else')).toBe('Someone else');
  });
});
