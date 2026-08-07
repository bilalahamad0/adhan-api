import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

// This repo ships four runtimes out of one tree: Node on the Pi, a service
// worker, browser page scripts, and an iOS Scriptable widget. Linting them all
// as Node reported 104 phantom `no-undef` errors — and, because the rules block
// did not match `.cjs` at all, silently escalated warnings to errors there.
const SERVICE_WORKER = ['sw.js'];
const BROWSER = ['notifications.js'];
const SCRIPTABLE = ['scriptable/**/*.js'];

// Injected by the Scriptable app at runtime; there is no import to resolve.
const SCRIPTABLE_GLOBALS = {
  Color: 'readonly',
  Font: 'readonly',
  LinearGradient: 'readonly',
  ListWidget: 'readonly',
  Request: 'readonly',
  Script: 'readonly',
  config: 'readonly',
};

const SHARED_RULES = {
  // ESLint 9 defaults caughtErrors to 'all', which lights up every deliberately
  // ignored `catch (_)` in the tree. `_` is already the repo's "I know, I don't
  // need it" marker for args and vars; extend it to catch bindings.
  'no-unused-vars': [
    'warn',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
  ],
  'no-console': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-async-promise-executor': 'off',
};

export default [
  js.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: [
      'node_modules/',
      'media-caster/node_modules/',
      'scripts/triggerAdhan.js',
      'coverage/',
      // Deliberately kept, deliberately not maintained. Linting them buys
      // nothing and hides real problems in live code behind the noise.
      'archive/',
      'scratch_*.js',
    ],
  },
  {
    // Node: the Pi services, the API handlers, the build scripts, the tests.
    // `.cjs` and `.mjs` were previously unmatched here.
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ignores: [...SERVICE_WORKER, ...BROWSER, ...SCRIPTABLE],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: SHARED_RULES,
  },
  {
    files: SERVICE_WORKER,
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.serviceworker },
    },
    rules: SHARED_RULES,
  },
  {
    files: BROWSER,
    languageOptions: {
      ecmaVersion: 'latest',
      // firebase arrives from a CDN <script>, not an import.
      globals: { ...globals.browser, firebase: 'readonly' },
    },
    rules: SHARED_RULES,
  },
  {
    files: SCRIPTABLE,
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...SCRIPTABLE_GLOBALS },
    },
    rules: SHARED_RULES,
  },
];
