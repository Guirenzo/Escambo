import { expect, test } from '@playwright/test';
import { acceptContract, bearer, contract, financialSnapshot, post } from './adr61-rights.helpers';
import { createService, createUser, openAs, settled, topUp } from './helpers';

/** RN-023/RN-062 com API, MySQL e interface reais, em desktop e mobile. */
test('duas revisões usadas: freelancer libera a terceira sem adiar aprovação ou disputa', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const service = await createService(request, freelancer, 200);
  await topUp(request, client, 200);
  const id = await acceptContract(request, client, freelancer, {
    serviceId: service.id,
    title: service.title,
    description: 'Entrega única para validar duas revisões e uma concessão sem custo.',
    price: 200,
  });
  await post(request, freelancer, `/contracts/${id}/deliver`, { message: 'Versão inicial.' });
  for (let revision = 1; revision <= 2; revision++) {
    await post(request, client, `/contracts/${id}/request-revision`, {
      note: `Ajuste incluído ${revision}.`,
    });
    await post(request, freelancer, `/contracts/${id}/deliver`, {
      message: `Ajuste incluído ${revision} entregue.`,
    });
  }
  const before = await contract(request, client, id);
  expect(before.revisions).toEqual({ used: 2, limit: 2 });
  const denied = await request.post(`/api/contracts/${id}/request-revision`, {
    headers: bearer(client),
    data: { note: 'Terceira revisão ainda não liberada.' },
  });
  expect(denied.status()).toBe(409);
  const deniedBody = await denied.json();
  expect(deniedBody).toMatchObject({ error: 'revision_limit' });
  const opening = new Date(before.disputeOpensAt!);
  const openingDay = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  }).format(opening);
  const openingHour = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(opening);
  expect(deniedBody.message).toContain('a partir de');
  expect(deniedBody.message).toContain(`${openingDay} às ${openingHour}`);
  expect(deniedBody.message).toContain('abra uma disputa.');

  await openAs(page, client, `/contratos/${id}`);
  await settled(page);
  await expect(page.getByTestId('revisions-summary')).toContainText('2 de 2 usadas');
  await expect(page.getByRole('button', { name: 'Pedir revisão' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Aprovar entrega' })).toBeVisible();

  await openAs(page, freelancer, `/contratos/${id}`);
  await settled(page);
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('O prazo de aprovação automática continua o mesmo');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Liberar mais uma revisão' }).click();
  await expect(page.getByTestId('revisions-summary')).toContainText('2 de 3 usadas');
  const granted = await contract(request, client, id);
  expect(granted.revisions).toEqual({ used: 2, limit: 3 });
  expect(granted.approvalDueAt).toBe(before.approvalDueAt);
  expect(granted.disputeOpensAt).toBe(before.disputeOpensAt);
  await expect(page.getByRole('button', { name: 'Liberar mais uma revisão' })).toHaveCount(0);

  await openAs(page, client, `/contratos/${id}`);
  await settled(page);
  page.once('dialog', (dialog) => dialog.accept('Ajustar a terceira versão conforme combinado.'));
  await page.getByRole('button', { name: 'Pedir revisão' }).click();
  await expect(page.getByTestId('revisions-summary')).toContainText('3 de 3 usadas');
  await expect(page.getByRole('list', { name: 'Histórico da contratação' })).toContainText(
    'Ajustar a terceira versão',
  );
  const revised = await contract(request, client, id);
  expect(revised).toMatchObject({ status: 'revision_requested', revisions: { used: 3, limit: 3 } });
  expect(revised.disputeOpensAt).toBe(granted.disputeOpensAt);
});

test('revisões e concessão são independentes em cada marco da contratação', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const service = await createService(request, freelancer, 200);
  await topUp(request, client, 200);
  const id = await acceptContract(request, client, freelancer, {
    serviceId: service.id,
    title: service.title,
    description: 'Dois marcos com orçamentos independentes de revisões incluídas.',
    price: 200,
    milestones: [
      { title: 'Layout inicial', amount: 100 },
      { title: 'Publicação final', amount: 100 },
    ],
  });
  const initial = await contract(request, client, id);
  const [m1, m2] = initial.milestones;
  expect(m1).toBeDefined();
  expect(m2).toBeDefined();
  const firstPath = `/contracts/${id}/milestones/${m1!.id}`;
  await post(request, freelancer, `${firstPath}/deliver`, { message: 'Layout inicial.' });
  for (let revision = 1; revision <= 2; revision++) {
    await post(request, client, `${firstPath}/request-revision`, {
      note: `Ajustar layout ${revision}.`,
    });
    await post(request, freelancer, `${firstPath}/deliver`, {
      message: `Layout ajustado ${revision}.`,
    });
  }
  await post(request, freelancer, `/contracts/${id}/milestones/${m2!.id}/deliver`, {
    message: 'Publicação entregue sem usar revisões.',
  });
  const before = await contract(request, client, id);
  await openAs(page, client, `/contratos/${id}`);
  await settled(page);
  const first = page.getByTestId(`milestone-${m1!.id}`);
  const second = page.getByTestId(`milestone-${m2!.id}`);
  await expect(first.getByTestId(`milestone-revisions-${m1!.id}`)).toHaveText('Revisões: 2 de 2');
  await expect(first.getByRole('button', { name: 'Pedir revisão' })).toHaveCount(0);
  await expect(second.getByTestId(`milestone-revisions-${m2!.id}`)).toHaveText('Revisões: 0 de 2');
  await expect(second.getByRole('button', { name: 'Pedir revisão' })).toBeVisible();

  await openAs(page, freelancer, `/contratos/${id}`);
  await settled(page);
  page.once('dialog', (dialog) => dialog.accept());
  await first.getByRole('button', { name: 'Liberar mais uma revisão' }).click();
  await expect(first.getByTestId(`milestone-revisions-${m1!.id}`)).toHaveText('Revisões: 2 de 3');
  await expect(second.getByRole('button', { name: 'Liberar mais uma revisão' })).toHaveCount(0);
  const granted = await contract(request, client, id);
  expect(granted.milestones[0]?.approvalDueAt).toBe(before.milestones[0]?.approvalDueAt);
  expect(granted.disputeOpensAt).toBe(before.disputeOpensAt);

  await openAs(page, client, `/contratos/${id}`);
  await settled(page);
  page.once('dialog', (dialog) => dialog.accept('Último ajuste de layout combinado no chat.'));
  await first.getByRole('button', { name: 'Pedir revisão' }).click();
  await expect(first.getByTestId(`milestone-revisions-${m1!.id}`)).toHaveText('Revisões: 3 de 3');
  await expect(second.getByTestId(`milestone-revisions-${m2!.id}`)).toHaveText('Revisões: 0 de 2');
  page.once('dialog', (dialog) => dialog.accept('Ajustar apenas a publicação final.'));
  await second.getByRole('button', { name: 'Pedir revisão' }).click();
  await expect(second.getByTestId(`milestone-revisions-${m2!.id}`)).toHaveText('Revisões: 1 de 2');
  const revised = await contract(request, client, id);
  expect(revised.milestones.map((m) => m.revisions)).toEqual([
    { used: 3, limit: 3 },
    { used: 1, limit: 2 },
  ]);
});

