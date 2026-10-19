import type { MyDropouts, PublicFreelancerProfile } from '@escambo/types';
import { expect, test } from '@playwright/test';
import { acceptContract, financialSnapshot, get, post } from './adr61-rights.helpers';
import { createAdmin, createService, createUser, openAs, settled, topUp } from './helpers';

/** RN-026: contagem pública, direitos privados e decisões humanas, sem liquidar duas vezes. */
test('três desistências: alerta público, contestação privada, acordo e decisão humana reduzem a contagem', async ({
  page,
  request,
}) => {
  test.slow();
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const admin = await createAdmin(request);
  const service = await createService(request, freelancer, 100);
  const { ulid } = await get<{ ulid: string }>(request, freelancer, '/auth/me');
  await topUp(request, client, 300);
  const ids: number[] = [];
  const titles = ['Layout privado A', 'Layout privado B', 'Layout privado C'].map(
    (title) => `${title} ${freelancer.id}`,
  );
  // Uma por vez: a RN-020 só deixa uma contratação direta aberta por par, e a desistência a
  // encerra. As duas primeiras desistências vão pela API; a terceira usa o modal com o retrato da
  // contagem e do dinheiro.
  for (const [i, title] of titles.entries()) {
    const id = await acceptContract(request, client, freelancer, {
      serviceId: service.id,
      title,
      description: 'Contratação de teste para exercer os direitos de desistência após o aceite.',
      price: 100,
    });
    ids.push(id);
    if (i < titles.length - 1) await post(request, freelancer, `/contracts/${id}/cancel`);
  }
  await openAs(page, freelancer, `/contratos/${ids[2]}`);
  await settled(page);
  await page.getByRole('button', { name: 'Desistir', exact: true }).click();
  const cancel = page.getByRole('dialog', { name: 'Desistir da contratação' });
  await expect(cancel.getByTestId('cancel-body')).toContainText(
    'Com esta, são 3 nos últimos 60 dias',
  );
  await expect(cancel.getByTestId('cancel-body')).toContainText(
    'sem dizer qual contratação nem com quem',
  );
  await expect(cancel.getByTestId('cancel-quote')).toContainText(/R\$\s100,00/);
  await cancel.getByRole('button', { name: 'Desistir', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'Você desistiu.' })).toBeVisible();
  const wallets = await Promise.all([
    financialSnapshot(request, client),
    financialSnapshot(request, freelancer),
  ]);
  expect(wallets[0]?.wallet).toMatchObject({ balance: 300, balancePending: 0 });
  expect(wallets[1]?.wallet).toMatchObject({ balance: 0, balancePending: 0 });

  await openAs(page, client, `/freelancers/${ulid}`);
  await settled(page);
  await expect(page.getByTestId('dropouts-alert')).toContainText('3 desistências');
  for (const title of titles) await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  const publicProfile = await get<PublicFreelancerProfile>(
    request,
    client,
    `/profiles/freelancer/${ulid}`,
  );
  expect(publicProfile.dropouts).toEqual({ count: 3, alert: true, windowDays: 60 });

  await openAs(page, freelancer, '/perfil#desistencias');
  await settled(page);
  const mine = await get<MyDropouts>(request, freelancer, '/profiles/me/dropouts');
  const firstDropout = mine.items.find((item) => item.contractId === ids[0]);
  expect(firstDropout).toBeDefined();
  const first = page.getByTestId('desistencias-card').getByTestId(`dropout-${firstDropout!.id}`);
  await expect(first).toContainText(titles[0]!);
  await first.getByRole('button', { name: 'Contestar', exact: true }).click();
  const appeal = page.getByRole('dialog', { name: 'Contestar desistência' });
  const explanation =
    'O cliente pediu o encerramento porque o material de origem não ficou pronto.';
  await appeal.getByLabel('Por que esta desistência não deveria contar').fill('Curto');
  await expect(appeal.getByRole('button', { name: 'Enviar contestação' })).toBeDisabled();
  await appeal.getByLabel('Por que esta desistência não deveria contar').fill(explanation);
  await appeal.getByRole('button', { name: 'Enviar contestação' }).click();
  await expect(first).toContainText('esperando a equipe');
  await expect(first.getByRole('button', { name: 'Contestar', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('desistencias-card')).toContainText('No perfil agora: 3');
  expect((await get<MyDropouts>(request, freelancer, '/profiles/me/dropouts')).count).toBe(3);

  // O cliente confirma outra desistência; não lê a contestação que continua com a equipe.
  await openAs(page, client, `/contratos/${ids[2]}`);
  await settled(page);
  await expect(page.getByText(explanation, { exact: true })).toHaveCount(0);
  await page
    .getByTestId('dropout-agree')
    .getByRole('button', { name: 'Foi combinado comigo' })
    .click();
  const agreed = page.getByRole('dialog', { name: 'Confirmar desistência combinada' });
  await expect(agreed).toContainText('Isso não muda o dinheiro');
  await agreed.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(page.getByTestId('dropout-agree')).toContainText('Você confirmou');
  expect((await get<MyDropouts>(request, freelancer, '/profiles/me/dropouts')).count).toBe(2);
  expect(
    await Promise.all([financialSnapshot(request, client), financialSnapshot(request, freelancer)]),
  ).toEqual(wallets);
  await openAs(page, client, `/freelancers/${ulid}`);
  await settled(page);
  await expect(page.getByTestId('dropouts-alert')).toHaveCount(0);
  await expect(page.getByTestId('dropouts')).toContainText('2 desistências');
  await expect(page.getByText(explanation, { exact: true })).toHaveCount(0);

  // A decisão é de uma pessoa da equipe e registra a justificativa somente para o titular.
  await openAs(page, admin, '/admin');
  await settled(page);
  const review = page
    .getByTestId('dropout-appeals')
    .getByTestId(`admin-dropout-${firstDropout!.id}`);
  await expect(review).toContainText(explanation);
  await expect(review).toContainText('Desistências que contam agora: 2');
  await review.getByRole('button', { name: 'Não contar', exact: true }).click();
  const decision = page.getByRole('dialog', { name: 'Não contar desistência' });
  const note = 'A equipe confirmou o pedido do cliente e decidiu excluir esta desistência.';
  await decision.getByLabel('Por que? O freelancer recebe esta nota.').fill('Curta');
  await expect(decision.getByRole('button', { name: 'Não contar', exact: true })).toBeDisabled();
  await decision.getByLabel('Por que? O freelancer recebe esta nota.').fill(note);
  await decision.getByRole('button', { name: 'Não contar', exact: true }).click();
  await expect(review).toHaveCount(0);
  expect((await get<MyDropouts>(request, freelancer, '/profiles/me/dropouts')).count).toBe(1);
  expect(
    await Promise.all([financialSnapshot(request, client), financialSnapshot(request, freelancer)]),
  ).toEqual(wallets);

  await openAs(page, freelancer, '/perfil#desistencias');
  await settled(page);
  await expect(first).toContainText(`A equipe decidiu não contar: ${note}`);
  await expect(page.getByTestId('desistencias-card')).toContainText('No perfil agora: 1');
  await openAs(page, client, `/contratos/${ids[0]}`);
  await settled(page);
  await expect(page.getByText(note, { exact: true })).toHaveCount(0);
  await expect(page.getByText(explanation, { exact: true })).toHaveCount(0);
  await openAs(page, client, `/freelancers/${ulid}`);
  await settled(page);
  await expect(page.getByTestId('dropouts')).toContainText('1 desistência');
  await expect(page.getByTestId('dropouts-alert')).toHaveCount(0);
  const finalProfile = await get<PublicFreelancerProfile>(
    request,
    client,
    `/profiles/freelancer/${ulid}`,
  );
  expect(finalProfile.dropouts).toEqual({ count: 1, alert: false, windowDays: 60 });
  expect(JSON.stringify(finalProfile)).not.toContain(explanation);
  expect(JSON.stringify(finalProfile)).not.toContain(note);
});
