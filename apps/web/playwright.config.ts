import { defineConfig, devices } from '@playwright/test';

/**
 * Testes ponta a ponta (Playwright) contra o app inteiro (Web + API + MySQL) já no ar.
 *
 *   E2E_BASE_URL   onde o web está servido (padrão: dev server do Vite em :5173;
 *                  na stack do docker compose use http://localhost:8090)
 *   CI             no CI baixa o Chromium do Playwright; local usa o Google Chrome instalado
 *
 * Projetos:
 *   desktop      smoke (login, contratar → sala → chat) + acessibilidade (axe)
 *   mobile       mesmo smoke em um Pixel 7 (barra de navegação inferior, toque)
 *   screenshots  gera os prints de docs/screenshots (precisa dos dados de `npm run demo:seed`)
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(isCI ? {} : { channel: 'chrome' }),
  },
  projects: [
    {
      name: 'desktop',
      testMatch: /smoke\.spec\.ts|a11y\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'screenshots',
      testMatch: /screenshots\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        geolocation: { latitude: -26.3045, longitude: -48.8487 }, // Joinville
        permissions: ['geolocation'],
      },
    },
  ],
});
