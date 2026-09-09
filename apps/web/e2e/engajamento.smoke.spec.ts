import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled } from './helpers';

/**
 * Engajamento: notificações ao vivo (socket → badge + toast), favoritos, filtro por categoria
 * e onboarding do freelancer (perfil + localização). Rodam em desktop e mobile.
 */

const h = (t: string) => ({ Authorization: `Bearer ${t}` });

test('notificação chega ao vivo: badge no menu, toast e lista atualizada sem recarregar', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');

  await openAs(page, freelancer, '/');
  await settled(page);
  await expect(page.getByTestId('nav-badge')).toHaveCount(0);

  // Outro usuário age pela API → o freelancer, com a tela aberta, recebe pelo socket.
  const created = await request.post('/api/contracts', {
    headers: h(client.token),
    data: {
      freelancerId: freelancer.id,
      title: 'Proposta ao vivo',
      description: 'Contratação e2e para testar notificação em tempo real.',
      price: 120,
    },
  });
  expect(created.ok(), `${created.status()}`).toBeTruthy();

  await expect(page.getByTestId('nav-badge')).toHaveText('1');
  await expect(page.locator('.toast', { hasText: 'Nova proposta de contratação' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Proposta ao vivo/ })).toBeVisible();

  await page.getByRole('link', { name: 'Notificações' }).click();
  await expect(page.locator('.list li', { hasText: 'Nova proposta de contratação' })).toBeVisible();
  await page.getByRole('button', { name: 'Marcar todas como lidas' }).click();
  await expect(page.getByTestId('nav-badge')).toHaveCount(0);
});

test('favoritar um serviço e filtrar "Só favoritos"', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 200);
  const client = await createUser(request, 'client');

  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(service.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const card = page.locator('.card.service', { hasText: service.title });
  await expect(card).toHaveCount(1);

  await card.getByRole('button', { name: 'Favoritar' }).click();
  const fav = card.getByRole('button', { name: 'Remover dos favoritos' });
  await expect(fav).toHaveAttribute('aria-pressed', 'true');

  // Persiste e o filtro mostra só o favorito.
  await page.reload();
  await settled(page);
  await page.getByRole('button', { name: /Só favoritos/ }).click();
  await expect(page.locator('.card.service')).toHaveCount(1);
  await expect(page.locator('.card.service', { hasText: service.title })).toBeVisible();
});

test('filtrar serviços por categoria', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  const a = await createService(request, freelancer, 100, 0);
  const b = await createService(request, freelancer, 100, 1);
  const client = await createUser(request, 'client');
  test.skip(a.categoryId === b.categoryId, 'seed com uma categoria só');

  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByLabel('Categoria').selectOption(String(b.categoryId));
  await expect(page.locator('.card.service', { hasText: b.title })).toBeVisible();
  await expect(page.locator('.card.service', { hasText: a.title })).toHaveCount(0);
});

test('onboarding: freelancer sem perfil vê o aviso, define localização e o aviso some', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer', { profile: false });
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: -26.3045, longitude: -48.8487 });

  await openAs(page, freelancer, '/');
  await settled(page);
  await expect(page.getByTestId('onboarding-notice')).toBeVisible();
  await page.getByRole('link', { name: 'Completar perfil' }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  await settled(page);

  const form = page.locator('form', { hasText: 'Salvar freelancer' });
  await form.getByLabel('Nome').fill('Freela Nova');
  await form.getByLabel('Cidade').fill('Joinville');
  await form.getByLabel('Estado (UF)').fill('SC');
  await form.getByRole('button', { name: 'Usar minha localização' }).click();
  await expect(form.getByText(/Definida \(-26\.30/)).toBeVisible();
  await form.getByRole('button', { name: 'Salvar freelancer' }).click();
  await expect(page.locator('.toast', { hasText: 'Perfil de freelancer salvo' })).toBeVisible();

  await page.getByRole('link', { name: 'Início' }).click();
  await settled(page);
  await expect(page.getByTestId('onboarding-notice')).toHaveCount(0);
});
