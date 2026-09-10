import { expect, test } from '@playwright/test';
import {
  createAdmin,
  createService,
  createUser,
  deliveredContract,
  openAs,
  settled,
} from './helpers';

/**
 * Confiança e segurança: disputa aberta na Sala e resolvida no painel admin, privacidade
 * (LGPD) no Perfil, denúncia e moderação no perfil público. Rodam em desktop e mobile.
 */

test('disputa: freelancer abre na Sala, admin resolve no painel, contrato conclui', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 250);
  const client = await createUser(request, 'client');
  const contractId = await deliveredContract(request, client, freelancer, service);

  // Freelancer abre a disputa pela Sala.
  await openAs(page, freelancer, `/contratos/${contractId}`);
  await settled(page);
  await page.getByRole('button', { name: 'Abrir disputa' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Motivo').selectOption('payment');
  await modal
    .getByLabel('Descrição da disputa')
    .fill('O cliente não responde há dias e a entrega já foi feita.');
  await modal.getByRole('button', { name: 'Abrir disputa' }).click();
  await expect(page.locator('.pill', { hasText: 'Disputa' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Disputa' })).toBeVisible();
  await expect(page.getByText('Problema com pagamento')).toBeVisible();

  // Admin vê na fila e libera ao freelancer.
  const admin = await createAdmin(request);
  await openAs(page, admin, '/admin');
  await settled(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Administração' })).toBeVisible();
  const row = page.locator('tr', { hasText: `#${contractId}` });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Resolver' }).click();
  const resolve = page.getByRole('dialog');
  await expect(resolve.locator('.radio-card.on')).toContainText('Liberar ao freelancer');
  await resolve.getByRole('button', { name: 'Aplicar decisão' }).click();
  await expect(page.locator('.toast', { hasText: 'Disputa resolvida' })).toBeVisible();
  await expect(row).toHaveCount(0);

  // Contrato concluído para as partes, com a decisão registrada na Sala.
  await openAs(page, freelancer, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.locator('.pill', { hasText: 'Concluído' }).first()).toBeVisible();
});

test('quem não é admin não entra no painel', async ({ page, request }) => {
  const user = await createUser(request, 'client');
  await openAs(page, user, '/admin');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
});

test('privacidade (LGPD): cópia dos dados baixável na hora; exclusão concluída pelo admin encerra o acesso', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  await openAs(page, user, '/perfil');
  await settled(page);

  // Portabilidade: a cópia fica pronta na hora e o download é um JSON com os dados do titular.
  await page.getByRole('button', { name: 'Solicitar exportação dos meus dados' }).click();
  await expect(page.locator('.toast', { hasText: 'pronta para download' })).toBeVisible();
  const row = page.getByLabel('Exportações solicitadas').locator('li').first();
  await expect(row).toContainText('pronta');
  const download = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Baixar' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^escambo-dados-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(row).toContainText('baixada');

  // Direito ao esquecimento: pedido registrado…
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Solicitar exclusão da conta' }).click();
  await expect(page.locator('.toast', { hasText: 'Exclusão solicitada' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exclusão em análise' })).toBeDisabled();

  // …e concluído pelo admin: a conta é anonimizada e o titular perde o acesso na hora.
  const admin = await createAdmin(request);
  await openAs(page, admin, '/admin');
  await settled(page);
  const pending = page.getByRole('row', { name: new RegExp(user.email) });
  await expect(pending).toContainText('em análise');
  await pending.getByRole('button', { name: 'Concluir exclusão' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Anonimizar e encerrar a conta' })
    .click();
  await expect(page.locator('.toast', { hasText: 'Conta anonimizada' })).toBeVisible();
  await expect(pending).toHaveCount(0);

  await openAs(page, user, '/');
  await expect(page).toHaveURL(/\/login/);
});

test('denúncia pelo perfil público; admin vê a moderação', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 100);
  const client = await createUser(request, 'client');
  const res = await request.get(`/api/services?q=${encodeURIComponent(service.title)}`);
  const { items } = (await res.json()) as { items: { ownerUlid: string }[] };
  const profileUrl = `/freelancers/${items[0]?.ownerUlid}`;

  await openAs(page, client, profileUrl);
  await settled(page);
  await expect(page.getByLabel('Moderação')).toHaveCount(0);
  await page.getByRole('button', { name: 'Denunciar' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Motivo').selectOption('off_platform');
  await modal.getByLabel('Detalhes da denúncia').fill('Pediu pra fechar por fora.');
  await modal.getByRole('button', { name: 'Enviar denúncia' }).click();
  await expect(page.locator('.toast', { hasText: 'Denúncia registrada' })).toBeVisible();

  const admin = await createAdmin(request);
  await openAs(page, admin, profileUrl);
  await settled(page);
  await expect(page.getByLabel('Moderação')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Suspender' }).click();
  await expect(page.locator('.toast', { hasText: 'suspenso' })).toBeVisible();
});
