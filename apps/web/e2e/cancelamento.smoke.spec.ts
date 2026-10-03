import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createService, createUser, openAs, settled, topUp, type TestUser } from './helpers';

/**
 * Cancelamento com o valor na tela e prazo que só cobra o que nunca foi entregue (ADR 57):
 * - antes da metade do prazo, o modal da cliente mostra os 50% com os dois valores; Voltar não
 *   faz nada, e confirmar liquida o mesmo valor;
 * - o freelancer desiste e tudo volta à cliente, que é avisada;
 * - entregue, a Sala diz até quando aprovar; em revisão não há "Cancelar" e o prazo não cobra;
 * - prazo vencido (estado vindo da API): as horas do aviso e da disputa, e o valor que mudou no
 *   meio é recusado sem mexer em nada.
 * Desktop e mobile.
 */

const DAY = 86_400_000;
const h = (t: string) => ({ Authorization: `Bearer ${t}` });

async function acceptedContract(
  request: APIRequestContext,
  client: TestUser,
  freelancer: TestUser,
  service: { id: number; title: string },
  days = 10,
): Promise<number> {
  await topUp(request, client, 200);
  const created = await request.post('/api/contracts', {
    headers: h(client.token),
    data: {
      freelancerId: freelancer.id,
      serviceId: service.id,
      title: service.title,
      description: 'Contratação do teste de cancelamento com valores (ADR 57).',
      price: 200,
      deadlineAt: new Date(Date.now() + days * DAY).toISOString(),
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const id = ((await created.json()) as { id: number }).id;
  const acc = await request.post(`/api/contracts/${id}/accept`, { headers: h(freelancer.token) });
  expect(acc.ok(), await acc.text()).toBeTruthy();
  return id;
}

const wallet = async (request: APIRequestContext, u: TestUser) =>
  (await (await request.get('/api/wallet', { headers: h(u.token) })).json()) as {
    balance: number;
    balancePending: number;
  };

async function axeClean(page: Page, selector: string): Promise<void> {
  const axe = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
}

test('cancelar antes da metade do prazo: o modal mostra 50% e confirmar liquida o mesmo', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 200);
  const client = await createUser(request, 'client');
  const id = await acceptedContract(request, client, freelancer, service);

  await openAs(page, client, `/contratos/${id}`);
  await settled(page);
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancelar contratação' });
  await expect(dialog.getByTestId('cancel-body')).toContainText(
    'Menos da metade do tempo entre o aceite e o prazo passou',
  );
  await expect(dialog.getByTestId('cancel-quote')).toContainText(
    /Você recebe de volta\s*R\$\s100,00/,
  );
  await expect(dialog.getByTestId('cancel-quote')).toContainText(
    /O freelancer fica com\s*R\$\s85,00/,
  );
  await axeClean(page, '[data-testid="cancel-modal"]');

  // Voltar não cancela.
  await dialog.getByRole('button', { name: 'Voltar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await wallet(request, client)).toMatchObject({ balance: 0 });

  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Cancelar contratação' })
    .getByRole('button', { name: 'Cancelar contratação' })
    .click();
  await expect(
    page.locator('.toast', {
      hasText: /Contratação cancelada\. R\$\s100,00 voltou para a sua carteira\./,
    }),
  ).toBeVisible();
  expect(await wallet(request, client)).toMatchObject({ balance: 100, balancePending: 0 });
  expect(await wallet(request, freelancer)).toMatchObject({ balance: 85, balancePending: 0 });
  await expect(page.locator('.timeline')).toContainText('Reembolso: 50%');
});

test('o freelancer desiste: tudo volta para a cliente, que é avisada', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 200);
  const client = await createUser(request, 'client');
  const id = await acceptedContract(request, client, freelancer, service);

  await openAs(page, freelancer, `/contratos/${id}`);
  await settled(page);
  await page.getByRole('button', { name: 'Desistir' }).click();
  const dialog = page.getByRole('dialog', { name: 'Desistir da contratação' });
  await expect(dialog.getByTestId('cancel-body')).toContainText(
    /Tudo o que está em garantia \(R\$\s200,00\) volta para o cliente/,
  );
  await axeClean(page, '[data-testid="cancel-modal"]');
  await dialog.getByRole('button', { name: 'Desistir' }).click();
  await expect(page.locator('.toast', { hasText: 'Você desistiu.' })).toBeVisible();
  expect(await wallet(request, client)).toMatchObject({ balance: 200, balancePending: 0 });
  expect(await wallet(request, freelancer)).toMatchObject({ balance: 0, balancePending: 0 });

  await expect
    .poll(async () => {
      const list = (await (
        await request.get('/api/notifications', { headers: h(client.token) })
      ).json()) as { items: { type: string; title: string }[] };
      return list.items.find((n) => n.type === 'contract_cancelled')?.title ?? '';
    })
    .toBe(`O freelancer desistiu: ${service.title}`);
});

test('entregue: a Sala diz até quando aprovar; em revisão não há Cancelar e o prazo não cobra', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 200);
  const client = await createUser(request, 'client');
  const id = await acceptedContract(request, client, freelancer, service);
  const del = await request.post(`/api/contracts/${id}/deliver`, {
    headers: h(freelancer.token),
    data: { message: 'Vídeo entregue na pasta combinada.' },
  });
  expect(del.ok(), await del.text()).toBeTruthy();

  await openAs(page, client, `/contratos/${id}`);
  await settled(page);
  await expect(page.getByTestId('approval-due')).toContainText(
    'Entrega registrada. Aprove, peça revisão ou abra disputa até',
  );
  await expect(page.getByTestId('approval-due')).toContainText(
    'o pagamento é liberado ao freelancer',
  );

  const rev = await request.post(`/api/contracts/${id}/request-revision`, {
    headers: h(client.token),
    data: { note: 'Falta a versão quadrada' },
  });
  expect(rev.ok(), await rev.text()).toBeTruthy();
  await page.reload();
  await settled(page);
  await expect(page.getByTestId('deadline-met')).toContainText(
    'o prazo não abre mais disputa sozinho.',
  );
  // Desde quando a revisão está pedida, e que nada muda sozinho (ADR 58, RN-081).
  await expect(page.getByTestId('revision-since')).toContainText('Revisão pedida em');
  await expect(page.getByTestId('revision-since')).toContainText(
    'se ela não vier em 7 dias, o Escambo lembra vocês dois, uma vez.',
  );
  await expect(page.getByRole('button', { name: 'Cancelar', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Abrir disputa' })).toBeVisible();

  await openAs(page, freelancer, `/contratos/${id}`);
  await settled(page);
  await expect(page.getByRole('button', { name: 'Desistir' })).toHaveCount(0);
  await expect(page.getByTestId('revision-since')).toContainText(': registre a nova entrega.');
});

test('prazo vencido: horas do aviso e da disputa; valor que mudou no meio é recusado', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 200);
  const client = await createUser(request, 'client');
  const id = await acceptedContract(request, client, freelancer, service);

  // O servidor está em "early" (50%); a tela recebe a carência correndo e 100% no cancelamento.
  // O estado real fica coberto pela integração; aqui é a apresentação e a recusa do valor velho.
  await page.route(new RegExp(`/api/contracts/${id}$`), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.deadline = {
      ...body.deadline,
      state: 'grace',
      noticeAt: '2026-10-03T12:03:00.000Z',
      mediationAt: '2026-10-04T12:03:00.000Z',
    };
    body.cancellation = {
      ...body.cancellation,
      stage: 'overdue',
      refundPercentage: 100,
      refundClient: 200,
      releaseFreelancer: 0,
    };
    await route.fulfill({ response: res, json: body });
  });
  await openAs(page, client, `/contratos/${id}`);
  await settled(page);
  await expect(page.getByTestId('deadline-state')).toHaveText('vencido');
  await expect(page.getByTestId('deadline-late')).toContainText(
    'Você pode cancelar com reembolso integral, ou esperar: sem entrega nem extensão aceita até dom, 04/10, às 09:03, a disputa abre sozinha',
  );
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancelar contratação' });
  await expect(dialog.getByTestId('cancel-body')).toContainText(
    /O prazo venceu com trabalho nunca entregue: cancelando agora, R\$\s200,00 volta para a sua carteira/,
  );
  await dialog.getByRole('button', { name: 'Cancelar e receber de volta' }).click();
  await expect(
    page.locator('.toast', { hasText: 'O valor do cancelamento mudou desde que você abriu' }),
  ).toBeVisible();
  const detail = (await (
    await request.get(`/api/contracts/${id}`, { headers: h(client.token) })
  ).json()) as { status: string };
  expect(detail.status).toBe('accepted');
  expect(await wallet(request, client)).toMatchObject({ balance: 0 });

  await openAs(page, freelancer, `/contratos/${id}`);
  await settled(page);
  await expect(page.getByTestId('deadline-late')).toContainText(
    'Prazo vencido. Até dom, 04/10, às 09:03: registre a entrega ou peça a extensão, senão a disputa abre sozinha',
  );
});
