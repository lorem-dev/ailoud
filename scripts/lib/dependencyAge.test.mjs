import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  DEFAULT_DAYS,
  classify,
  collectDependencies,
  staleExceptions,
} from './dependencyAge.mjs';

const NOW = Date.parse('2026-09-05T00:00:00Z');
const at = (daysAgo) => NOW - daysAgo * DAY_MS;

describe('the window', () => {
  it('is fourteen days, stated once', () => {
    expect(DEFAULT_DAYS).toBe(14);
  });
});

describe('collectDependencies', () => {
  const manifests = {
    'package.json': { devDependencies: { prettier: '3.9.6' } },
    'packages/core/package.json': { dependencies: {} },
    'packages/providers/package.json': {
      dependencies: { '@ailoud/core': 'workspace:*', yaml: '2.9.0' },
    },
    'apps/cli/package.json': {
      dependencies: { commander: '15.0.0' },
      optionalDependencies: { fsevents: '2.3.3' },
    },
  };
  const read = (path) => JSON.stringify(manifests[path]);

  it('collects direct dependencies of every kind across the manifests', () => {
    const found = collectDependencies(read);
    expect([...found]).toEqual([
      ['prettier', '3.9.6'],
      ['yaml', '2.9.0'],
      ['commander', '15.0.0'],
      ['fsevents', '2.3.3'],
    ]);
  });

  it('skips workspace siblings, which are not registry versions', () => {
    expect(collectDependencies(read).has('@ailoud/core')).toBe(false);
  });
});

describe('classify', () => {
  it('flags a version published inside the window', () => {
    const { young } = classify([['left-pad', '1.0.0', at(3)]], NOW, 14);
    expect(young).toHaveLength(1);
    expect(young[0].ageDays).toBeCloseTo(3);
  });

  it('accepts one published outside it, and one exactly at the boundary', () => {
    // The rule is "at least this old", so 14 days old passes at 14 days.
    expect(classify([['a', '1.0.0', at(15)]], NOW, 14).young).toEqual([]);
    expect(classify([['a', '1.0.0', at(14)]], NOW, 14).young).toEqual([]);
  });

  it('exempts a version named in the exceptions, and keeps its reason', () => {
    // The rule yields to a critical advisory: two weeks with a known exploit
    // is worse than a version nobody has audited yet.
    const { young, exempt } = classify([['left-pad', '2.0.0', at(1)]], NOW, 14, {
      'left-pad@2.0.0': 'fixes GHSA-xxxx-yyyy-zzzz (critical)',
    });
    expect(young).toEqual([]);
    expect(exempt[0].reason).toContain('GHSA-xxxx-yyyy-zzzz');
  });

  it('does not let an exception cover a different version of the same package', () => {
    const { young } = classify([['left-pad', '2.0.1', at(1)]], NOW, 14, {
      'left-pad@2.0.0': 'fixes something else',
    });
    expect(young).toHaveLength(1);
  });

  it('reports an unknown publish time instead of assuming it is old', () => {
    const { young, unknown } = classify([['left-pad', '1.0.0', null]], NOW, 14);
    expect(young).toEqual([]);
    expect(unknown).toEqual([{ name: 'left-pad', spec: '1.0.0' }]);
  });
});

describe('staleExceptions', () => {
  it('names an exception whose version has since aged past the rule', () => {
    const entries = [['left-pad', '2.0.0', at(30)]];
    expect(staleExceptions({ 'left-pad@2.0.0': 'was urgent' }, entries, NOW, 14)).toEqual([
      'left-pad@2.0.0',
    ]);
  });

  it('names an exception for something no longer depended on', () => {
    expect(staleExceptions({ 'gone@1.0.0': 'was urgent' }, [], NOW, 14)).toEqual(['gone@1.0.0']);
  });

  it('leaves an exception that is still doing work', () => {
    const entries = [['left-pad', '2.0.0', at(2)]];
    expect(staleExceptions({ 'left-pad@2.0.0': 'urgent' }, entries, NOW, 14)).toEqual([]);
  });
});
