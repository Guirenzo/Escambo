import AxeBuilder from '@axe-core/playwright';
import type { SupportTicketDetail } from '@escambo/types';
import { devices, expect, test } from '@playwright/test';
import { financialSnapshot, get, post } from './adr61-rights.helpers';
import { createAdmin, createUser, openAs, settled, verifyEmail } from './helpers';

test('suporte durante suspensão: abrir, responder e encerrar sem alterar financeiro', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  const admin = await createAdmin(request);
  await verifyEmail(request, admin, admin);
  const { ulid } = await get<{ ulid: string }>(request, user, '/auth/me');
  const before = await financialSnapshot(request, user);
  const suspend = await request.post(`/api/admin/users/${ulid}/suspend`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  expect(suspend.status(), await suspend.text()).toBe(204);
  await openAs(page, user, '/suporte');
  await settled(page);
  await expect(
    page.getByTestId('suspended-banner').getByRole('link', { name: 'falar com o suporte' }),
  ).toHaveAttribute('href', '/suporte');
  await page.getByRole('button', { name: 'Abrir chamado' }).click();
  const dialog = page.getByRole('dialog', { name: 'Abrir chamado' });
  await dialog
    .getByRole('textbox', { name: 'Assunto', exact: true })
    .fill(`Atendimento de conta ${user.id}`);
  await dialog
    .getByRole('textbox', { name: 'Descrição', exact: true })
    .fill('Preciso de orientação sobre minha suspensão.');
  await dialog.getByRole('button', { name: 'Enviar chamado' }).click();
  await expect(page).toHaveURL(/\/suporte\?ticket=\d+/);
  const conversation = page.getByRole('region', { name: 'Detalhes do chamado' });
  await expect(
    conversation.getByText('Preciso de orientação sobre minha suspensão.', { exact: true }),
  ).toBeVisible();
  await expect(conversation.getByLabel('Sua mensagem')).toBeEnabled();
  await conversation.getByLabel('Sua mensagem').fill('Também posso consultar meus dados?');
  await conversation.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(
    conversation.getByText('Também posso consultar meus dados?', { exact: true }),
  ).toBeVisible();
  const axe = await new AxeBuilder({ page })
    .include('.support-layout')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
  await conversation.getByRole('button', { name: 'Encerrar chamado' }).click();
  await expect(conversation.getByText(/Para outro atendimento/)).toBeVisible();
  await expect(conversation.getByLabel('Sua mensagem')).toHaveCount(0);
  expect(await financialSnapshot(request, user)).toEqual(before);
});

