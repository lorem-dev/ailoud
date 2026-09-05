import { randomUUID } from 'node:crypto';
import type { Clock } from '@ailoud/core';

/** How long a confirmation stays good for. Long enough to show a user, short enough to expire. */
const TTL_MS = 10 * 60_000;

interface Pending {
  readonly kind: string;
  readonly ids: readonly string[];
  readonly expiresAtMs: number;
}

/**
 * Two-phase confirmation for anything that destroys something.
 *
 * The first call to a delete tool describes what would go and gets a token
 * back; only a second call carrying that token deletes. The point is not to
 * stop a determined caller -- it cannot -- but to make sure a deletion cannot
 * happen in a single step. One step is a step an agent can take from a
 * misread sentence; two steps put the description of what will be lost in
 * front of the user in between.
 *
 * Tokens are random and held only in this process's memory, so one cannot be
 * computed or guessed, and none survives a restart. They are single-use and
 * bound to the exact ids they were issued for: redeeming a token for a
 * different recording than the one described fails, or the confirmation would
 * be for a sentence the user never read.
 */
export class Confirmations {
  private readonly pending = new Map<string, Pending>();

  public constructor(private readonly clock: Clock) {}

  public issue(kind: string, ids: readonly string[]): string {
    this.sweep();
    const token = randomUUID();
    this.pending.set(token, {
      kind,
      ids: [...ids].sort(),
      expiresAtMs: this.nowMs() + TTL_MS,
    });
    return token;
  }

  /**
   * Consumes a token, or explains why it cannot be.
   *
   * Returns a reason rather than a bare false: "expired" and "for a different
   * recording" send the caller to different next steps, and an agent told only
   * "invalid" will retry the same thing.
   */
  public redeem(token: string, kind: string, ids: readonly string[]): string | null {
    this.sweep();
    const found = this.pending.get(token);
    if (found === undefined) {
      return 'that confirmation token is unknown, already used, or expired; call again without a token to get a fresh one';
    }
    if (found.kind !== kind) {
      return `that confirmation token was issued for ${found.kind}, not ${kind}`;
    }
    const wanted = [...ids].sort();
    if (found.ids.length !== wanted.length || found.ids.some((id, at) => id !== wanted[at])) {
      return `that confirmation token was issued for ${found.ids.join(', ')}, not ${wanted.join(', ')}`;
    }
    // Single-use: consumed whether or not the deletion then succeeds, so a
    // token cannot be replayed against a library that changed underneath it.
    this.pending.delete(token);
    return null;
  }

  private nowMs(): number {
    return new Date(this.clock.nowIso()).getTime();
  }

  private sweep(): void {
    const now = this.nowMs();
    for (const [token, entry] of this.pending) {
      if (entry.expiresAtMs <= now) this.pending.delete(token);
    }
  }
}
