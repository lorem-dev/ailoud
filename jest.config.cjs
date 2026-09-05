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
  projects: [
    {
      ...shared,
      displayName: 'no-tools',
      testMatch: ['<rootDir>/e2e/tests/mcp-install.spec.ts'],
    },
    {
      ...shared,
      displayName: 'tools',
      testMatch: ['<rootDir>/e2e/tests/**/*.spec.ts'],
      testPathIgnorePatterns: ['<rootDir>/e2e/tests/mcp-install\\.spec\\.ts'],
    },
  ],
};
