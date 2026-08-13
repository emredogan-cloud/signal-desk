// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/out/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'packages/db/migrations/**',
      'fixtures/**',
      'data/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // tsconfig.lint.json covers test files, which the per-package BUILD configs
        // deliberately exclude. apps/web has its own compiler settings (JSX, bundler
        // resolution) and cannot share one.
        project: ['./tsconfig.lint.json', './apps/web/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // DELIBERATELY OFF: consistent-type-definitions.
      // This codebase uses `type` throughout, with readonly members, because most of
      // these shapes are closed data contracts rather than extension points. A rule
      // that rewrites half of them to `interface` — which is open to declaration
      // merging — trades a real property for a stylistic one.
      '@typescript-eslint/consistent-type-definitions': 'off',

      // verbatimModuleSyntax requires this to be explicit; making it automatic
      // removes a whole class of "why is this import in the emitted JS" surprises.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // A dropped promise in the ingestion loop is a silently missed source — T-9.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Adding a variant to a union must break the build, not fall through silently.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // THREAT-MODEL §T-1: untrusted content must never be silently coerced into a
      // template string, where an object becomes "[object Object]" and a parse
      // failure becomes a plausible-looking value.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false, allowAny: false },
      ],
      // Structured logging only (ARCHITECTURE.md §9). A console.log carries no level,
      // no trace id, and — critically — bypasses the secret redactor in the logger.
      'no-console': 'error',

      // DELIBERATELY OFF: no-unnecessary-condition.
      // This codebase parses untrusted XML, HTML, and JSON. A TypeScript type over
      // external input is a claim, not a guarantee — `item.title` is typed `string`
      // because the parser says so, not because the feed promised one. This rule
      // flags exactly the runtime guards that make that safe, and "fixing" it means
      // deleting them. See THREAT-MODEL.md §2.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  // THREAT-MODEL §T-7 — the dashboard renders untrusted titles and summaries.
  // React escapes by default; this makes the one escape hatch a build failure
  // rather than a code-review question.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            'dangerouslySetInnerHTML is banned in apps/web (THREAT-MODEL.md §T-7). Untrusted source content is rendered here; React escaping is the control.',
        },
        {
          selector: 'Property[key.name="dangerouslySetInnerHTML"]',
          message:
            'dangerouslySetInnerHTML is banned in apps/web (THREAT-MODEL.md §T-7). Untrusted source content is rendered here; React escaping is the control.',
        },
      ],
    },
  },

  // CLIs and tests are the two places where writing to stdout is the point.
  {
    files: ['**/cli/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-console': 'off',
    },
  },

  // Build-tool config files live outside any tsconfig project.
  {
    files: ['*.config.{js,ts,mjs}', '**/*.config.{js,ts,mjs}', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'no-console': 'off',
    },
  },

  prettierConfig,
);
