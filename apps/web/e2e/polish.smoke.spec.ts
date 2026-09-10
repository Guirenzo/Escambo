import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled, topUp } from './helpers';

/**
 * Polimento de marketplace: paginação da busca ("Carregar mais"), propor troca direto do card
 * e sair de todos os dispositivos. Mais o acabamento do app: título por tela, página 404 de
 * verdade e nenhuma requisição para fora. Rodam em desktop e mobile.
 */

test('cada tela tem o próprio título e a navegação é anunciada', async ({ page, request }) => {
  const user = await createUser(request, 'client');
  await openAs(page, user, '/');
  await settled(page);
  await expect(page).toHaveTitle('Início · Escambo');

  await page.getByRole('link', { name: 'Carteira' }).first().click();
  await expect(page).toHaveTitle('Carteira · Escambo');
  // Região viva repete o título para quem usa leitor de tela (o SPA não recarrega).
  await expect(page.getByTestId('route-announcer')).toHaveText('Carteira · Escambo');

  await page.goto('/servicos');
  await expect(page).toHaveTitle('Serviços · Escambo');
});

test('endereço inexistente mostra 404 com saída, em vez de redirecionar em silêncio', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  await openAs(page, user, '/pagina-que-nao-existe');
  await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page).toHaveTitle('Página não encontrada · Escambo');
  await page.getByRole('button', { name: 'Ir para o início' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page).toHaveTitle('Início · Escambo');
});

test('o app não carrega código nem fonte de terceiros (tudo empacotado, CSP fechada)', async ({
  page,
  request,
}) => {
  // Avatares de perfil podem apontar para qualquer host HTTPS (conteúdo do usuário); o que não
  // pode sair do domínio é código: script, folha de estilo, fonte ou requisição de dados.
  const DE_TERCEIROS = ['script', 'stylesheet', 'font', 'xhr', 'fetch', 'websocket'];
  const externas: string[] = [];
  page.on('request', (r) => {
    const host = new URL(r.url()).host;
    const fora = host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1');
    if (fora && DE_TERCEIROS.includes(r.resourceType())) {
      externas.push(`${r.resourceType()} ${r.url()}`);
    }
  });
  const user = await createUser(request, 'client');
  await openAs(page, user, '/');
  await settled(page);
  await page.goto('/servicos');
  await settled(page);
  expect(externas.join('\n')).toBe('');
});

test('busca pagina com "Carregar mais"', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  for (let i = 0; i < 13; i++) await createService(request, freelancer, 50 + i);
  const client = await createUser(request, 'client');

  await openAs(page, client, '/servicos');
  await settled(page);
  const cards = page.locator('.card.service');
  await expect(cards).toHaveCount(12);
  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect.poll(async () => cards.count()).toBeGreaterThan(12);
});

test('freelancer propõe troca a partir do card de outro freelancer', async ({ page, request }) => {
  const owner = await createUser(request, 'freelancer');
  const wanted = await createService(request, owner, 400);
  const me = await createUser(request, 'freelancer');
  const mine = await createService(request, me, 300);
  await topUp(request, me, 100); // ofereço 300 por 400: pago R$ 100 de torna, reservados na proposta

  await openAs(page, me, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(wanted.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const card = page.locator('.card.service', { hasText: wanted.title });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Propor troca' }).click();

  await expect(page).toHaveURL(/\/trocas/);
  await settled(page);
  const form = page.locator('form', { hasText: 'Nova proposta de troca' });
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Eu quero (serviço de outro freelancer)')).toHaveValue(
    String(wanted.id),
  );
  await form.getByLabel('Serviço que ofereço').selectOption(String(mine.id));
  await form.getByLabel('Valor estimado da minha oferta (R$)').fill('300');
  await expect(
    form.getByText('Você paga R$ 100,00 de torna · reservado da sua carteira agora'),
  ).toBeVisible();
  await form.getByRole('button', { name: 'Enviar proposta' }).click();
  await expect(page.locator('.toast', { hasText: 'Proposta de troca enviada' })).toBeVisible();
  const proposed = page.locator('.card.service', { hasText: 'Você propôs' });
  await expect(proposed).toBeVisible();
  await expect(proposed).toContainText('torna reservada');
});

test('sair de todos os dispositivos encerra a sessão atual', async ({ page, request }) => {
  const user = await createUser(request, 'client');
  await openAs(page, user, '/perfil');
  await settled(page);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Sair de todos os dispositivos' }).click();
  await expect(page).toHaveURL(/\/login/);
});
