/// <reference types="vitest/config" />
/**
 * Configuração do Vite, a ferramenta que roda o web no desenvolvimento e gera o build.
 * Camada: configuração de build e de testes do front (nada daqui vai para o navegador).
 *   - plugins: o plugin do React (JSX e recarga rápida ao salvar);
 *   - server: o servidor de desenvolvimento em http://localhost:5173, com o proxy para a API;
 *   - test: o Vitest (jsdom, setup e a cobertura mínima que o CI cobra).
 * No build (npm run build) o Vite gera a pasta dist, que a imagem do web copia para o nginx.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Proxy: /api e o WebSocket do Socket.IO vão para a API (evita CORS no dev).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // O React chama sempre /api/... no endereço da própria página (BASE_URL em lib/api.ts).
      // No dev o Vite repassa para a API na 3333; na produção quem repassa é o nginx (e o Caddy).
      '/api': 'http://localhost:3333',
      // ws: true repassa também o WebSocket (upgrade da conexão), que o chat em tempo real usa.
      '/socket.io': { target: 'http://localhost:3333', ws: true },
    },
  },
  test: {
    // jsdom imita o navegador (document, window) no Node: testa componente sem abrir browser.
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
