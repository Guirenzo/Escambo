import { expect, test } from '@playwright/test';
import { PASSWORD, settled } from './helpers';

/**
 * Gera os prints usados no README (docs/screenshots) a partir dos dados de demonstração.
 *
 *   npm run demo:seed                 # popula a instância (uma vez)
 *   npm run -w apps/web screenshots   # gera os PNGs (1440x900 @2x)
 *
 * Não roda no CI (é utilitário de documentação, não teste).
 */

const OUT = '../../docs/screenshots';
const shot = (name: string) => ({ path: `${OUT}/${name}.png`, fullPage: false as const });

test.skip(!!process.env.CI, 'utilitário de documentação; não roda no CI');

test('gera os prints do README', async ({ page, request }) => {
  test.setTimeout(120_000);

  // 1. Login (tela pública)
  await page.goto('/login');
  await page.getByLabel('E-mail').fill('bruno@escambo.demo');
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.waitForTimeout(400); // fontes
  await page.screenshot(shot('01-login'));

  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
  await settled(page);
  await page.waitForTimeout(400);
  await page.screenshot(shot('02-inicio'));

  // 2. Serviços com descoberta local ligada (geolocalização emulada em Joinville)
  await page.goto('/servicos');
  await settled(page);
  const perto = page.getByRole('button', { name: /Perto de mim/ });
  if (await perto.isVisible()) {
    await perto.click();
    await expect(page.getByText(/km de você/).first()).toBeVisible();
  }
  await page.waitForTimeout(400);
  await page.screenshot(shot('03-servicos'));

  // 3. Sala do contrato com chat (contrato da landing page, o que tem mensagens)
  const token = await page.evaluate(() => window.localStorage.getItem('escambo_token'));
  const res = await request.get('/api/contracts', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const contracts = ((await res.json()) as { items: { id: number; title: string }[] }).items;
  const landing = contracts.find((c) => c.title === 'Landing page em React') ?? contracts[0];
  await page.goto(`/contratos/${landing.id}`);
  await settled(page);
  await expect(page.locator('.bubble').first()).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot(shot('04-sala-contrato'));

  for (const [path, name] of [
    ['/trocas', '05-trocas'],
    ['/ranking', '06-ranking'],
    ['/carteira', '07-carteira'],
    ['/perfil', '08-perfil'],
  ] as const) {
    await page.goto(path);
    await settled(page);
    await page.waitForTimeout(400);
    await page.screenshot(shot(name));
  }
});
