import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canExchange, escapePackageName, withNpmToken } from './npmOidc.mjs';

describe('escapePackageName', () => {
  it('escapes a scope the way npm does', () => {
    expect(escapePackageName('@ailoud/core')).toBe('@ailoud%2fcore');
  });

  it('leaves an unscoped name alone', () => {
    expect(escapePackageName('ailoud')).toBe('ailoud');
  });
});

describe('canExchange', () => {
  it('is false outside a job with id-token: write', () => {
    // Both variables are needed; GitHub sets them only for `id-token: write`,
    // and the tests' own harness scrubs every GITHUB_ variable.
    const saved = [
      process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
      process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    ];
    try {
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      expect(canExchange()).toBe(false);
      process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://example.invalid/token';
      expect(canExchange()).toBe(false);
      process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'x';
      expect(canExchange()).toBe(true);
    } finally {
      for (const [i, key] of [
        'ACTIONS_ID_TOKEN_REQUEST_URL',
        'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      ].entries()) {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      }
    }
  });
});

describe('withNpmToken', () => {
  it('writes the token to a private npmrc and points npm at it', () => {
    let seen = null;
    const result = withNpmToken('secret-token', (env) => {
      seen = env.NPM_CONFIG_USERCONFIG;
      expect(readFileSync(seen, 'utf8')).toBe('//registry.npmjs.org/:_authToken=secret-token\n');
      return 'body ran';
    });
    expect(result).toBe('body ran');
    // The point of the temporary file: a token on a command line is visible to
    // every process on the machine, and one left on disk outlives the job.
    expect(existsSync(seen)).toBe(false);
  });

  it('removes the npmrc even when the body throws', () => {
    let seen = null;
    expect(() =>
      withNpmToken('t', (env) => {
        seen = env.NPM_CONFIG_USERCONFIG;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(seen)).toBe(false);
  });
});
