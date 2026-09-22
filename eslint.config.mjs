import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.vite/**',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Service worker dos avisos (ADR 52): roda fora da página, com os globais dele.
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      globals: { self: 'readonly', URL: 'readonly' },
    },
  },
  {
    // Scripts utilitários em Node puro (ESM): sem TypeScript, com os globais do runtime.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly' },
    },
  },
);
