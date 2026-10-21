import { expect, test } from '@playwright/test';
import {
  completeContract,
  createService,
  createUser,
  navTo,
  openAs,
  openLanding,
  PASSWORD,
  settled,
  topUp,
} from './helpers';

/**
 * Smoke ponta a ponta: o caminho crítico do produto com Web + API + MySQL reais.
 * Roda em desktop e em mobile (projeto `mobile`, Pixel 7).
 */

test('login pelo formulário leva ao dashboard', async ({ page, request }) => {
  const user = await createUser(request, 'freelancer');

  await page.goto('/login');
  await page.getByLabel('E-mail').fill(user.email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole('heading', { name: /^(Bom dia|Boa tarde|Boa noite),/ }),
  ).toBeVisible();
  await settled(page);
  // KPIs do dashboard renderizados
  await expect(page.getByText('Saldo disponível')).toBeVisible();
  await expect(page.getByText('Créditos Escambo').first()).toBeVisible();
});

test('página inicial: criar conta pelo lado escolhido, e a categoria volta filtrada depois do login', async ({
  page,
  request,
}) => {
  await openLanding(page);
  await expect(page).toHaveTitle('Contrate ou troque serviços · Escambo');
  await page.getByRole('link', { name: /Criar conta de freelancer/ }).click();
  await expect(page).toHaveURL(/\/cadastro\?perfil=freelancer$/);
  await expect(page.getByRole('heading', { name: 'Crie sua conta' })).toBeVisible();
  await expect(page.getByLabel('Eu sou')).toHaveValue('freelancer');
  await expect(page).toHaveTitle('Criar conta · Escambo');
  // A marca volta à página inicial.
  await page.getByRole('link', { name: 'Escambo' }).click();
  await expect(page).toHaveURL(/\/$/);

  // Categoria sem sessão: pede o login e, depois de entrar, abre a busca já filtrada por ela.
  const user = await createUser(request, 'client');
  await expect(page.locator('#categorias')).toBeVisible();
  const chip = page.locator('#categorias .lp-chip').first();
  const href = (await chip.getAttribute('href')) ?? '';
  const id = new URL(href, 'http://localhost').searchParams.get('categoria') ?? '';
  expect(id, 'a categoria vai no endereço').toMatch(/^\d+$/);
  await chip.click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('E-mail').fill(user.email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/servicos$/);
  await expect(page.getByRole('combobox', { name: 'Categoria' })).toHaveValue(id);
});

test('rota protegida sem sessão redireciona para o login', async ({ page }) => {
  await page.goto('/carteira');
  await expect(page).toHaveURL(/\/login/);
});

test('cliente contrata um serviço, cai na sala do contrato e conversa no chat', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 300);
  const client = await createUser(request, 'client');
  await topUp(request, client, 300); // carteira pré-paga: o valor é reservado na proposta

  await openAs(page, client, '/servicos');
  await settled(page);

  // busca acha só o serviço criado para este teste
  await page.getByPlaceholder('Buscar serviços…').fill(service.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const card = page.locator('.card.service', { hasText: service.title });
  await expect(card).toHaveCount(1);

  // contratar em dinheiro (escrow)
  await card.getByRole('button', { name: 'Contratar' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('heading', { name: `Contratar: ${service.title}` })).toBeVisible();
  await expect(modal.locator('.summary strong')).toHaveText('R$ 300,00');
  await modal.getByRole('button', { name: 'Enviar proposta' }).click();

  // sala do contrato
  await expect(page).toHaveURL(/\/contratos\/\d+$/);
  await expect(page.getByRole('heading', { level: 1, name: service.title })).toBeVisible();
  await expect(page.locator('.pill', { hasText: 'Pendente' })).toBeVisible();
  await expect(page.getByText('Linha do tempo')).toBeVisible();

  // chat em tempo real
  const msg = `Olá! Mensagem e2e ${Date.now()}`;
  await page.getByPlaceholder('Escreva uma mensagem…').fill(msg);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.locator('.bubble.mine', { hasText: msg })).toBeVisible();

  // o contrato aparece na lista do cliente (um cartão por contratação, com o título como nome)
  await page.goto('/');
  await settled(page);
  await expect(page.getByRole('article', { name: service.title })).toBeVisible();
});

