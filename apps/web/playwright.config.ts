import { defineConfig, devices } from '@playwright/test';

/**
 * Testes ponta a ponta (Playwright) contra o app inteiro (Web + API + MySQL) já no ar.
 *
 *   E2E_BASE_URL   onde o web está servido (padrão: dev server do Vite em :5173;
 *                  na stack do docker compose use http://localhost:8090)
 *   CI             no CI baixa o Chromium do Playwright; local usa o Google Chrome instalado
 *
 * Projetos:
 *   desktop      smoke (login, contratar → sala → chat) + acessibilidade (axe) + responsividade
 *                (responsivo.spec.ts: as telas principais a 320 px e a 768 px, RNF-026; a largura
 *                vem do test.use do próprio spec)
 *   mobile       mesmo smoke e a mesma acessibilidade (axe e teclado) em um Pixel 7 (barra de
 *                navegação inferior, toque)
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
      testMatch: /smoke\.spec\.ts|a11y\.spec\.ts|responsivo\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      // Acessibilidade também no celular: a navegação vira barra inferior e o axe e a auditoria de
      // teclado (teclado.smoke.spec.ts) olham a marcação desse layout.
      testMatch: /smoke\.spec\.ts|a11y\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'screenshots',
      testMatch: /screenshots\.spec\.ts/,
      // Gerador de prints (17 telas numa execução só), não um teste: precisa de folga.
      timeout: 180_000,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        geolocation: { latitude: -26.3045, longitude: -48.8487 }, // Joinville
        // Notificações entram para o print do perfil não mostrar o cartão de push "bloqueado".
        permissions: ['geolocation', 'notifications'],
      },
    },
  ],
});
