import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled } from './helpers';

/**
 * Troca com torna de verdade: quem recebe o serviço mais valioso paga a diferença, reservada
 * na carteira. Receptor sem saldo deposita no próprio card antes de aceitar. Desktop e mobile.
 */

const h = (t: string) => ({ Authorization: `Bearer ${t}` });

test('receptor paga a torna: deposita no card, aceita e a torna fica reservada', async ({
  page,
  request,
}) => {
  const owner = await createUser(request, 'freelancer'); // recebe a proposta e paga a torna
  const wanted = await createService(request, owner, 300);
  const me = await createUser(request, 'freelancer');
  const mine = await createService(request, me, 400);

  // Proposta pela API: ofereço 400, quero 300 → o receptor paga R$ 100 de torna no aceite.
  const created = await request.post('/api/barters', {
    headers: h(me.token),
    data: {
      receiverId: owner.id,
      offeredServiceId: mine.id,
      requestedServiceId: wanted.id,
      estimatedValueOffered: 400,
      estimatedValueRequested: 300,
    },
  });
  expect(created.ok(), `${created.status()} ${await created.text()}`).toBeTruthy();
  const { id } = (await created.json()) as { id: number };

  await openAs(page, owner, '/trocas');
  await settled(page);
  const card = page.getByTestId(`barter-${id}`);
  await expect(card).toContainText('Você paga R$ 100,00 de torna · torna reservada no aceite');
  await expect(card.getByRole('button', { name: 'Aceitar', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: /Depositar R\$ 100,00 para aceitar/ }).click();

  const modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: /Gerar cobrança PIX de R\$ 100,00/ }).click();
  await modal.getByRole('button', { name: 'Simular pagamento' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await card.getByRole('button', { name: 'Aceitar', exact: true }).click();
  await expect(page.locator('.toast', { hasText: 'Troca atualizada' })).toBeVisible();
  await expect(card.locator('.pill')).toHaveText('Em andamento');
  await expect(card).toContainText('torna reservada');

  // Carteira: R$ 100 retidos, extrato explica.
  await page.goto('/carteira');
  await settled(page);
  await expect(page.getByTestId('wallet-balance')).toHaveText('R$ 0,00');
  await expect(
    page.getByTestId('ledger').locator('li', { hasText: 'Torna reservada para a troca' }),
  ).toBeVisible();
});
