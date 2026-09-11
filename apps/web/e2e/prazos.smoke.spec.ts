import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled, topUp } from './helpers';

/**
 * Prazos (RN-028): a cliente contrata com prazo (sugerido pelo serviço), a Sala mostra quanto
 * falta, o freelancer pede a única extensão, a cliente aceita e o prazo muda — com a mudança na
 * linha do tempo e o "faltam N dias" no Início. Desktop e mobile.
 */

const h = (t: string) => ({ Authorization: `Bearer ${t}` });
const DAY = 86_400_000;
const plus = (days: number): Date => new Date(Date.now() + days * DAY);
const pad = (n: number): string => String(n).padStart(2, '0');
/** Valor de <input type="date"> no fuso local. */
const inputDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Como o app exibe a data (dt → toLocaleDateString pt-BR). */
const brDate = (d: Date): string =>
  `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

test('contratar com prazo, pedir extensão e aceitar: o prazo muda uma vez só', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 300); // prazo do serviço: 3 dias
  const client = await createUser(request, 'client');
  await topUp(request, client, 300);

  // Modal: o prazo vem sugerido pelo serviço; a cliente escolhe 5 dias.
  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(service.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const card = page.locator('.card.service', { hasText: service.title });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Contratar' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByLabel('Prazo de entrega')).toHaveValue(inputDate(plus(3)));
  await modal.getByLabel('Prazo de entrega').fill(inputDate(plus(5)));
  await modal.getByRole('button', { name: 'Enviar proposta' }).click();
  await expect(page).toHaveURL(/\/contratos\/\d+$/);
  const contractId = Number(page.url().split('/').pop());
  await expect(page.getByTestId('deadline-kv')).toHaveText(brDate(plus(5)));
  await expect(page.getByTestId('deadline-date')).toHaveText(brDate(plus(5)));

  // Freelancer aceita (API) e, na Sala, vê quanto falta e pede extensão de mais uma semana.
  const acc = await request.post(`/api/contracts/${contractId}/accept`, {
    headers: h(freelancer.token),
  });
  expect(acc.ok()).toBeTruthy();
  await openAs(page, freelancer, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByTestId('deadline-state')).toHaveText('faltam 5 dias');
  await page.getByRole('button', { name: 'Pedir extensão de prazo' }).click();
  const ext = page.getByRole('dialog');
  await ext.getByLabel('Novo prazo').fill(inputDate(plus(12)));
  await ext.getByLabel('Motivo (o cliente lê)').fill('O material chegou depois do combinado');
  await ext.getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(page.locator('.toast', { hasText: 'Pedido enviado' })).toBeVisible();
  await expect(page.getByTestId('extension-request')).toContainText('aguardando o cliente');
  await expect(page.getByRole('button', { name: 'Pedir extensão de prazo' })).toHaveCount(0);

  // Cliente lê o motivo e aceita: prazo novo, registro na linha do tempo, extensão gasta.
  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  const req = page.getByTestId('extension-request');
  await expect(req).toContainText('O material chegou depois do combinado');
  await req.getByRole('button', { name: 'Aceitar novo prazo' }).click();
  await expect(page.locator('.toast', { hasText: 'Prazo estendido' })).toBeVisible();
  await expect(page.getByTestId('deadline-date')).toHaveText(brDate(plus(12)));
  await expect(page.getByTestId('deadline')).toContainText('única extensão usada');
  await expect(page.locator('.timeline')).toContainText('Prazo estendido de');

  // Freelancer não pode pedir de novo; o Início mostra o prazo novo correndo.
  await openAs(page, freelancer, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByTestId('deadline-state')).toHaveText('faltam 12 dias');
  await expect(page.getByRole('button', { name: 'Pedir extensão de prazo' })).toHaveCount(0);
  await page.goto('/');
  await settled(page);
  await expect(page.getByRole('row', { name: new RegExp(service.title) })).toContainText(
    'faltam 12 dias',
  );
});
