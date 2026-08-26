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

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/e2e/tests/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/e2e/tsconfig.json' }],
  },
  // whisper.cpp on CPU is slow; a generous timeout keeps a real transcription
  // from being mistaken for a hang.
  testTimeout: 600_000,
  maxWorkers: 2,
  detectOpenHandles: true,
};
