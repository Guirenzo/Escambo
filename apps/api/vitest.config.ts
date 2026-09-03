import { defineConfig } from 'vitest/config';

/**
 * Testes de UNIDADE (padrão de `npm test`): rápidos, sem banco — as
 * repositories são mockadas. Os testes de integração ficam num config à
 * parte (vitest.integration.config.ts) e não rodam aqui.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Suíte hermética: não depende de um .env local. O env.ts exige JWT_SECRET
    // (sem default) — injetamos um valor de teste para o parse não abortar.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      JWT_SECRET: 'unit-test-secret-0123456789abcdef',
    },
  },
});
