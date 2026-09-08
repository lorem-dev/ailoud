import { describe, expect, it } from 'vitest';
import { UsageError } from '@ailoud/core';
import { parseDenoise, parseMaxCpu } from './resourceOptions.js';

describe('parseMaxCpu', () => {
  it('round-trips a percent inside the range', () => {
    expect(parseMaxCpu('1')).toBe(1);
    expect(parseMaxCpu('50')).toBe(50);
    expect(parseMaxCpu('100')).toBe(100);
  });

  it.each(['0', '101', 'abc', '-5', '2.5'])('refuses %s, naming the accepted range', (value) => {
    expect(() => parseMaxCpu(value)).toThrow(UsageError);
    expect(() => parseMaxCpu(value)).toThrow(/1 to 100/);
  });
});

describe('parseDenoise', () => {
  it.each(['auto', 'on', 'off'] as const)('round-trips %s', (mode) => {
    expect(parseDenoise(mode)).toBe(mode);
  });

  it('refuses an unknown mode, naming the three accepted ones', () => {
    expect(() => parseDenoise('sometimes')).toThrow(UsageError);
    expect(() => parseDenoise('sometimes')).toThrow(/auto/);
    expect(() => parseDenoise('sometimes')).toThrow(/\bon\b/);
    expect(() => parseDenoise('sometimes')).toThrow(/off/);
  });
});
