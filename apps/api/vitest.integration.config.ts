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
      ADMIN_EMAILS: '@admin.escambo.test',
      DIGEST_HOUR: '8',
      BCRYPT_SALT_ROUNDS: '12',
      PAYMENTS_SIMULATE: 'true',
      PAYMENT_WEBHOOK_SECRET: 'segredo-do-webhook-de-integracao',
      MAIL_PROVIDER: 'simulated',
      PUSH_PROVIDER: 'simulated',
      APP_URL: 'http://app.escambo.test',
      // Chave de TESTE da cifragem de campo (RNF-017/RNF-042): a verificação em duas etapas só
      // existe com ela (ADR 66). São os 32 bytes ASCII de "chave-de-teste-do-escambo-2fa-32", sem
      // uso fora dos testes; o cifra-saque.int.test.ts troca por outra antes de carregar o app.
      FIELD_ENCRYPTION_KEY: 'Y2hhdmUtZGUtdGVzdGUtZG8tZXNjYW1iby0yZmEtMzI=',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-support/**'],
      reporter: ['text-summary', 'json', 'lcov'],
      reportsDirectory: 'coverage/integration',
    },
  },
});
