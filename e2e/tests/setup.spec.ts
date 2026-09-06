// End-to-end coverage for `ailoud setup`'s --model validation, driven through
// the built binary. Deliberately the ONLY setup spec in the no-tools project:
// a real install/download/switch belongs to the `tools` project (see
// jest.config.cjs), which only runs on a provisioned machine, and a bare CI
// runner cannot exercise one honestly.
//
// This one case works on a bare machine precisely because it is bare: every
// check runChecks runs here fails (no ffmpeg, no whisper.cpp, nothing
// configured), so runProvisioning always has a non-empty plan to build and
// always reaches chooseModel -- regardless of --model or of this change. What
// this spec actually proves is narrower, and unaffected by that: an unknown
// --model still raises resolveModelName's UsageError, by name, rather than
// being swallowed by the surrounding plumbing.
import { makeSandbox } from '../src/cli';
import type { Sandbox } from '../src/cli';

jest.setTimeout(60_000);

describe('ailoud setup --model', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('rejects an unknown model name and lists the valid ones', async () => {
    const result = await sandbox.run(['setup', '--model', 'ailoud-e2e-no-such-model']);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/unknown model "ailoud-e2e-no-such-model"/);
    expect(result.stderr).toContain('tiny, base, small, medium, large-v3-turbo');
  });
});
