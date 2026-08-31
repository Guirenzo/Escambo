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
  },
});
