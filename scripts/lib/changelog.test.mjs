import { describe, expect, it } from 'vitest';
import {
  HARD_LIMIT,
  SOFT_LIMIT,
  baseVersion,
  countBullets,
  escapeForRegExp,
  fingerprint,
  groupBullets,
  isPrerelease,
  planRetirement,
  splitSections,
  versionFromTag,
  versionHeading,
} from './changelog.mjs';

describe('the limits', () => {
  it('are stated once, and the soft one is below the hard one', () => {
    // Copied limits drift, and a limit that differs between the script that
    // warns and the script that refuses is worse than no limit at all.
    expect(SOFT_LIMIT).toBe(10);
    expect(HARD_LIMIT).toBe(50);
    expect(SOFT_LIMIT).toBeLessThan(HARD_LIMIT);
  });
});

describe('versionFromTag', () => {
  it('strips one leading v and nothing else', () => {
    expect(versionFromTag('v1.2.3')).toBe('1.2.3');
    expect(versionFromTag('1.2.3')).toBe('1.2.3');
    expect(versionFromTag('v1.2.3-dev.1')).toBe('1.2.3-dev.1');
    // Not a recursive strip: a version does not start with v twice.
    expect(versionFromTag('vv1.2.3')).toBe('v1.2.3');
  });
});

describe('baseVersion and isPrerelease', () => {
  it('splits a pre-release from its release', () => {
    expect(baseVersion('1.0.0-dev.2')).toBe('1.0.0');
    expect(baseVersion('1.0.0')).toBe('1.0.0');
    expect(isPrerelease('1.0.0-dev.2')).toBe(true);
    expect(isPrerelease('1.0.0-rc.1')).toBe(true);
    expect(isPrerelease('1.0.0')).toBe(false);
  });
});

describe('escapeForRegExp and versionHeading', () => {
  it('does not let a dot in a version match any character', () => {
    // Unescaped, `1.0.0` matches `1x0y0` -- and a heading for another version.
    expect(escapeForRegExp('1.0.0')).toBe('1\\.0\\.0');
    expect(versionHeading('1.0.0').test('## Version 1.0.0')).toBe(true);
    expect(versionHeading('1.0.0').test('## Version 1x0y0')).toBe(false);
  });

  it('matches a heading with a trailing date but not a longer version', () => {
    expect(versionHeading('1.0.0').test('## Version 1.0.0 -- 2026-09-05')).toBe(true);
    expect(versionHeading('1.0.0').test('## Version 1.0.0-dev.1')).toBe(false);
    expect(versionHeading('1.0.0').test('## Version 1.0.10')).toBe(false);
  });
});

describe('splitSections', () => {
  const text = [
    '# Title',
    '',
    'preamble',
    '',
    '## Development',
    '',
    '- one',
    '',
    '## Version 1.0.0',
    '',
    '- two',
  ].join('\n');

  it('keeps whatever precedes the first section', () => {
    expect(splitSections(text).head).toContain('preamble');
  });

  it('returns each section with its heading and body', () => {
    const { sections } = splitSections(text);
    expect(sections.map((s) => s.heading)).toEqual(['## Development', '## Version 1.0.0']);
    expect(sections[0].body).toContain('- one');
    expect(sections[1].body).toContain('- two');
  });

  it('handles a file with no sections at all', () => {
    const { head, sections } = splitSections('# Just a title\n');
    expect(sections).toEqual([]);
    expect(head).toContain('Just a title');
  });

  it('does not treat a ### subsection as a section', () => {
    const { sections } = splitSections('## Version 1.0.0\n\n### Added\n\n- x\n');
    expect(sections).toHaveLength(1);
    expect(sections[0].body).toContain('### Added');
  });
});

describe('groupBullets', () => {
  it('groups by subsection, in first-seen order', () => {
    const groups = groupBullets('### Added\n\n- a\n\n### Fixed\n\n- b\n');
    expect([...groups.keys()]).toEqual(['Added', 'Fixed']);
    expect(groups.get('Added')).toEqual([['- a']]);
  });

  it('keeps a wrapped entry whole', () => {
    // Every 80-column entry wraps; dropping the continuation would lose
    // everything after the first line.
    const groups = groupBullets('### Added\n\n- first line\n  second line\n');
    expect(groups.get('Added')).toEqual([['- first line', '  second line']]);
  });

  it('defaults to Added when a body has no subsection heading', () => {
    expect([...groupBullets('- loose entry\n').keys()]).toEqual(['Added']);
  });

  it('ignores a blank line between entries', () => {
    expect(groupBullets('- a\n\n- b\n').get('Added')).toEqual([['- a'], ['- b']]);
  });

  it('records a subsection that has no entries', () => {
    const groups = groupBullets('### Added\n\n### Fixed\n\n- b\n');
    expect(groups.get('Added')).toEqual([]);
  });
});

describe('fingerprint', () => {
  it('sees the same entry rewrapped as the same entry', () => {
    // The reason a duplicate across two dev tags is caught even after one of
    // them was reflowed.
    expect(fingerprint(['- a duplicated entry that', '  wraps across two lines.'])).toBe(
      fingerprint(['- a duplicated entry that wraps across two lines.']),
    );
  });

  it('is case-insensitive', () => {
    expect(fingerprint(['- Same Thing'])).toBe(fingerprint(['- same thing']));
  });

  it('keeps genuinely different entries apart', () => {
    expect(fingerprint(['- one'])).not.toBe(fingerprint(['- two']));
  });
});

describe('countBullets', () => {
  it('counts entries, not their continuation lines', () => {
    expect(countBullets('- a\n  continued\n- b\n')).toBe(2);
  });

  it('counts an indented entry', () => {
    expect(countBullets('  - nested\n')).toBe(1);
  });

  it('counts nothing in prose', () => {
    expect(countBullets('### Added\n\nsome prose\n')).toBe(0);
  });
});

describe('planRetirement', () => {
  const tags = [
    'v1.0.0-dev.2',
    'v1.0.0-dev.1',
    'v1.0.0-rc.1',
    'v1.1.0-dev.1',
    'v1.0.0',
    'v10.0.0-dev.1',
  ];

  it('takes the pre-releases of one version and no others', () => {
    // v1.1.0-dev.1 belongs to a version that has not been released, and
    // v10.0.0-dev.1 shares a prefix with "v1" only as text.
    const { versions } = planRetirement('1.0.0', tags, () => true);
    expect(versions).toEqual(['1.0.0-dev.1', '1.0.0-dev.2', '1.0.0-rc.1']);
  });

  it('leaves the final release itself alone', () => {
    const { versions } = planRetirement('1.0.0', tags, () => true);
    expect(versions).not.toContain('1.0.0');
  });

  it('splits the tags by whether their commit is on main', () => {
    // A tag whose commit is not reachable from main cannot be deleted: the
    // commit could then be collected, and the published provenance attests it.
    const onMain = (tag) => tag !== 'v1.0.0-dev.2';
    const { deletable, kept } = planRetirement('1.0.0', tags, onMain);
    expect(deletable).toEqual(['v1.0.0-dev.1', 'v1.0.0-rc.1']);
    expect(kept).toEqual(['v1.0.0-dev.2']);
  });

  it('plans nothing for a version that never had a pre-release', () => {
    const plan = planRetirement('2.0.0', tags, () => true);
    expect(plan).toEqual({ versions: [], deletable: [], kept: [] });
  });
});
