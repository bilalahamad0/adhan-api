import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  js.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ["node_modules/", "audio-caster/node_modules/", "scripts/triggerAdhan.js"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      "no-console": "off",
      "no-empty": ["error", { "allowEmptyCatch": true }],
      "no-async-promise-executor": "off"
    },
  },
];
