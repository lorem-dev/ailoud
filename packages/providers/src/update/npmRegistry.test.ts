import { describe, expect, it, vi } from 'vitest';
import { NpmRegistry } from './npmRegistry.js';
import type { RegistryTransport } from './npmRegistry.js';

/** A transport that answers with a fixed status and body, recording its calls. */
const answering = (status: number, body: string) =>
  vi.fn<RegistryTransport>(async () => ({ status, body }));

const packument = {
  name: 'ailoud',
  versions: {
    '1.0.0-dev.1': { name: 'ailoud', version: '1.0.0-dev.1', deprecated: 'superseded by 1.0.0' },
    '1.0.0': { name: 'ailoud', version: '1.0.0' },
  },
};

describe('NpmRegistry', () => {
  it('reports every version, marking the deprecated ones', async () => {
    const transport = answering(200, JSON.stringify(packument));
    const registry = new NpmRegistry({ transport });
    expect(await registry.published('ailoud')).toEqual([
      { version: '1.0.0-dev.1', deprecated: true },
      { version: '1.0.0', deprecated: false },
    ]);
  });

  it('asks for the abbreviated packument', async () => {
    const transport = answering(200, JSON.stringify(packument));
    await new NpmRegistry({ transport }).published('ailoud');
    const [, headers] = transport.mock.calls[0]!;
    expect(headers).toMatchObject({ accept: 'application/vnd.npm.install-v1+json' });
  });

  it('escapes a scoped name', async () => {
    const transport = answering(200, JSON.stringify(packument));
    await new NpmRegistry({ transport }).published('@ailoud/core');
    expect(transport.mock.calls[0]![0]).toBe('https://registry.npmjs.org/@ailoud%2fcore');
  });

  it('throws with the status when the registry refuses', async () => {
    const transport = answering(503, 'nope');
    await expect(new NpmRegistry({ transport }).published('ailoud')).rejects.toThrow(/503/);
  });

  it('throws when the versions object is present but empty', async () => {
    // A 200 with `{"versions": {}}` used to resolve to an empty list, which
    // every caller reads as "nothing newer exists". A package with no versions
    // cannot be the one we are running.
    const transport = answering(200, '{"versions":{}}');
    await expect(new NpmRegistry({ transport }).published('ailoud')).rejects.toThrow(/no versions/);
  });

  it('treats an empty deprecation message as not deprecated', async () => {
    // `npm deprecate <pkg>@<version> ""` un-deprecates by setting an empty
    // string, not by removing the field. Testing for the key rather than the
    // value reported a revived version as still deprecated, which would refuse
    // a legitimate update.
    const body = JSON.stringify({
      versions: {
        '1.0.0': { version: '1.0.0', deprecated: '' },
        '1.0.1': { version: '1.0.1', deprecated: 'do not use' },
      },
    });
    const transport = answering(200, body);
    expect(await new NpmRegistry({ transport }).published('ailoud')).toEqual([
      { version: '1.0.0', deprecated: false },
      { version: '1.0.1', deprecated: true },
    ]);
  });

  it('throws when the body has no versions', async () => {
    // A silent empty answer would read as "you are up to date", which is the
    // one wrong thing a version check can say.
    const transport = answering(200, '{}');
    await expect(new NpmRegistry({ transport }).published('ailoud')).rejects.toThrow(/versions/);
  });
});
