import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Proxy: chamadas para /api vão para a API (evita CORS no dev).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3333',
    },
  },
});
