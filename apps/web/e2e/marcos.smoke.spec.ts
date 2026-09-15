import { expect, test } from '@playwright/test';
import {
  brDatePlus,
  createService,
  createUser,
  inputDatePlus,
  openAs,
  settled,
  topUp,
} from './helpers';

/**
 * Escrow por marcos (RN-069): a cliente divide a contratação em etapas no modal; o freelancer
 * entrega marco a marco na Sala; cada aprovação libera só o valor daquele marco; o último
 * conclui a contratação. Desktop e mobile.
 */

const h = (t: string) => ({ Authorization: `Bearer ${t}` });

test('contratar em marcos: entrega e aprovação parciais liberam o escrow aos poucos', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 300);
  const client = await createUser(request, 'client');
  await topUp(request, client, 300);

  // Modal: dividir em 2 marcos de R$ 150.
  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(service.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const card = page.locator('.card.service', { hasText: service.title });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Contratar' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByTestId('milestones-toggle').getByRole('checkbox').check();
  await modal.getByLabel('Título do marco 1').fill('Layout');
  await modal.getByLabel('Título do marco 2').fill('Publicação');
  await modal.getByRole('button', { name: 'Dividir igualmente' }).click();
  await expect(modal.getByLabel('Valor do marco 1')).toHaveValue('150');
  await expect(modal.getByLabel('Valor do marco 2')).toHaveValue('150');
  await modal.getByRole('button', { name: 'Enviar proposta' }).click();
  await expect(page).toHaveURL(/\/contratos\/\d+$/);
  const contractId = Number(page.url().split('/').pop());

  // Sala: seção de marcos, ambos aguardando aceite.
  const section = page.getByTestId('milestones');
  await expect(section).toContainText('0 de 2 liberados');
  await expect(section.locator('.milestone')).toHaveCount(2);

  // Freelancer aceita (API) e entrega o marco 1 na Sala.
  const acc = await request.post(`/api/contracts/${contractId}/accept`, {
    headers: h(freelancer.token),
  });
  expect(acc.ok()).toBeTruthy();
  await openAs(page, freelancer, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByTestId('payment-state')).toHaveText('Em escrow · liberado marco a marco');
  // sem entrega única: só ações por marco
  await expect(page.getByRole('button', { name: 'Registrar entrega' })).toHaveCount(0);
  page.once('dialog', (d) => void d.accept('Layout aprovado no Figma'));
  await page
    .getByTestId('milestones')
    .locator('.milestone')
    .first()
    .getByRole('button', { name: 'Entregar marco' })
    .click();
  await expect(page.locator('.toast', { hasText: 'Marco entregue' })).toBeVisible();
  await expect(page.getByTestId('milestones').locator('.milestone').first()).toContainText(
    'Entregue',
  );

  // Cliente aprova o marco 1: R$ 127,50 liberados, contrato segue em andamento.
  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  const first = page.getByTestId('milestones').locator('.milestone').first();
  await first.getByRole('button', { name: 'Aprovar marco' }).click();
  await expect(page.locator('.toast', { hasText: 'R$ 127,50 liberados' })).toBeVisible();
  await expect(page.getByTestId('milestones')).toContainText('1 de 2 liberados');
  await expect(first).toContainText('Liberado');
  await expect(page.locator('.pill', { hasText: 'Em andamento' }).first()).toBeVisible();

  // Freelancer: 127,50 disponíveis e 127,50 ainda em escrow.
  await openAs(page, freelancer, '/carteira');
  await settled(page);
  await expect(page.getByTestId('wallet-balance')).toHaveText('R$ 127,50');
  await expect(page.getByText('R$ 127,50').nth(1)).toBeVisible();
});

