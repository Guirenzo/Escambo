import type { MyDropouts } from '@escambo/types';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { acceptContract, financialSnapshot, get, post } from './adr61-rights.helpers';
import {
  createAdmin,
  createService,
  createUser,
  openAs,
  PASSWORD,
  settled,
  topUp,
  type TestUser,
} from './helpers';

const headers = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

async function moderate(
  request: APIRequestContext,
  admin: TestUser,
  target: TestUser,
  action: 'suspend' | 'reactivate' | 'ban',
): Promise<void> {
  const { ulid } = await get<{ ulid: string }>(request, target, '/auth/me');
  const response = await request.post(`/api/admin/users/${ulid}/${action}`, {
    headers: headers(admin),
  });
  expect(response.status(), await response.text()).toBe(204);
}

async function accepted(request: APIRequestContext) {
  const client = await createUser(request, 'client');
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 100);
  await topUp(request, client, 200);
  const id = await acceptContract(request, client, freelancer, {
    serviceId: service.id,
    title: `Consulta RN-007 ${client.id}`,
    description: 'Contratação fictícia usada para validar suspensão e direitos do titular.',
    price: 100,
  });
  return { client, freelancer, service, id };
}

test('login suspenso mantém consultas, banner e ações comerciais desabilitadas', async ({
  page,
  request,
}) => {
  const { client, freelancer, service, id } = await accepted(request);
  const admin = await createAdmin(request);
  const message = `Histórico preservado RN-007 ${id}`;
  await post(request, freelancer, `/messaging/contracts/${id}`, { content: message });
  const before = await financialSnapshot(request, client);
  await moderate(request, admin, client, 'suspend');

  // Login real: a conta suspensa continua entrando para consultar os próprios dados.
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(client.email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByTestId('suspended-banner')).toContainText('acesso somente para consulta');
  await expect(page).not.toHaveURL(/\/login/);

  await page.goto('/carteira');
  await settled(page);
  await expect(page.getByTestId('wallet-balance')).toHaveText('R$ 100,00');
  await expect(page.getByRole('button', { name: 'Depositar', exact: true })).toBeDisabled();
  await expect(page.getByTestId('ledger')).toContainText('Depósito via PIX');

  await page.goto('/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(service.title);
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  const card = page.locator('.card.service', { hasText: service.title });
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Contratar', exact: true })).toBeDisabled();

  await page.goto(`/contratos/${id}`);
  await settled(page);
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('Escreva uma mensagem…')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeDisabled();
  await expect(
    page.getByText('Chat disponível somente para leitura durante a suspensão.'),
  ).toBeVisible();

  await page.goto('/perfil');
  await settled(page);
  await expect(page.getByRole('button', { name: 'Salvar cliente', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Solicitar exportação dos meus dados' }),
  ).toBeEnabled();
  expect(await financialSnapshot(request, client)).toEqual(before);
});

test('sessão aberta fecha modal ao suspender, reativa sem novo login e perde acesso ao banir', async ({
  page,
  request,
}) => {
  const target = await createUser(request, 'client');
  const admin = await createAdmin(request);
  await openAs(page, target, '/carteira');
  await settled(page);
  await page.getByRole('button', { name: 'Depositar', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Depositar na carteira' })).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem('escambo_token'));

  await moderate(request, admin, target, 'suspend');
  // Voltar o foco é um evento real usado pelo produto para reler o estado, inclusive entre instâncias.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByTestId('suspended-banner')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Depositar', exact: true })).toBeDisabled();
  await expect(page).toHaveURL(/\/carteira$/);

  await moderate(request, admin, target, 'reactivate');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByTestId('suspended-banner')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Depositar', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('escambo_token'))).toBe(token);
  await page.getByRole('button', { name: 'Depositar', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Depositar na carteira' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar', exact: true }).click();

  await moderate(request, admin, target, 'ban');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => localStorage.getItem('escambo_token'))).toBeNull();
  await page.getByLabel('E-mail').fill(target.email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByText(/Conta banida/)).toBeVisible();
});

test('suspenso exporta dados, pede exclusão e encerra sessões pelo perfil', async ({
  page,
  request,
}) => {
  const target = await createUser(request, 'client');
  await moderate(request, await createAdmin(request), target, 'suspend');
  await openAs(page, target, '/perfil');
  await settled(page);
  await expect(page.getByTestId('suspended-banner')).toBeVisible();
  await page.getByRole('button', { name: 'Solicitar exportação dos meus dados' }).click();
  await expect(page.locator('.toast', { hasText: 'pronta para download' })).toBeVisible();
  const row = page.getByLabel('Exportações solicitadas').locator('li').first();
  await expect(row).toContainText('pronta');
  const downloaded = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Baixar', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/^escambo-dados-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(row).toContainText('baixada');

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Solicitar exclusão da conta' }).click();
  await expect(page.locator('.toast', { hasText: 'Exclusão solicitada' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exclusão em análise' })).toBeDisabled();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Sair de todos os dispositivos' }).click();
  await expect(page).toHaveURL(/\/login/);
});

test('freelancer suspenso contesta desistência sem alterar a liquidação', async ({
  page,
  request,
}) => {
  const { client, freelancer, id } = await accepted(request);
  await post(request, freelancer, `/contracts/${id}/cancel`);
  const before = await Promise.all([
    financialSnapshot(request, client),
    financialSnapshot(request, freelancer),
  ]);
  const mine = await get<MyDropouts>(request, freelancer, '/profiles/me/dropouts');
  const dropout = mine.items.find((item) => item.contractId === id);
  expect(dropout).toBeDefined();
  await moderate(request, await createAdmin(request), freelancer, 'suspend');
  await openAs(page, freelancer, '/perfil#desistencias');
  await settled(page);
  const row = page.getByTestId('desistencias-card').getByTestId(`dropout-${dropout!.id}`);
  await row.getByRole('button', { name: 'Contestar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Contestar desistência' });
  const text = 'O encerramento foi solicitado pelo cliente antes do início do trabalho.';
  await dialog.getByLabel('Por que esta desistência não deveria contar').fill(text);
  await dialog.getByRole('button', { name: 'Enviar contestação' }).click();
  await expect(row).toContainText('esperando a equipe');
  await expect(page.getByTestId('suspended-banner')).toBeVisible();
  expect(
    await Promise.all([financialSnapshot(request, client), financialSnapshot(request, freelancer)]),
  ).toEqual(before);
});

test('autor suspenso contesta remoção de mensagem pelo perfil', async ({ page, request }) => {
  const { client, freelancer, id } = await accepted(request);
  const admin = await createAdmin(request);
  const content = `Conteúdo fictício para contestação RN-007 ${id}`;
  const sent = await post<{ id: number }>(request, freelancer, `/messaging/contracts/${id}`, {
    content,
  });
  const report = await post<{ id: number }>(request, client, '/reports', {
    targetType: 'message',
    targetId: sent.id,
    reason: 'other',
    description: 'Registro fictício para revisar conteúdo.',
  });
  await post(request, admin, `/admin/reports/${report.id}/remove-content`, {
    note: 'Remoção fictícia para revisão pelo autor.',
  });
  await moderate(request, admin, freelancer, 'suspend');
  await openAs(page, freelancer, '/perfil');
  await settled(page);
  const row = page
    .getByTestId('moderation-card')
    .locator('[data-testid^="removal-"]', { hasText: content });
  await expect(row).toContainText('Mensagem no chat');
  await row.getByRole('button', { name: 'Contestar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Contestar remoção' });
  await dialog
    .getByLabel('Por que a remoção deve ser revertida')
    .fill('Peço a revisão do conteúdo porque ele faz parte do contexto da contratação.');
  await dialog.getByRole('button', { name: 'Enviar contestação' }).click();
  await expect(row).toContainText('Contestação em análise');
  await expect(page.getByTestId('suspended-banner')).toBeVisible();
});
