import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import boundaries from 'eslint-plugin-boundaries';

// packages/core -> nothing; providers -> core; cli -> both.
const LAYER_MAY_IMPORT = {
  core: ['core'],
  providers: ['providers', 'core'],
  cli: ['cli', 'providers', 'core'],
};

export default tseslint.config(
  {
    // scripts/** holds plain Node utility scripts (release tooling, not
    // part of the typed packages/apps source tree); node --check is their
    // syntax gate instead.
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      // mkdocs build output: third-party minified JS, not ours to lint.
      'site/**',
      'scripts/**',
    ],
  },
  {
    // The build's own configuration files. Previously ignored, which meant
    // every editor reported "File ignored because of a matching ignore
    // pattern" on opening one -- and meant a mistake in them was caught by
    // nothing. They are Node, not part of the typed source tree, so they get
    // the recommended rules and Node globals rather than the type-aware
    // config that the packages use.
    files: ['*.config.{js,mjs,cjs,ts}', '**/*.config.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
    rules: {
      // A .cjs file uses require/module, which the type-aware rules would
      // otherwise flag in a "type": "module" workspace.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'core', pattern: 'packages/core/src/**' },
        { type: 'providers', pattern: 'packages/providers/src/**' },
        { type: 'cli', pattern: 'apps/cli/src/**' },
      ],
      'import/resolver': {
        typescript: { project: ['packages/*/tsconfig.json', 'apps/*/tsconfig.json'] },
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: Object.entries(LAYER_MAY_IMPORT).map(([from, to]) => ({
            from: { element: { type: from } },
            allow: { to: { element: { types: { anyOf: to } } } },
          })),
        },
      ],
    },
  },
  // The domain core performs no I/O. Every effect reaches it as a port, so a
  // direct import of one of these modules is the boundary being crossed --
  // catch it here rather than in review, where it reads as harmless.
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/testing/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:fs',
                'node:fs/*',
                'fs',
                'fs/*',
                'node:child_process',
                'child_process',
                'node:sqlite',
                'node:http',
                'node:https',
                'node:net',
                'node:os',
                'node:crypto',
              ],
              message:
                'packages/core performs no I/O. Declare a port in domain/ports.ts and implement it in packages/providers.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