test('janela manual: aviso e botão oculto correspondem à recusa 409 antes e depois da entrega', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const service = await createService(request, freelancer, 200);
  await topUp(request, client, 200);
  const id = await acceptContract(request, client, freelancer, {
    serviceId: service.id,
    title: service.title,
    description: 'Janela de tentativa de acordo antes de acionar a mediação humana.',
    price: 200,
  });
  const wallets = await Promise.all([
    financialSnapshot(request, client),
    financialSnapshot(request, freelancer),
  ]);
  for (const delivered of [false, true]) {
    if (delivered)
      await post(request, freelancer, `/contracts/${id}/deliver`, {
        message: 'Trabalho entregue para avaliação do cliente.',
      });
    const state = await contract(request, client, id);
    expect(Date.parse(state.disputeOpensAt!)).toBeGreaterThan(Date.now());
    for (const participant of [client, freelancer]) {
      await openAs(page, participant, `/contratos/${id}`);
      await settled(page);
      await expect(page.getByTestId('dispute-opens-at')).toContainText(
        delivered ? 'Tentem resolver pelo chat primeiro' : '48 horas depois do aceite',
      );
      await expect(page.getByRole('button', { name: 'Abrir disputa' })).toHaveCount(0);
      const response = await request.post('/api/disputes', {
        headers: bearer(participant),
        data: { contractId: id, reason: 'quality', description: 'Tentativa durante a carência.' },
      });
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'dispute_too_early',
        opensAt: state.disputeOpensAt,
      });
    }
    expect((await contract(request, client, id)).status).toBe(delivered ? 'delivered' : 'accepted');
  }
  expect(
    await Promise.all([financialSnapshot(request, client), financialSnapshot(request, freelancer)]),
  ).toEqual(wallets);
});
