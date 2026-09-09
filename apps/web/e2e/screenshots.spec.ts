import { devices, expect, test } from '@playwright/test';
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

/** Tira o print só depois de todas as imagens (avatares) terminarem de carregar. */
const snap = async (p: import('@playwright/test').Page, name: string): Promise<void> => {
  await p
    .waitForFunction(() => Array.from(document.images).every((i) => i.complete), null, {
      timeout: 8000,
    })
    .catch(() => undefined);
  await p.screenshot(shot(name));
};

test.skip(!!process.env.CI, 'utilitário de documentação; não roda no CI');

test('gera os prints do README', async ({ page, request, browser }) => {
  test.setTimeout(120_000);

  // 1. Login (tela pública)
  await page.goto('/login');
  await page.getByLabel('E-mail').fill('bruno@escambo.demo');
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.waitForTimeout(400); // fontes
  await snap(page, '01-login');

  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
  await settled(page);
  await page.waitForTimeout(400);
  await snap(page, '02-inicio');

  // 2. Serviços com descoberta local ligada (geolocalização emulada em Joinville)
  await page.goto('/servicos');
  await settled(page);
  const perto = page.getByRole('button', { name: /Perto de mim/ });
  if (await perto.isVisible()) {
    await perto.click();
    await expect(page.getByText(/km de você/).first()).toBeVisible();
  }
  await page.waitForTimeout(400);
  await snap(page, '03-servicos');

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
  await snap(page, '04-sala-contrato');

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

  // 13. Depósito PIX (modal): valor → cobrança com QR e copia e cola (gateway simulado)
  await page.goto('/carteira');
  await settled(page);
  await page.getByRole('button', { name: 'Depositar' }).click();
  const depositModal = page.getByRole('dialog');
  await depositModal.getByRole('button', { name: 'R$ 200,00' }).click();
  await depositModal.getByRole('button', { name: /Gerar cobrança PIX/ }).click();
  await expect(depositModal.getByTestId('pix-code')).toBeVisible();
  await page.waitForTimeout(500);
  await snap(page, '13-deposito-pix');
  await depositModal.getByRole('button', { name: 'Fechar' }).click();

  // 9. Perfil público do freelancer (via o ulid do dono do serviço em destaque)
  const svc = await request.get('/api/services?q=Landing%20page%20em%20React&limit=1');
  const { items } = (await svc.json()) as { items: { ownerUlid?: string }[] };
  if (items[0]?.ownerUlid) {
    await page.goto(`/freelancers/${items[0].ownerUlid}`);
    await settled(page);
    await page.waitForTimeout(400);
    await snap(page, '09-perfil-publico');
  }

  // 10. Mobile (Pixel 7): mesma sessão, navegação no rodapé
  const mobile = await browser.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 2 });
  const mp = await mobile.newPage();
  await mp.addInitScript((t) => window.localStorage.setItem('escambo_token', t ?? ''), token);
  await mp.goto('/');
  await settled(mp);
  await mp.waitForTimeout(600);
  await snap(mp, '10-mobile-inicio');
  await mobile.close();

  // 11/12. Admin (fila de mediação) e a Sala do contrato em disputa, vista pela cliente.
  const login = async (email: string) => {
    const r = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
    return ((await r.json()) as { accessToken: string }).accessToken;
  };
  const shotAs = async (tok: string, path: string, name: string) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const p = await ctx.newPage();
    await p.addInitScript((t) => window.localStorage.setItem('escambo_token', t), tok);
    await p.goto(path);
    await settled(p);
    await p.waitForTimeout(500);
    await p.screenshot(shot(name));
    await ctx.close();
  };
  const adminTok = await login('admin@escambo.demo');
  await shotAs(adminTok, '/admin', '11-admin');
  const anaTok = await login('cliente@escambo.demo');

  // 14. Modal de contratação visto pela cliente: saldo da carteira pré-paga e valor reservado
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const p = await ctx.newPage();
    await p.addInitScript((t) => window.localStorage.setItem('escambo_token', t), anaTok);
    await p.goto('/servicos');
    await settled(p);
    await p
      .locator('.card.service', { hasText: 'Landing page em React' })
      .first()
      .getByRole('button', { name: 'Contratar' })
      .click();
    await expect(p.getByRole('dialog')).toBeVisible();
    await p.waitForTimeout(400);
    await snap(p, '14-contratar');
    await ctx.close();
  }
  const disputes = await request.get('/api/disputes', {
    headers: { Authorization: `Bearer ${anaTok}` },
  });
  const first = ((await disputes.json()) as { contractId: number }[])[0];
  if (first) await shotAs(anaTok, `/contratos/${first.contractId}`, '12-sala-disputa');
});
