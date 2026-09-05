// Jest owns the end-to-end suite only: it drives the built binary against
// real audio fixtures (see e2e/tests/pipeline.spec.ts). Everything else in
// this repo is unit-tested under Vitest (see vitest.config.ts).
//
// Kept as .cjs deliberately: the root package.json sets "type": "module",
// and Jest loads its config with `require`, which needs a CommonJS file
// regardless of that setting.
//
// The e2e suite itself is scoped to CommonJS under ts-jest (e2e/tsconfig.json)
// -- a deliberate exception from the NodeNext ESM the rest of the repo uses,
// confined to this one directory.

const shared = {
  testEnvironment: 'node',
  rootDir: '.',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/e2e/tsconfig.json' }],
  },
  // whisper.cpp on CPU is slow; a generous timeout keeps a real transcription
  // from being mistaken for a hang.
  testTimeout: 600_000,
};

/**
 * Two projects, split by what a spec needs from the machine.
 *
 * `no-tools` specs drive the binary without touching ffmpeg, whisper.cpp or a
 * model file -- they only read and write configuration. That distinction is
 * what lets CI run them on every pull request, where provisioning a 488 MB
 * model on each one would not be worth the wall clock.
 *
 * Everything else lands in `tools`, which needs a provisioned machine. Those
 * specs still fail loudly rather than skipping when a tool is missing: a suite
 * that goes green by not running is worse than one that is honestly red.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  maxWorkers: 2,
  detectOpenHandles: true,
  // Also at the root, not only inside each project. Jest takes the per-test
  // timeout from the GLOBAL config, and with `projects` a value set only on a
  // project reaches `configs[].testTimeout` while `globalConfig.testTimeout`
  // stays undefined -- so every test silently fell back to Jest's 5 s default.
  // Locally that was masked: the transcribe specs were failing fast for a
  // missing model, so nothing ran long enough to hit it. On CI, where the
  // model is there, whisper takes tens of seconds and every one timed out.
  testTimeout: 600_000,
  projects: [
    {
      ...shared,
      displayName: 'no-tools',
      testMatch: [
        '<rootDir>/e2e/tests/mcp-install.spec.ts',
        '<rootDir>/e2e/tests/self-update.spec.ts',
      ],
    },
    {
      ...shared,
      displayName: 'tools',
      testMatch: ['<rootDir>/e2e/tests/**/*.spec.ts'],
      testPathIgnorePatterns: [
        '<rootDir>/e2e/tests/mcp-install\\.spec\\.ts',
        '<rootDir>/e2e/tests/self-update\\.spec\\.ts',
      ],
    },
  ],
};
