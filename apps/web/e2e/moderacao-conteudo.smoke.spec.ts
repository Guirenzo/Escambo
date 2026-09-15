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
 * Mensagem denunciada (ADR 44): o admin remove pela fila, as duas partes veem o aviso no chat, o
 * autor vê o texto removido no perfil e contesta, e o admin reverte vendo o texto; a mensagem volta
 * ao chat. A contratação e a mensagem são criadas pela API.
 */
test('mensagem denunciada: removida pela fila, vira aviso no chat e volta pela contestação', async ({
  page,
  request,
}) => {
  const client = await createUser(request, 'client');
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer);
  const contractId = await deliveredContract(request, client, freelancer, service);
  const tag = Date.now().toString(36);
  const text = `Me paga por fora no pix ${tag}, sai mais barato para nós dois`;
  const sent = await request.post(`/api/messaging/contracts/${contractId}`, {
    headers: { Authorization: `Bearer ${freelancer.token}` },
    data: { content: text },
  });
  expect(sent.ok(), await sent.text()).toBeTruthy();
  const messageId = ((await sent.json()) as { id: number }).id;
  const reported = await request.post('/api/reports', {
    headers: { Authorization: `Bearer ${client.token}` },
    data: { targetType: 'message', targetId: messageId, reason: 'off_platform' },
  });
  expect(reported.ok(), await reported.text()).toBeTruthy();

  // O admin remove a mensagem pela fila de denúncias.
  const admin = await createAdmin(request);
  await openAs(page, admin, '/admin');
  await settled(page);
  const group = page
    .getByTestId('reports-card')
    .locator('[data-testid^="report-group-"]', { hasText: `pix ${tag}` });
  await group.getByRole('button', { name: 'Remover mensagem' }).click();
  const removal = page.getByRole('dialog', { name: 'Remover mensagem' });
  await removal.getByLabel('Nota para o registro').fill('Negociação fora da plataforma.');
  await removal.getByRole('button', { name: 'Remover e avisar o autor' }).click();
  await expect(page.locator('.toast', { hasText: 'Mensagem removida' })).toBeVisible();
  await expect(group).toHaveCount(0);

  // No chat, a outra parte vê o aviso no lugar do texto.
  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByTestId('removed-message')).toContainText(
    'Mensagem removida pela moderação',
  );
  await expect(page.getByText(text)).toHaveCount(0);

  // O autor vê o texto removido no perfil e contesta.
  await openAs(page, freelancer, '/perfil');
  await settled(page);
  const row = page
    .getByTestId('moderation-card')
    .locator('[data-testid^="removal-"]', { hasText: `pix ${tag}` });
  await expect(row).toContainText('Mensagem no chat');
  await expect(row).toContainText('Negociação fora da plataforma.');
  await row.getByRole('button', { name: 'Contestar' }).click();
  const appealDialog = page.getByRole('dialog', { name: 'Contestar remoção' });
  await appealDialog
    .getByLabel('Por que a remoção deve ser revertida')
    .fill('Era brincadeira com o cliente; combinamos o pagamento todo pelo Escambo.');
  await appealDialog.getByRole('button', { name: 'Enviar contestação' }).click();
  await expect(page.locator('.toast', { hasText: 'Contestação enviada' })).toBeVisible();

  // O admin lê o texto removido na contestação e reverte.
  await openAs(page, admin, '/admin');
  await settled(page);
  const appeal = page
    .getByTestId('appeals-card')
    .locator('[data-testid^="appeal-"]', { hasText: `pix ${tag}` });
  await appeal.getByRole('button', { name: 'Reverter' }).click();
  const decision = page.getByRole('dialog', { name: 'Reverter remoção' });
  await expect(decision).toContainText(text);
  await decision.getByRole('button', { name: 'Reverter e devolver o conteúdo' }).click();
  await expect(page.locator('.toast', { hasText: 'O conteúdo voltou' })).toBeVisible();
  await expect(appeal).toHaveCount(0);

  // A mensagem volta ao chat.
  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByText(text)).toBeVisible();
  await expect(page.getByTestId('removed-message')).toHaveCount(0);
});
