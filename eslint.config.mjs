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
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      // mkdocs build output: third-party minified JS, not ours to lint.
      'site/**',
    ],
  },
  {
    // The build's configuration and the release scripts. Both were ignored,
    // which meant every editor reported "File ignored because of a matching
    // ignore pattern" on opening one, and a mistake in them was caught by
    // nothing -- `node --check` was the only gate on scripts/, and it sees
    // syntax, not an unused variable or a misspelled identifier. They are
    // Node, not part of the typed source tree, so they get the recommended
    // rules and Node globals rather than the type-aware config.
    files: ['*.config.{js,mjs,cjs,ts}', '**/*.config.{js,mjs,cjs,ts}', 'scripts/**/*.mjs'],
    languageOptions: {
      // The Node globals these files actually use. Spelled out rather than
      // pulled from a globals package: it is a short list, and a new name
      // appearing here should be a deliberate addition.
      globals: {
        console: 'readonly',
        process: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
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
      // Both src and dist. A cross-package import can be written two ways:
      // `../../providers/src/index.js` resolves to a source file, but
      // `@ailoud/providers` resolves through node_modules to the built
      // `dist/index.js` -- which matched no element, so the rule classified it
      // as unknown and said nothing at all. Listing dist under the same type
      // makes both forms the same violation. It does mean the second form is
      // only caught once dist exists, which is why the gate and CI both build
      // before they lint.
      'boundaries/elements': [
        { type: 'core', pattern: ['packages/core/src/**', 'packages/core/dist/**'] },
        {
          type: 'providers',
          pattern: ['packages/providers/src/**', 'packages/providers/dist/**'],
        },
        { type: 'cli', pattern: ['apps/cli/src/**', 'apps/cli/dist/**'] },
      ],
      // The root tsconfig, which includes every package's sources, rather
      // than a glob over the per-package ones: the resolver warns about
      // multiple projects, and one project covering the whole workspace is
      // both quieter and faster.
      'import/resolver': {
        typescript: { project: 'tsconfig.json' },
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            ...Object.entries(LAYER_MAY_IMPORT).map(([from, to]) => ({
              from: { element: { type: from } },
              allow: { to: { element: { types: { anyOf: to } } } },
            })),
          ],
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
