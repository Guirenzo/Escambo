import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled, topUp } from './helpers';

/**
 * Fluxos do ciclo da contratação além do caminho feliz: pedido de revisão e perfil público.
 * Rodam em desktop e mobile.
 */

const h = (t: string) => ({ Authorization: `Bearer ${t}` });

test('cliente pede revisão da entrega na Sala; o freelancer vê "Entregar revisão"', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 300);
  const client = await createUser(request, 'client');
  await topUp(request, client, 300);

  // API: contrato criado, aceito e entregue.
  const created = await request.post('/api/contracts', {
    headers: h(client.token),
    data: {
      freelancerId: freelancer.id,
      serviceId: service.id,
      title: service.title,
      description: 'Contratação e2e para pedir revisão da entrega.',
      price: 300,
    },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: number };
  for (const [t, action, data] of [
    [freelancer.token, 'accept', undefined],
    [freelancer.token, 'deliver', { message: 'Primeira versão entregue.' }],
  ] as const) {
    const r = await request.post(`/api/contracts/${id}/${action}`, { headers: h(t), data });
    expect(r.ok(), `${action} → ${r.status()}`).toBeTruthy();
  }

  // Cliente na Sala: aviso de aprovação tácita + ações no cabeçalho.
  await openAs(page, client, `/contratos/${id}`);
  await settled(page);
  await expect(page.getByText(/aprovada automaticamente/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aprovar entrega' })).toBeVisible();

  page.once('dialog', (d) => void d.accept('Ajustar as cores do rodapé'));
  await page.getByRole('button', { name: 'Pedir revisão' }).click();

  // Motivo entra na linha do tempo; as ações de entrega somem para o cliente.
  await expect(page.getByText('Ajustar as cores do rodapé')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aprovar entrega' })).toHaveCount(0);

  // Freelancer vê a nova ação.
  await openAs(page, freelancer, `/contratos/${id}`);
  await settled(page);
  await expect(page.getByRole('button', { name: 'Entregar revisão' })).toBeVisible();
});

test('perfil público do freelancer a partir do card do serviço', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 180);
  const client = await createUser(request, 'client');
  const name = `Freela ${freelancer.id}`;

  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(service.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const card = page.locator('.card.service', { hasText: service.title });
  await expect(card).toHaveCount(1);
  await card.getByRole('link', { name }).click();

  await expect(page).toHaveURL(/\/freelancers\/[0-9A-Z]+$/i);
  await settled(page);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByText(/Nível \d/)).toBeVisible();
  await expect(page.getByRole('img', { name: /de 5, 0 avaliações/ })).toBeVisible();
  await expect(page.locator('.card.service', { hasText: service.title })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Contratar' })).toBeVisible();
});