test('marcos com prazos distribuídos até o prazo da contratação, visíveis na Sala', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 300);
  const client = await createUser(request, 'client');
  await topUp(request, client, 300);

  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(service.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page
    .locator('.card.service', { hasText: service.title })
    .getByRole('button', { name: 'Contratar' })
    .click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Prazo de entrega').fill(inputDatePlus(10));
  await modal.getByTestId('milestones-toggle').getByRole('checkbox').check();
  await modal.getByRole('button', { name: 'Dividir igualmente' }).click();
  await modal.getByRole('button', { name: 'Distribuir prazos' }).click();
  await expect(modal.getByLabel('Prazo do marco 1')).toHaveValue(inputDatePlus(5));
  await expect(modal.getByLabel('Prazo do marco 2')).toHaveValue(inputDatePlus(10));
  await modal.getByRole('button', { name: 'Enviar proposta' }).click();
  await expect(page).toHaveURL(/\/contratos\/\d+$/);
  const contractId = Number(page.url().split('/').pop());

  // Sala: cada marco mostra o próprio prazo; depois do aceite, quanto falta.
  const dues = page.getByTestId('milestones').locator('[data-testid^="milestone-due-"]');
  await expect(dues).toHaveCount(2);
  await expect(dues.nth(0)).toContainText(`até ${brDatePlus(5)}`);
  await expect(dues.nth(1)).toContainText(`até ${brDatePlus(10)}`);

  const acc = await request.post(`/api/contracts/${contractId}/accept`, {
    headers: h(freelancer.token),
  });
  expect(acc.ok()).toBeTruthy();
  await openAs(page, freelancer, `/contratos/${contractId}`);
  await settled(page);
  await expect(dues.nth(0)).toContainText('faltam 5 dias');
  await expect(dues.nth(1)).toContainText('faltam 10 dias');
});

test('marcos em créditos: aceite retém os créditos e cada aprovação libera os seus', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 300);
  const client = await createUser(request, 'client');
  // Bônus de boas-vindas (100 créditos) no primeiro acesso à carteira.
  const w = await request.get('/api/wallet', { headers: h(client.token) });
  expect(((await w.json()) as { credits: number }).credits).toBe(100);

  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(service.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page
    .locator('.card.service', { hasText: service.title })
    .getByRole('button', { name: 'Contratar' })
    .click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Valor', { exact: true }).fill('100');
  await modal.locator('.radio-card', { hasText: 'Créditos Escambo' }).click();
  await modal.getByTestId('milestones-toggle').getByRole('checkbox').check();
  await modal.getByRole('button', { name: 'Dividir igualmente' }).click();
  await expect(modal.getByLabel('Valor do marco 1')).toHaveValue('50');
  await expect(modal.getByLabel('Valor do marco 2')).toHaveValue('50');
  await expect(modal.locator('.ms-sum')).toContainText('100 cr de 100 cr');
  await modal.getByRole('button', { name: 'Enviar proposta' }).click();
  await expect(page).toHaveURL(/\/contratos\/\d+$/);
  const contractId = Number(page.url().split('/').pop());

  // Freelancer aceita e entrega o marco 1 pela API; a Sala mostra o escrow em créditos.
  const acc = await request.post(`/api/contracts/${contractId}/accept`, {
    headers: h(freelancer.token),
  });
  expect(acc.ok()).toBeTruthy();
  const detail = await request.get(`/api/contracts/${contractId}`, { headers: h(client.token) });
  const [m1] = ((await detail.json()) as { milestones: { id: number }[] }).milestones;
  const del = await request.post(`/api/contracts/${contractId}/milestones/${m1!.id}/deliver`, {
    headers: h(freelancer.token),
    data: { message: 'Primeira metade pronta.' },
  });
  expect(del.ok()).toBeTruthy();

  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByTestId('payment-state')).toHaveText(
    'Créditos em escrow · liberados marco a marco',
  );
  await expect(page.getByTestId('milestones')).toContainText('0 de 2 liberados · 0 cr de 100 cr');
  await page
    .getByTestId('milestones')
    .locator('.milestone')
    .first()
    .getByRole('button', { name: 'Aprovar marco' })
    .click();
  await expect(page.locator('.toast', { hasText: '50 créditos liberados' })).toBeVisible();
  await expect(page.getByTestId('milestones')).toContainText('1 de 2 liberados · 50 cr de 100 cr');

  // Carteiras: cliente ficou com 0 (100 retidos no aceite); freelancer 100 + 50 e 50 pendentes.
  const cw = await request.get('/api/wallet', { headers: h(client.token) });
  expect((await cw.json()) as object).toMatchObject({ credits: 0, creditsPending: 0 });
  const fw = await request.get('/api/wallet', { headers: h(freelancer.token) });
  expect((await fw.json()) as object).toMatchObject({ credits: 150, creditsPending: 50 });
});
