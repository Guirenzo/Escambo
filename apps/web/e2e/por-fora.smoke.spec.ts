import { expect, test } from '@playwright/test';
import { createAdmin, createService, createUser, openAs, settled, topUp } from './helpers';

/**
 * Aviso de negociação por fora (ADR 45): quem digita Pix ou WhatsApp vê o aviso antes de enviar, a
 * mensagem sai com o aviso para as duas partes e entra sozinha na fila do admin como sinalização
 * automática. Desktop e mobile.
 */
test('mensagem com pix e whatsapp: aviso ao digitar, aviso na bolha das duas partes e fila do admin', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 120);
  const client = await createUser(request, 'client');
  await topUp(request, client, 120);
  const created = await request.post('/api/contracts', {
    headers: { Authorization: `Bearer ${client.token}` },
    data: {
      freelancerId: freelancer.id,
      serviceId: service.id,
      title: service.title,
      description: 'Contratação criada pelo teste de negociação por fora.',
      price: 120,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const contractId = ((await created.json()) as { id: number }).id;
  const tag = Date.now().toString(36);

  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  const input = page.getByPlaceholder('Escreva uma mensagem…');
  await input.fill(`Ficou ótimo, obrigado ${tag}`);
  await expect(page.getByTestId('off-platform-hint')).toHaveCount(0);
  const text = `Me paga no pix por fora ${tag}, meu whats é (47) 99999-0001`;
  await input.fill(text);
  await expect(page.getByTestId('off-platform-hint')).toContainText('Pix, telefone');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const bubble = page.locator('.bubble.mine', { hasText: `por fora ${tag}` });
  await expect(bubble).toBeVisible();
  await expect(bubble.getByTestId('off-platform-warning')).toContainText('proteção');
  await expect(page.getByTestId('off-platform-hint')).toHaveCount(0);

  // A outra parte vê o mesmo aviso na bolha.
  await openAs(page, freelancer, `/contratos/${contractId}`);
  await settled(page);
  await expect(
    page
      .locator('.bubble.theirs', { hasText: `por fora ${tag}` })
      .getByTestId('off-platform-warning'),
  ).toBeVisible();

  // Na fila do admin a mensagem aparece como sinalização automática, com o motivo.
  const admin = await createAdmin(request);
  await openAs(page, admin, '/admin');
  await settled(page);
  const group = page
    .getByTestId('reports-card')
    .locator('[data-testid^="report-group-"]', { hasText: `por fora ${tag}` });
  await expect(group).toContainText('Sinalização automática');
  await expect(group).toContainText('Tenta negociar fora da plataforma');
  await expect(group).toContainText('Pix, telefone, WhatsApp e negociar por fora');
  await expect(group.getByRole('button', { name: 'Remover mensagem' })).toBeVisible();
});
