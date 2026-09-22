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
 * Saúde da moderação (ADR 47): depois de uma sinalização automática removida pela fila, o painel
 * mostra a fila, o tempo até decidir, o acerto por sinal e o período escolhido. Desktop e mobile.
 */
test('painel de saúde da moderação: números, tabela de sinais e período', async ({
  page,
  request,
}) => {
  const client = await createUser(request, 'client');
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer);
  const contractId = await deliveredContract(request, client, freelancer, service);
  const sent = await request.post(`/api/messaging/contracts/${contractId}`, {
    headers: { Authorization: `Bearer ${freelancer.token}` },
    data: { content: `Me paga no pix por fora ${Date.now().toString(36)}` },
  });
  expect(sent.ok(), await sent.text()).toBeTruthy();
  const messageId = ((await sent.json()) as { id: number }).id;
  const admin = await createAdmin(request);
  const adminHeaders = { Authorization: `Bearer ${admin.token}` };
  const queue = (await (
    await request.get('/api/admin/reports?status=pending', { headers: adminHeaders })
  ).json()) as { id: number; targetType: string; targetId: number }[];
  const group = queue.find((g) => g.targetType === 'message' && g.targetId === messageId)!;
  const removed = await request.post(`/api/admin/reports/${group.id}/remove-content`, {
    headers: adminHeaders,
    data: { note: 'Pagamento por fora.' },
  });
  expect(removed.ok(), await removed.text()).toBeTruthy();

  await openAs(page, admin, '/admin');
  await settled(page);
  const card = page.getByTestId('moderation-health');
  await expect(card.getByRole('heading', { name: 'Saúde da moderação' })).toBeVisible();
  await expect(card).toContainText('Esperando decisão');
  await expect(card).toContainText('Tempo até decidir');
  await expect(card).toContainText('Acerto da sinalização');
  await expect(
    card.getByRole('img', { name: /Sinalizações automáticas: Removidas: [1-9]/ }),
  ).toBeVisible();
  const signals = card.getByTestId('health-signals');
  await expect(signals.getByRole('row', { name: /^Pix / })).toBeVisible();
  await expect(signals.getByRole('row', { name: /^Negociar por fora / })).toBeVisible();

  // Série por dia (ADR 50): os dois gráficos com resumo acessível e a meta desenhada.
  const history = card.getByTestId('health-history');
  await expect(history.getByRole('img', { name: /^Decisões por dia/ })).toBeVisible();
  await expect(history.getByRole('img', { name: /meta de 24 h/ })).toBeVisible();
  await expect(history.locator('svg text', { hasText: 'meta 24 h' })).toBeVisible();

  // O período muda a janela e continua mostrando a remoção de agora.
  await card.getByRole('tab', { name: '7 dias' }).click();
  await expect(card.getByRole('tab', { name: '7 dias' })).toHaveAttribute('aria-selected', 'true');
  await expect(
    card.getByRole('img', { name: /Sinalizações automáticas: Removidas: [1-9]/ }),
  ).toBeVisible();
});
