import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled } from './helpers';

/**
 * Polimento de marketplace: paginação da busca ("Carregar mais"), propor troca direto do card
 * e sair de todos os dispositivos. Rodam em desktop e mobile.
 */

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
  await expect(form.getByText(/torna/)).toBeVisible();
  await form.getByRole('button', { name: 'Enviar proposta' }).click();
  await expect(page.locator('.toast', { hasText: 'Proposta de troca enviada' })).toBeVisible();
  await expect(page.locator('.card.service', { hasText: 'Você propôs' })).toBeVisible();
});

test('sair de todos os dispositivos encerra a sessão atual', async ({ page, request }) => {
  const user = await createUser(request, 'client');
  await openAs(page, user, '/perfil');
  await settled(page);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Sair de todos os dispositivos' }).click();
  await expect(page).toHaveURL(/\/login/);
});
