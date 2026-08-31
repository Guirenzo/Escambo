import { defineConfig } from 'vitest/config';

/**
 * Testes de INTEGRAÇÃO: sobem o app Express real (supertest) contra um MySQL
 * de verdade, num database dedicado `escambo_test` recriado a cada execução
 * (global-setup). Rode com: `npm run test:int` (precisa do banco no ar).
 *
 * Os valores DB_* são injetados no processo de teste ANTES do app importar o
 * `config/env` — assim o pool conecta no database de teste como root.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    environment: 'node',
    fileParallelism: false, // uma conexão/estado de banco por vez
    hookTimeout: 60_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DB_HOST: process.env.DB_HOST ?? '127.0.0.1',
      DB_PORT: process.env.DB_PORT ?? '3306',
      DB_USER: process.env.TEST_DB_USER ?? 'root',
      DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? 'escambo_root',
      DB_NAME: process.env.TEST_DB_NAME ?? 'escambo_test',
      JWT_SECRET: 'integration-test-secret-key-0123456789',
      BCRYPT_SALT_ROUNDS: '12',
    },
  },
});
