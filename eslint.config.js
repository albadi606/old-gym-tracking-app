import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist', 'coverage', 'playwright-report', 'test-results', 'node_modules'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Workout payloads and imported backups must never be echoed to the console.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Notes stay plain text; no unsanitised HTML rendering anywhere in the app.
      'no-restricted-properties': [
        'error',
        {
          property: 'dangerouslySetInnerHTML',
          message: 'Rich/HTML rendering is not allowed until a reviewed sanitizer exists.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message: 'Rich/HTML rendering is not allowed until a reviewed sanitizer exists.',
        },
      ],
    },
  },
  {
    // This config file is plain JavaScript and is not part of the TypeScript program.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['e2e/**/*.ts', 'playwright.config.ts', 'vite.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
    },
  },
  /*
   * Layer boundaries.
   *
   * These rules enforce the dependency direction below.
   *
   *   app -> features -> components -> shared -> { db, media } -> domain
   *
   * with `i18n` available to every layer above `domain`.
   *
   * The patterns are written against the *relative specifier*, and both one- and
   * two-level forms are listed because a layer may have subfolders (`domain/catalog`,
   * `shared/navigation`). A single `../<one segment>/` pattern cannot be used: in glob syntax `*`
   * happily matches `..`, which would make `../../components/Page.tsx` look like a
   * sibling import.
   *
   * Tests are exempt at the bottom: a test helper legitimately composes the whole app.
   */
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              /*
               * `../media/**` is deliberately absent here and lives in the rule below.
               * From `src/domain/foo.ts` it means `src/media/`, which must be blocked;
               * from `src/domain/backup/foo.ts` it means `src/domain/media/`, which is a
               * sibling aggregate this layer is supposed to use. `../../media/**` is
               * unambiguous at every depth the tree has, so it stays.
               */
              group: [
                '../app/**',
                '../db/**',
                '../features/**',
                '../components/**',
                '../i18n/**',
                '../shared/**',
                '../../app/**',
                '../../db/**',
                '../../features/**',
                '../../components/**',
                '../../i18n/**',
                '../../shared/**',
                '../../media/**',
              ],
              message:
                'The domain layer must stay independent of the application, storage, and UI.',
            },
          ],
          paths: [
            { name: 'react', message: 'Domain rules must be testable without React.' },
            { name: 'react-dom', message: 'Domain rules must be testable without React.' },
            { name: 'dexie', message: 'Domain rules must not depend on the storage engine.' },
            { name: 'react-router-dom', message: 'Domain rules must not depend on routing.' },
          ],
        },
      ],
    },
  },
  {
    /*
     * Only the files directly inside `src/domain/`, where `../media/` is the browser's
     * image-processing layer rather than the domain's own media aggregate. Written as its
     * own scope because one glob cannot distinguish the two.
     */
    files: ['src/domain/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../media/**'],
              message: 'The domain layer must not depend on browser image processing.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/db/**/*.ts', 'src/media/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../app/**',
                '../features/**',
                '../components/**',
                '../i18n/**',
                '../shared/**',
                '../../app/**',
                '../../features/**',
                '../../components/**',
                '../../i18n/**',
                '../../shared/**',
              ],
              message:
                'Persistence and media processing must not depend on the UI or on app wiring.',
            },
          ],
          paths: [
            { name: 'react', message: 'This layer must be testable without React.' },
            { name: 'react-dom', message: 'This layer must be testable without React.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts', 'src/shared/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../app/**',
                '../features/**',
                '../components/**',
                '../../app/**',
                '../../features/**',
                '../../components/**',
              ],
              message:
                'Shared modules are neutral: they may not depend on the composition root or on any feature.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/components/**/*.ts', 'src/components/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../app/**', '../features/**', '../../app/**', '../../features/**'],
              message:
                'Reusable components must not import the composition root or a feature. Move the shared contract to src/shared instead.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/features/**/*.ts', 'src/features/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../app/**', '../app/**'],
              message:
                'A feature must not import the composition root. Move the shared contract to src/shared instead.',
            },
            {
              // Sibling features are listed by name so the rule cannot accidentally
              // catch a legitimate `../../components/...` import.
              group: [
                '../dashboard/**',
                '../history/**',
                '../machines/**',
                '../not-found/**',
                '../progress/**',
                '../settings/**',
                '../workout/**',
              ],
              message:
                'No feature may reach into another feature. Move the shared contract to src/shared, src/components, or src/domain.',
            },
          ],
        },
      ],
    },
  },
  {
    // Test files and test helpers legitimately compose across every layer.
    files: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/test/**/*.ts', 'src/test/**/*.tsx'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/test/**/*.ts', 'src/test/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Test helpers are never hot-reloaded, so mixing a render helper and its fixtures
      // in one file is fine here and nowhere else.
      'react-refresh/only-export-components': 'off',
    },
  },
  prettier,
);
