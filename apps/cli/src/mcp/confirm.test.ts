import { describe, expect, it } from 'vitest';
import { Confirmations } from './confirm.js';

class StubClock {
  public constructor(private ms = 0) {}
  public nowIso(): string {
    return new Date(this.ms).toISOString();
  }
  public advance(ms: number): void {
    this.ms += ms;
  }
}

describe('Confirmations', () => {
  it('redeems a token issued for the same thing', () => {
    const confirmations = new Confirmations(new StubClock());
    const token = confirmations.issue('recordings', ['ID001']);
    expect(confirmations.redeem(token, 'recordings', ['ID001'])).toBeNull();
  });

  it('refuses a token nobody issued, which is the whole point', () => {
    // Tokens are random and held only in memory, so one cannot be computed.
    const confirmations = new Confirmations(new StubClock());
    expect(confirmations.redeem('made-up', 'recordings', ['ID001'])).toMatch(/unknown/);
  });

  it('is single-use, so a token cannot be replayed', () => {
    const confirmations = new Confirmations(new StubClock());
    const token = confirmations.issue('recordings', ['ID001']);
    confirmations.redeem(token, 'recordings', ['ID001']);
    expect(confirmations.redeem(token, 'recordings', ['ID001'])).toMatch(/unknown/);
  });

  it('refuses a token issued for different ids', () => {
    // Otherwise the confirmation the user read was about something else.
    const confirmations = new Confirmations(new StubClock());
    const token = confirmations.issue('recordings', ['ID001']);
    expect(confirmations.redeem(token, 'recordings', ['ID002'])).toMatch(/ID001/);
  });

  it('refuses a token issued for a different kind of thing', () => {
    const confirmations = new Confirmations(new StubClock());
    const token = confirmations.issue('reports', ['SUM1']);
    expect(confirmations.redeem(token, 'recordings', ['SUM1'])).toMatch(/reports, not recordings/);
  });

  it('does not care what order the ids come back in', () => {
    const confirmations = new Confirmations(new StubClock());
    const token = confirmations.issue('recordings', ['B', 'A']);
    expect(confirmations.redeem(token, 'recordings', ['A', 'B'])).toBeNull();
  });

  it('expires, and says so rather than silently failing', () => {
    const clock = new StubClock();
    const confirmations = new Confirmations(clock);
    const token = confirmations.issue('recordings', ['ID001']);
    clock.advance(11 * 60_000);
    expect(confirmations.redeem(token, 'recordings', ['ID001'])).toMatch(/unknown|expired/);
  });

  it('still honours a token inside the window', () => {
    const clock = new StubClock();
    const confirmations = new Confirmations(clock);
    const token = confirmations.issue('recordings', ['ID001']);
    clock.advance(9 * 60_000);
    expect(confirmations.redeem(token, 'recordings', ['ID001'])).toBeNull();
  });

  it('issues distinct tokens', () => {
    const confirmations = new Confirmations(new StubClock());
    const tokens = new Set(
      Array.from({ length: 50 }, () => confirmations.issue('recordings', ['ID001'])),
    );
    expect(tokens.size).toBe(50);
  });
});
