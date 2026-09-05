import { describe, expect, it, vi } from 'vitest';
import { NpmRegistry } from './npmRegistry.js';

const packument = {
  name: 'ailoud',
  versions: {
    '1.0.0-dev.1': { name: 'ailoud', version: '1.0.0-dev.1', deprecated: 'superseded by 1.0.0' },
    '1.0.0': { name: 'ailoud', version: '1.0.0' },
  },
};

describe('NpmRegistry', () => {
  it('reports every version, marking the deprecated ones', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(packument), { status: 200 }));
    const registry = new NpmRegistry({ fetchImpl });
    expect(await registry.published('ailoud')).toEqual([
      { version: '1.0.0-dev.1', deprecated: true },
      { version: '1.0.0', deprecated: false },
    ]);
  });

  it('asks for the abbreviated packument', async () => {
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(JSON.stringify(packument), { status: 200 }),
    );
    await new NpmRegistry({ fetchImpl }).published('ailoud');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      accept: 'application/vnd.npm.install-v1+json',
    });
  });

  it('escapes a scoped name', async () => {
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(JSON.stringify(packument), { status: 200 }),
    );
    await new NpmRegistry({ fetchImpl }).published('@ailoud/core');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://registry.npmjs.org/@ailoud%2fcore');
  });

  it('throws with the status when the registry refuses', async () => {
    const fetchImpl = async () => new Response('nope', { status: 503 });
    await expect(new NpmRegistry({ fetchImpl }).published('ailoud')).rejects.toThrow(/503/);
  });

  it('throws when the versions object is present but empty', async () => {
    // A 200 with `{"versions": {}}` used to resolve to an empty list, which
    // every caller reads as "nothing newer exists". A package with no versions
    // cannot be the one we are running.
    const fetchImpl = async () => new Response('{"versions":{}}', { status: 200 });
    await expect(new NpmRegistry({ fetchImpl }).published('ailoud')).rejects.toThrow(/no versions/);
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
    const fetchImpl = async () => new Response(body, { status: 200 });
    expect(await new NpmRegistry({ fetchImpl }).published('ailoud')).toEqual([
      { version: '1.0.0', deprecated: false },
      { version: '1.0.1', deprecated: true },
    ]);
  });

  it('throws when the body has no versions', async () => {
    // A silent empty answer would read as "you are up to date", which is the
    // one wrong thing a version check can say.
    const fetchImpl = async () => new Response('{}', { status: 200 });
    await expect(new NpmRegistry({ fetchImpl }).published('ailoud')).rejects.toThrow(/versions/);
  });
});
