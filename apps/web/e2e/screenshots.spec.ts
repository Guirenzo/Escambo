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

  // 15. Sala de uma contratação por marcos (1 liberado, 1 entregue), vista pela cliente
  {
    const anaLogin = await request.post('/api/auth/login', {
      data: { email: 'cliente@escambo.demo', password: PASSWORD },
    });
    const anaToken = ((await anaLogin.json()) as { accessToken: string }).accessToken;
    const list = await request.get('/api/contracts', {
      headers: { Authorization: `Bearer ${anaToken}` },
    });
    const withMs = (
      (await list.json()) as { items: { id: number; hasMilestones: boolean }[] }
    ).items.find((c) => c.hasMilestones);
    if (withMs) {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      });
      const p = await ctx.newPage();
      await p.addInitScript((t) => window.localStorage.setItem('escambo_token', t), anaToken);
      await p.goto(`/contratos/${withMs.id}`);
      await settled(p);
      await expect(p.getByTestId('milestones')).toBeVisible();
      await p.waitForTimeout(400);
      await snap(p, '15-marcos');
      await ctx.close();
    }
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

  // 16. Caixa de saída de e-mails do admin (provedor simulado): um e-mail aberto
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const p = await ctx.newPage();
    await p.addInitScript((t) => window.localStorage.setItem('escambo_token', t), adminTok);
    await p.goto('/admin');
    await settled(p);
    const outbox = p.locator('section', { hasText: 'Caixa de saída de e-mails' });
    await outbox.scrollIntoViewIfNeeded();
    const first = outbox.getByRole('button', { name: 'Ver' }).first();
    if (await first.isVisible()) {
      await first.click();
      await expect(p.getByTestId('email-text')).toBeVisible();
      await p.waitForTimeout(300);
      await snap(p, '16-emails');
    }
    await ctx.close();
  }
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
    // Busca pelo nome: o card não depende da posição no ranking (o destaque da demo expira).
    await p.getByPlaceholder('Buscar serviços…').fill('Landing page em React');
    await p.getByRole('button', { name: 'Buscar' }).click();
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

  // 17. Prazo de entrega: pedido de extensão do freelancer aguardando a decisão da cliente (RN-028).
  const mine = await request.get('/api/contracts?limit=100', {
    headers: { Authorization: `Bearer ${anaTok}` },
  });
  const withExtension = (
    (await mine.json()) as { items: { id: number; extension: unknown }[] }
  ).items.find((c) => c.extension);
  if (withExtension) await shotAs(anaTok, `/contratos/${withExtension.id}`, '17-prazo');

  // 19. Portfólio com um trabalho "na mão" pelo teclado (ADR 53): a linha destacada e a dica.
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const p = await ctx.newPage();
    await p.addInitScript(
      (tk) => window.localStorage.setItem('escambo_token', tk),
      await login('bruno@escambo.demo'),
    );
    await p.goto('/perfil');
    await settled(p);
    const card = p.getByTestId('portfolio-card');
    await card.scrollIntoViewIfNeeded();
    const grip = card.getByRole('button', { name: /^Reordenar / }).last();
    await grip.focus();
    await p.keyboard.press(' ');
    await p.keyboard.press('ArrowUp');
    await expect(card.locator('li.is-grabbed')).toBeVisible();
    await p.waitForTimeout(400);
    await snap(p, '19-portfolio-teclado');
    await p.keyboard.press('Escape');
    await ctx.close();
  }

  // 20. "Não perturbe" (ADR 54): o cartão de avisos com a janela de silêncio ligada.
  {
    const brunoTok = await login('bruno@escambo.demo');
    const pref = await request.put('/api/notifications/preferences', {
      headers: { Authorization: `Bearer ${brunoTok}` },
      data: { quietHours: { start: 22, end: 7 } },
    });
    expect(pref.ok(), await pref.text()).toBeTruthy();
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      permissions: ['notifications'],
    });
    const p = await ctx.newPage();
    await p.addInitScript((tk) => window.localStorage.setItem('escambo_token', tk), brunoTok);
    await p.goto('/perfil');
    await settled(p);
    const quiet = p.getByTestId('push-quiet');
    await quiet.scrollIntoViewIfNeeded();
    await expect(quiet).toBeVisible();
    await p.waitForTimeout(400);
    await snap(p, '20-nao-perturbe');
    await ctx.close();
    // A demo volta ao padrão: a janela é só do print.
    await request.put('/api/notifications/preferences', {
      headers: { Authorization: `Bearer ${brunoTok}` },
      data: { quietHours: null },
    });
  }

  // 18. Avisos no navegador (ADR 52): o cartão do perfil que liga o push naquele aparelho.
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      // O cartão lê a permissão do navegador: sem conceder, o print sairia com "bloqueado".
      permissions: ['notifications'],
    });
    const p = await ctx.newPage();
    await p.addInitScript(
      (t) => window.localStorage.setItem('escambo_token', t),
      await login('bruno@escambo.demo'),
    );
    await p.goto('/perfil');
    await settled(p);
    const card = p.getByTestId('push-card');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await p.waitForTimeout(400);
    await snap(p, '18-avisos-navegador');
    await ctx.close();
  }
});
