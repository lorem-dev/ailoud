/**
 * Colours for speaker names, picked so the same person is the same colour
 * every time and every colour is legible on a light terminal and a dark one.
 *
 * These are 256-colour cube indices, `16 + 36r + 6g + b` with each component
 * 0-5. They were chosen by relative luminance -- 0.2126R + 0.7152G + 0.0722B
 * -- kept inside roughly 0.25 to 0.55 of maximum. Anything brighter washes
 * out on white; anything darker sinks into black. That band is why this is a
 * hand-picked list rather than "hash straight into 256 colours", which would
 * eventually hand someone a name they cannot read on their own terminal.
 *
 * The basic sixteen colours were not used: they are theme-defined, so
 * "yellow" is a different, sometimes invisible, colour depending on the
 * user's palette, which is exactly the guarantee this is trying to make.
 */
const PALETTE: readonly number[] = [
  167, // (4,1,1) red, luminance about 0.33
  71, //  (1,3,1) green, about 0.49
  68, //  (1,2,4) blue, about 0.39
  172, // (4,2,0) orange, about 0.31
  134, // (3,1,4) purple, about 0.26
  37, //  (0,3,3) teal, about 0.47
  131, // (3,1,1) brick, about 0.27
  108, // (2,3,2) sage, about 0.50
  209, // (5,2,1) salmon, about 0.51
  74, //  (1,3,4) sky, about 0.53
  105, // (2,2,5) periwinkle, about 0.44
  205, // (5,1,3) pink, about 0.40
  139, // (3,2,3) mauve, about 0.46
  176, // (4,2,4) orchid, about 0.51
  39, //  (0,3,5) cyan, about 0.50
  111, // (2,3,5) steel, about 0.59
];

/**
 * FNV-1a, for a stable colour per name.
 *
 * Any cheap hash would do; what matters is that it depends only on the name,
 * so the same speaker keeps their colour across runs, across recordings, and
 * between one person's terminal and another's. Sorting or numbering would
 * not: inserting a speaker would recolour everyone below them.
 */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** The colour a name prefers, before any collision is resolved. */
export function speakerColorCode(name: string): number {
  return PALETTE[hash(name) % PALETTE.length] ?? PALETTE[0]!;
}

/**
 * Colours for every speaker of one recording, guaranteed distinct.
 *
 * Hashing alone is not enough, and the first version shipped without this
 * shows why: with a palette of any size, two names collide often enough to
 * see. "Andrew" and "speaker_01" landed on the same purple in a
 * two-speaker transcript, which defeats the entire purpose -- the colour is
 * there to tell them apart.
 *
 * So the hash chooses a PREFERRED slot and a taken one probes forward. A
 * speaker keeps their colour whenever nothing contends for it, which is the
 * common case, and two speakers of one recording never share.
 *
 * The cost, stated rather than hidden: a speaker's colour can move if another
 * speaker is added to the same recording and reaches their slot first.
 * Distinctness within one transcript is worth more than stability across
 * edits to it -- the eye is comparing names on one screen, not across
 * sessions.
 *
 * Names are sorted before assigning, so the result depends on the SET of
 * speakers and not on which of them happened to speak first.
 */
export function assignSpeakerColors(names: readonly string[]): ReadonlyMap<string, number> {
  const assigned = new Map<string, number>();
  const taken = new Set<number>();
  for (const name of [...new Set(names)].sort()) {
    const preferred = PALETTE.indexOf(speakerColorCode(name));
    let code = speakerColorCode(name);
    for (let step = 0; step < PALETTE.length; step += 1) {
      const candidate = PALETTE[(preferred + step) % PALETTE.length]!;
      if (!taken.has(candidate)) {
        code = candidate;
        break;
      }
    }
    // More speakers than colours: reuse rather than refuse. Sixteen
    // simultaneous speakers is not a transcript anyone is reading by colour.
    taken.add(code);
    assigned.set(name, code);
  }
  return assigned;
}

/**
 * A decorator for `toPlainText`, painting each speaker their assigned colour.
 *
 * Returns a plain identity function when given no names, so a caller that is
 * not writing to a terminal can use the same code path.
 */
export function speakerPainter(
  names: readonly string[],
  enabled: boolean,
): (name: string) => string {
  if (!enabled) return (name) => name;
  const colors = assignSpeakerColors(names);
  return (name) => {
    const code = colors.get(name);
    return code === undefined ? name : `\u001b[38;5;${code}m${name}\u001b[39m`;
  };
}
