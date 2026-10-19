import type { APIRequestContext, Locator, Page } from '@playwright/test';
import type {
  ContractWithHistory,
  CreateContractRequest,
  Paginated,
  PlatformSetting,
  Wallet,
  WalletTransaction,
} from '@escambo/types';
import { expect, test } from '@playwright/test';
import {
  createAdmin,
  createService,
  createUser,
  deadlineTextPlus,
  inputDatePlus,
  openAs,
  settled,
  topUp,
  type TestUser,
} from './helpers';

/** RN-030: ofertas reais, reserva da última oferta do cliente e aceite em desktop/mobile. */
const h = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

async function fitsViewport(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'Sala e modal sem rolagem horizontal').toBeLessThanOrEqual(0);
}

async function read<T>(request: APIRequestContext, user: TestUser, path: string): Promise<T> {
  const res = await request.get(`/api${path}`, { headers: h(user) });
  expect(res.ok(), `GET ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

async function propose(
  request: APIRequestContext,
  client: TestUser,
  data: CreateContractRequest,
): Promise<ContractWithHistory> {
  const res = await request.post('/api/contracts', { headers: h(client), data });
  expect(res.ok(), `POST /contracts → ${res.status()} ${await res.text()}`).toBeTruthy();
  const { id } = (await res.json()) as { id: number };
  return read(request, client, `/contracts/${id}`);
}

async function counterInRoom(
  page: Page,
  user: TestUser,
  id: number,
  nextSeq: number,
  price: number,
  edit?: (modal: Locator) => Promise<void>,
): Promise<void> {
  await openAs(page, user, `/contratos/${id}`);
  await settled(page);
  await page.getByRole('button', { name: 'Contrapropor', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel(/Valor \(R\$\)|Valor em créditos/).fill(String(price));
  if (edit) await edit(modal);
  await modal
    .getByLabel(/O que muda e por quê/)
    .fill(`Ajuste de escopo e prazo explicado na oferta ${nextSeq}.`);
  await fitsViewport(page);
  await modal.getByRole('button', { name: 'Enviar contraproposta', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('negotiation').locator('summary')).toHaveText(
    `Como a proposta foi negociada (${nextSeq} ofertas)`,
  );
}

const endOfDayPlus = (days: number): string =>
  new Date(`${inputDatePlus(days)}T23:59:59-03:00`).toISOString();

test('dinheiro: cinco ofertas, reserva ajustada só pelo cliente e aceite com a taxa original', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 200);
  const client = await createUser(request, 'client');
  const admin = await createAdmin(request);
  await topUp(request, client, 1000);
  const original = await propose(request, client, {
    freelancerId: freelancer.id,
    serviceId: service.id,
    title: service.title,
    description: 'Negociação em três rodadas, sem alterar o escopo da contratação.',
    price: 200,
    deadlineAt: endOfDayPlus(10),
  });
  const pct = original.negotiation!.feePercentage!;
  const net = (price: number): number => (Math.round(price * 100) - Math.round(price * pct)) / 100;
  const settings = await read<PlatformSetting[]>(request, admin, '/admin/settings');
  const originalSetting = settings.find((setting) => setting.key === 'platform_fee_percentage')!;
  const setFee = async (value: number | boolean): Promise<void> => {
    const res = await request.put('/api/admin/settings/platform_fee_percentage', {
      headers: h(admin),
      data: { value },
    });
    expect(res.ok(), `Alteração da taxa → ${res.status()} ${await res.text()}`).toBeTruthy();
  };

  try {
    // Uma mudança administrativa depois da proposta não pode mudar suas ofertas seguintes.
    await setFee(pct < 45 ? pct + 5 : pct - 5);
    for (const [user, seq, price, held] of [
      [freelancer, 2, 250, 200],
      [client, 3, 225, 225],
      [freelancer, 4, 210, 225],
      [client, 5, 190, 190],
    ] as const) {
      await counterInRoom(page, user, original.id, seq, price);
      const current = await read<ContractWithHistory>(request, client, `/contracts/${original.id}`);
      expect(current).toMatchObject({
        status: 'pending',
        price: held,
        title: original.title,
        description: original.description,
        paymentMode: 'cash',
        negotiation: {
          seq,
          feePercentage: pct,
          current: { price, freelancerNet: net(price), platformFee: price - net(price) },
        },
      });
      expect(await read<Wallet>(request, client, '/wallet')).toMatchObject({
        balance: 1000 - held,
        balancePending: held,
      });
      expect(await read<Wallet>(request, freelancer, '/wallet')).toMatchObject({
        balance: 0,
        balancePending: 0,
      });
    }

    await openAs(page, freelancer, `/contratos/${original.id}`);
    await settled(page);
    await expect(page.getByTestId('negotiation').getByRole('heading')).toHaveText(
      'Negociação · rodada 3 de 3',
    );
    await expect(page.getByTestId('proposal-due')).toContainText('Esta é a oferta final');
    await fitsViewport(page);
    await expect(page.getByRole('button', { name: 'Contrapropor', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Aceitar', exact: true }).click();
    await expect(page.getByTestId('payment-state')).toHaveText(
      'Valor em escrow · liberado na aprovação',
    );
    const accepted = await read<ContractWithHistory>(request, client, `/contracts/${original.id}`);
    expect(accepted).toMatchObject({
      status: 'accepted',
      price: 190,
      freelancerNet: net(190),
      platformFee: 190 - net(190),
      negotiation: null,
    });
    expect(accepted.offers!.map(({ seq, madeBy, outcome }) => ({ seq, madeBy, outcome }))).toEqual([
      { seq: 1, madeBy: 'client', outcome: 'countered' },
      { seq: 2, madeBy: 'freelancer', outcome: 'countered' },
      { seq: 3, madeBy: 'client', outcome: 'countered' },
      { seq: 4, madeBy: 'freelancer', outcome: 'countered' },
      { seq: 5, madeBy: 'client', outcome: 'accepted' },
    ]);
    await page.getByTestId('negotiation').locator('summary').click();
    await expect(
      page.getByTestId('negotiation').getByText('Aceita', { exact: true }),
    ).toBeVisible();
    expect(await read<Wallet>(request, client, '/wallet')).toMatchObject({
      balance: 810,
      balancePending: 0,
    });
    expect(await read<Wallet>(request, freelancer, '/wallet')).toMatchObject({
      balance: 0,
      balancePending: net(190),
    });
    const ledger = await read<Paginated<WalletTransaction>>(
      request,
      client,
      '/wallet/transactions?limit=100',
    );
    expect(
      ledger.items
        .filter((entry) => entry.contractId === original.id)
        .map(({ reason, amount, pendingDelta }) => ({ reason, amount, pendingDelta })),
    ).toEqual([
      { reason: 'payment', amount: 0, pendingDelta: -190 },
      { reason: 'hold_release', amount: 35, pendingDelta: -35 },
      { reason: 'hold', amount: -25, pendingDelta: 25 },
      { reason: 'hold', amount: -200, pendingDelta: 200 },
    ]);
  } finally {
    await setFee(originalSetting.value);
  }
});

test('créditos: contraproposta sem reserva e aceite do cliente retém o valor sem taxa', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 60);
  const client = await createUser(request, 'client');
  expect(await read<Wallet>(request, client, '/wallet')).toMatchObject({ credits: 100 });
  const original = await propose(request, client, {
    freelancerId: freelancer.id,
    serviceId: service.id,
    title: service.title,
    description: 'Oferta de serviço paga em créditos, com contraproposta de valor inteiro.',
    price: 60,
    paymentMode: 'credits',
  });
  await counterInRoom(page, freelancer, original.id, 2, 80);
  expect(await read<Wallet>(request, client, '/wallet')).toMatchObject({
    credits: 100,
    creditsPending: 0,
    balance: 0,
    balancePending: 0,
  });
  expect(await read<Wallet>(request, freelancer, '/wallet')).toMatchObject({
    credits: 100,
    creditsPending: 0,
  });

  await openAs(page, client, `/contratos/${original.id}`);
  await settled(page);
  await page.getByRole('button', { name: 'Aceitar contraproposta', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal).toContainText('80 créditos serão debitados');
  await expect(modal.getByTestId('reserve-preview')).toHaveCount(0);
  await fitsViewport(page);
  await modal.getByRole('button', { name: 'Aceitar e contratar', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('payment-state')).toHaveText(
    'Créditos em escrow · liberado na aprovação',
  );
  expect(
    await read<ContractWithHistory>(request, client, `/contracts/${original.id}`),
  ).toMatchObject({
    status: 'accepted',
    price: 80,
    platformFee: 0,
    freelancerNet: 80,
    paymentMode: 'credits',
    negotiation: null,
    offers: [
      { seq: 1, outcome: 'countered', price: 60 },
      { seq: 2, outcome: 'accepted', price: 80 },
    ],
  });
  expect(await read<Wallet>(request, client, '/wallet')).toMatchObject({
    credits: 20,
    creditsPending: 0,
    balance: 0,
    balancePending: 0,
  });
  expect(await read<Wallet>(request, freelancer, '/wallet')).toMatchObject({
    credits: 100,
    creditsPending: 80,
    balance: 0,
    balancePending: 0,
  });
});

test('marcos: soma inválida impede envio, contraproposta preserva marcos e aceite ajusta a reserva', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 300);
  const client = await createUser(request, 'client');
  await topUp(request, client, 500);
  const original = await propose(request, client, {
    freelancerId: freelancer.id,
    serviceId: service.id,
    title: service.title,
    description: 'Dois marcos de entrega cuja identidade permanece na negociação.',
    price: 300,
    deadlineAt: endOfDayPlus(10),
    milestones: [
      { title: 'Layout', amount: 150, dueAt: endOfDayPlus(5) },
      { title: 'Publicação', amount: 150, dueAt: endOfDayPlus(10) },
    ],
  });
  await counterInRoom(page, freelancer, original.id, 2, 360, async (modal) => {
    await expect(modal.getByLabel('Título do marco 1')).toHaveCount(0);
    await expect(modal).toContainText('1. Layout');
    await expect(modal).toContainText('2. Publicação');
    await modal.getByLabel(/O que muda e por quê/).fill('Mais tempo e trabalho em cada entrega.');
    await expect(modal).toContainText('A soma dos marcos deve ser igual ao valor da proposta.');
    await expect(modal.getByRole('button', { name: 'Enviar contraproposta' })).toBeDisabled();
    await modal.getByLabel('Prazo de entrega').fill(inputDatePlus(12));
    await modal.getByLabel('Valor do marco 1').fill('160');
    await modal.getByLabel('Valor do marco 2').fill('200');
    await modal.getByLabel('Prazo do marco 1').fill(inputDatePlus(6));
    await modal.getByLabel('Prazo do marco 2').fill(inputDatePlus(12));
  });
  const offered = await read<ContractWithHistory>(request, client, `/contracts/${original.id}`);
  const identities = original.milestones.map(({ id, title }) => ({ id, title }));
  expect(offered.milestones.map(({ id, title }) => ({ id, title }))).toEqual(identities);
  expect(offered.negotiation!.current!.milestones!.map(({ id, title }) => ({ id, title }))).toEqual(
    identities,
  );
  expect(offered.negotiation!.current).toMatchObject({
    price: 360,
    deadlineAt: endOfDayPlus(12),
    milestones: [
      { ...identities[0], amount: 160, dueAt: endOfDayPlus(6) },
      { ...identities[1], amount: 200, dueAt: endOfDayPlus(12) },
    ],
  });
  expect(await read<Wallet>(request, client, '/wallet')).toMatchObject({
    balance: 200,
    balancePending: 300,
  });

  await openAs(page, client, `/contratos/${original.id}`);
  await settled(page);
  await page.getByRole('button', { name: 'Aceitar contraproposta', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByTestId('reserve-preview')).toContainText('mais R$ 60,00 será reservado');
  await expect(modal).toContainText('Layout');
  await expect(modal).toContainText('R$ 160,00');
  await expect(modal).toContainText('Publicação');
  await expect(modal).toContainText('R$ 200,00');
  await fitsViewport(page);
  await modal.getByRole('button', { name: 'Aceitar e contratar', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('payment-state')).toHaveText('Em escrow · liberado marco a marco');
  const accepted = await read<ContractWithHistory>(request, client, `/contracts/${original.id}`);
  expect(accepted).toMatchObject({
    status: 'accepted',
    price: 360,
    deadlineAt: endOfDayPlus(12),
    milestones: [
      { ...identities[0], amount: 160, dueAt: endOfDayPlus(6), status: 'funded' },
      { ...identities[1], amount: 200, dueAt: endOfDayPlus(12), status: 'funded' },
    ],
  });
  expect(await read<Wallet>(request, client, '/wallet')).toMatchObject({
    balance: 140,
    balancePending: 0,
  });
  expect(await read<Wallet>(request, freelancer, '/wallet')).toMatchObject({
    balance: 0,
    balancePending: accepted.freelancerNet,
  });
  await expect(
    page.getByTestId('milestones').getByTestId(`milestone-due-${identities[0]!.id}`),
  ).toContainText(deadlineTextPlus(6));
  await expect(
    page.getByTestId('milestones').getByTestId(`milestone-due-${identities[1]!.id}`),
  ).toContainText(deadlineTextPlus(12));
});