test('navegação principal funciona (lateral / barra inferior com "Mais" no mobile)', async ({
  page,
  request,
}, testInfo) => {
  const user = await createUser(request, 'freelancer');
  await openAs(page, user, '/');
  await settled(page);

  const nav = page.locator('.sidebar');
  await expect(nav).toBeVisible();
  if (testInfo.project.name === 'mobile') {
    // no mobile a navegação vira barra fixa no rodapé
    const box = await nav.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box, 'sidebar deve ter caixa').not.toBeNull();
    expect(box!.y + box!.height).toBeGreaterThan(viewport.height - 2);
    expect(box!.height).toBeLessThan(120);
    // Cinco itens com rótulo: Início, Serviços, Trocas, Carteira e "Mais" (o resto fica nele).
    const principal = page.getByRole('navigation', { name: 'Principal' });
    for (const name of ['Início', 'Serviços', 'Trocas', 'Carteira'])
      await expect(principal.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(principal.getByRole('button', { name: 'Mais' })).toBeVisible();
    await expect(principal.getByRole('link', { name: 'Ranking', exact: true })).toBeHidden();
  }

  const noHorizontalScroll = async (where: string): Promise<void> => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${where} tem overflow horizontal de ${overflow}px`).toBeLessThanOrEqual(0);
  };
  await noHorizontalScroll('/');

  for (const [label, path, heading] of [
    ['Serviços', '/servicos', 'Serviços'],
    ['Ranking', '/ranking', 'Ranking'],
    ['Carteira', '/carteira', 'Carteira'],
    ['Perfil', '/perfil', 'Perfil'],
  ] as const) {
    await navTo(page, label);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await settled(page);
    // Nenhuma tela pode rolar horizontalmente (tabelas/grades rolam dentro do próprio container).
    await noHorizontalScroll(path);
  }
});

test('cliente avalia a contratação concluída e a nota aparece no perfil do freelancer', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 250);
  const client = await createUser(request, 'client');
  const contractId = await completeContract(request, client, freelancer, service);

  // Dashboard do cliente oferece "Avaliar" na contratação concluída → sala com o formulário.
  await openAs(page, client, '/');
  await settled(page);
  const row = page.getByRole('article', { name: service.title });
  await row.getByRole('button', { name: 'Avaliar' }).click();
  await expect(page).toHaveURL(new RegExp(`/contratos/${contractId}$`));

  await page.getByRole('radio', { name: '5 estrelas' }).check({ force: true });
  await expect(page.getByRole('radio', { name: '5 estrelas' })).toBeChecked();
  await page.getByLabel('Comentário da avaliação').fill('Excelente, entregou antes do prazo.');
  await page.getByRole('button', { name: 'Enviar avaliação' }).click();

  // A avaliação substitui o formulário.
  await expect(page.getByText('Excelente, entregou antes do prazo.')).toBeVisible();
  await expect(page.getByRole('img', { name: '5.0 de 5' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar avaliação' })).toHaveCount(0);

  // No dashboard o botão some (uma avaliação por contrato).
  await page.goto('/');
  await settled(page);
  await expect(row.getByRole('button', { name: 'Avaliar' })).toHaveCount(0);

  // Perfil do freelancer: nota média, contagem e a avaliação recebida com campo de resposta.
  await openAs(page, freelancer, '/perfil');
  await settled(page);
  await expect(page.getByRole('img', { name: '5.0 de 5, 1 avaliações' })).toBeVisible();
  await expect(page.getByText('Excelente, entregou antes do prazo.')).toBeVisible();
  await page.getByLabel('Resposta à avaliação').fill('Obrigado pela confiança!');
  await page.getByRole('button', { name: 'Responder' }).click();
  await expect(page.getByText('Obrigado pela confiança!')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Responder' })).toHaveCount(0);
});
