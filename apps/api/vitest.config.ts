import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Envs de teste — evita depender do .env e não toca no banco (repos são mockados).
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-com-mais-de-16-caracteres',
      JWT_EXPIRES_IN: '1h',
    },
  },
});