test('admin diferencia nota interna, responde e resolve; titular recebe somente conversa pública', async ({
  page,
  request,
  browser,
}, testInfo) => {
  const user = await createUser(request, 'client');
  const admin = await createAdmin(request);
  await verifyEmail(request, admin, admin);
  const ticket = await post<SupportTicketDetail>(request, user, '/support/tickets', {
    category: 'other',
    subject: `Atendimento ${user.id}`,
    description: 'Quero confirmar uma informação sobre a plataforma.',
  });
  await openAs(page, admin, '/notificacoes');
  await settled(page);
  const opened = page.getByRole('listitem').filter({ hasText: 'Novo chamado de suporte' });
  const adminLink = opened.getByRole('link', { name: 'Abrir', exact: true });
  await expect(adminLink).toHaveAttribute('href', `/admin?ticket=${ticket.id}#suporte`);
  await adminLink.click();
  await expect(page).toHaveURL(new RegExp(`/admin\\?ticket=${ticket.id}#suporte$`));
  const conversation = page.getByRole('region', { name: 'Detalhes do chamado' });
  await conversation.getByLabel('Prioridade', { exact: true }).selectOption('high');
  await expect(conversation.getByLabel('Prioridade', { exact: true })).toHaveValue('high');
  await conversation.getByRole('checkbox', { name: /Nota interna/ }).check();
  await conversation.getByLabel('Texto da nota interna').fill('Contexto reservado para a equipe.');
  await expect(conversation.getByRole('button', { name: 'Responder e resolver' })).toBeDisabled();
  await conversation.getByRole('button', { name: 'Registrar nota interna' }).click();
  const note = conversation.locator('.support-internal');
  await expect(note).toContainText('Contexto reservado para a equipe.');
  await expect(note).toContainText('Nota interna · somente equipe');
  await conversation.getByRole('checkbox', { name: /Nota interna/ }).uncheck();
  await conversation.getByLabel('Sua mensagem').fill('Sua informação foi confirmada.');
  await conversation.getByRole('button', { name: 'Responder e resolver' }).click();
  await expect(conversation.getByText(/em até 5 dias/)).toBeVisible();
  await expect(conversation.getByLabel('Situação do atendimento')).toBeDisabled();
  const own = await get<SupportTicketDetail>(request, user, `/support/tickets/${ticket.id}`);
  expect(own.status).toBe('resolved');
  expect(own.firstResponseAt).not.toBeNull();
  expect(own.messages.some((m) => m.message === 'Sua informação foi confirmada.')).toBe(true);
  expect(
    own.messages.some((m) => m.internal || m.message === 'Contexto reservado para a equipe.'),
  ).toBe(false);
  const ownerContext = await browser.newContext({
    ...devices[testInfo.project.name === 'mobile' ? 'Pixel 7' : 'Desktop Chrome'],
    viewport: testInfo.project.use.viewport,
    baseURL: testInfo.project.use.baseURL,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  const ownerPage = await ownerContext.newPage();
  try {
    await openAs(ownerPage, user, '/notificacoes');
    await settled(ownerPage);
    const resolved = ownerPage
      .getByRole('listitem')
      .filter({ hasText: 'Seu chamado foi resolvido' });
    const ownerLink = resolved.getByRole('link', { name: 'Abrir', exact: true });
    await expect(ownerLink).toHaveAttribute('href', `/suporte?ticket=${ticket.id}`);
    await ownerLink.click();
    await expect(ownerPage).toHaveURL(new RegExp(`/suporte\\?ticket=${ticket.id}$`));
    const ownerConversation = ownerPage.getByRole('region', { name: 'Detalhes do chamado' });
    await expect(
      ownerPage.getByText('Contexto reservado para a equipe.', { exact: true }),
    ).toHaveCount(0);
    await ownerConversation.getByLabel('Sua mensagem').fill('Preciso de mais um detalhe.');
    const sent = ownerPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/support/tickets/${ticket.id}/messages`,
    );
    await ownerConversation.getByRole('button', { name: 'Enviar mensagem' }).click();
    const response = await sent;
    expect(response.status(), await response.text()).toBe(201);
    await expect(
      ownerConversation
        .getByRole('list', { name: 'Conversa do chamado' })
        .getByText('Preciso de mais um detalhe.', { exact: true }),
    ).toBeVisible();
    const reopened = await get<SupportTicketDetail>(request, user, `/support/tickets/${ticket.id}`);
    expect(reopened.status).toBe('in_progress');
    expect(reopened.resolvedAt).toBeNull();
    await page.reload();
    await expect(
      conversation.getByText('Preciso de mais um detalhe.', { exact: true }),
    ).toBeVisible();
    await ownerConversation.getByRole('button', { name: 'Encerrar chamado' }).click();
    await expect(ownerConversation.getByText(/Para outro atendimento/)).toBeVisible();
  } finally {
    await ownerContext.close();
  }
});

test('conversa carrega anteriores e mantém notas internas fora da janela pública', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  const other = await createUser(request, 'client');
  const admin = await createAdmin(request);
  await verifyEmail(request, admin, admin);
  const ticket = await post<SupportTicketDetail>(request, user, '/support/tickets', {
    category: 'account',
    subject: `Histórico de suporte ${user.id}`,
    description: 'Descrição inicial que precisa continuar disponível.',
  });
  await post(request, admin, `/admin/support/tickets/${ticket.id}/messages`, {
    message: 'Nota privada fora da conversa pública.',
    internal: true,
  });
  for (let i = 1; i <= 51; i += 1)
    await post(request, user, `/support/tickets/${ticket.id}/messages`, {
      message: `Mensagem de histórico ${i}`,
    });
  const forbidden = await request.get(`/api/support/tickets/${ticket.id}`, {
    headers: { Authorization: `Bearer ${other.token}` },
  });
  expect(forbidden.status()).toBe(404);
  await openAs(page, user, `/suporte?ticket=${ticket.id}`);
  const conversation = page.getByRole('region', { name: 'Detalhes do chamado' });
  await expect(conversation.getByText('Mensagem de histórico 51', { exact: true })).toBeVisible();
  await expect(
    conversation.getByText('Descrição inicial que precisa continuar disponível.', { exact: true }),
  ).toHaveCount(0);
  await conversation.getByRole('button', { name: 'Carregar mensagens anteriores' }).click();
  await expect(
    conversation.getByText('Descrição inicial que precisa continuar disponível.', { exact: true }),
  ).toBeVisible();
  await expect(conversation.locator('.support-message')).toHaveCount(52);
  await expect(
    page.getByText('Nota privada fora da conversa pública.', { exact: true }),
  ).toHaveCount(0);
  await expect(
    conversation.getByRole('button', { name: 'Carregar mensagens anteriores' }),
  ).toHaveCount(0);
  await conversation.getByRole('button', { name: 'Encerrar chamado' }).click();
  await expect(conversation.getByText(/Para outro atendimento/)).toBeVisible();
});
