export abstract class LaudError extends Error {
  abstract readonly exitCode: 1 | 2 | 3;
}

/** A request that was well formed but could not be satisfied. */
export class FailureError extends LaudError {
  readonly exitCode = 1 as const;
}

/** Bad flags, an unknown command, an ambiguous selector. */
export class UsageError extends LaudError {
  readonly exitCode = 2 as const;
}

/**
 * The machine is not set up: a missing binary, model, credential, or an
 * unreachable endpoint. Always name the fix in the message.
 */
export class EnvironmentError extends LaudError {
  readonly exitCode = 3 as const;
}
