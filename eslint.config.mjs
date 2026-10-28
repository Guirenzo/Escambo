import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { apiBoundaries } from './apps/api/eslint.boundaries.mjs';

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
    // Scripts utilitários em Node puro (ESM): sem TypeScript, com os globais do runtime. O Google
    // falso dos testes ponta a ponta (apps/web/e2e/google-falso.mjs, RF-002) também.
    files: ['scripts/**/*.mjs', 'apps/web/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  // Fronteiras entre os módulos da API (RNF-021): repository alheio, camadas e fachadas.
  ...apiBoundaries,
);
