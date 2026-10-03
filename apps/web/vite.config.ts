/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Proxy: /api e o WebSocket do Socket.IO vão para a API (evita CORS no dev).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3333',
      '/socket.io': { target: 'http://localhost:3333', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // Cobertura (ADR 59): todo arquivo de src conta, mesmo sem teste. A meta do Playbook para o
    // frontend é 25%; o piso aqui é mais alto, para a cobertura que existe não se desfazer aos poucos.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
