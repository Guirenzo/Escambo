import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authRepository } from '../auth/auth.repository';
import { notificationsService } from '../notifications/notifications.service';
import { settingsRepository } from '../settings/settings.repository';
import { settingsService } from '../settings/settings.service';
import { walletService } from '../wallet/wallet.service';
import { setClockForTests } from '../../utils/clock';
import { contractsRepository, type ContractRow } from './contracts.repository';
import { contractsService } from './contracts.service';
import { milestonesRepository, type MilestoneRow } from './milestones.repository';
import { offersRepository, type OfferRow } from './offers.repository';
import type { CounterOfferInput } from './contracts.schema';

vi.mock('./contracts.repository', () => ({
  contractsRepository: {
    findById: vi.fn(),
    transition: vi.fn(),
    listHistory: vi.fn(),
  },
}));
vi.mock('./offers.repository', () => ({
  offersRepository: { list: vi.fn(), counter: vi.fn() },
  offerMilestones: (row: { milestones: unknown }) =>
    typeof row.milestones === 'string' ? JSON.parse(row.milestones) : row.milestones,
  toOffer: vi.fn(),
}));
vi.mock('./milestones.repository', () => ({
  milestonesRepository: {
    listForContract: vi.fn(),
    escrowRemaining: vi.fn(),
    titlesByDelivery: vi.fn(),
  },
}));
vi.mock('../settings/settings.repository', () => ({ settingsRepository: { getNumber: vi.fn() } }));
vi.mock('../settings/settings.service', () => ({
  settingsService: { number: vi.fn(), feeRate: vi.fn() },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));
vi.mock('../wallet/wallet.service', () => ({ walletService: { ensure: vi.fn() } }));
vi.mock('../auth/auth.repository', () => ({ authRepository: { findById: vi.fn() } }));
vi.mock('../auth/user-zone', () => ({ userZone: vi.fn() }));
vi.mock('../profiles/profiles.repository', () => ({
  profilesRepository: { findFreelancerByUserId: vi.fn() },
}));
vi.mock('../services/services.repository', () => ({ servicesRepository: { findById: vi.fn() } }));
vi.mock('../reviews/reviews.repository', () => ({
  reviewsRepository: { findByContractIdWithResponse: vi.fn() },
}));
vi.mock('../barter/barter.service', () => ({ barterService: {} }));
vi.mock('../gamification/gamification.service', () => ({ gamificationService: {} }));

const repo = vi.mocked(contractsRepository);
const offers = vi.mocked(offersRepository);
const milestones = vi.mocked(milestonesRepository);
const notifications = vi.mocked(notificationsService);
const wallets = vi.mocked(walletService);
const users = vi.mocked(authRepository);
const NOW = new Date('2026-10-08T15:00:00Z');
const RESPOND = new Date('2026-10-10T15:00:00Z');
const DEADLINE = new Date('2026-10-21T02:59:59Z');
const ID = 7;
const CLIENT = 1;
const FREELANCER = 2;

const row = (extra: Record<string, unknown> = {}): ContractRow =>
  ({
    id: ID,
    ulid: '01CONTRACT0000000000000007',
    client_id: CLIENT,
    freelancer_id: FREELANCER,
    title: 'Logo nova',
    description: 'Termos da negociação',
    service_id: null,
    price: '500.00',
    platform_fee: '75.00',
    freelancer_net: '425.00',
    fee_percentage: null,
    offer_seq: 1,
    status: 'pending',
    payment_mode: 'cash',
    barter_agreement_id: null,
    deadline_at: null,
    proposal_expires_at: RESPOND,
    accepted_at: null,
    completed_at: null,
    cancelled_at: null,
    created_at: new Date('2026-10-01T15:00:00Z'),
    extension_status: 'none',
    extension_requests: 0,
    extension_requested_at: null,
    extension_deadline_at: null,
    extension_respond_by: null,
    extension_resolved_at: null,
    overdue_notified_at: null,
    grace_ends_at: null,
    approval_due_at: null,
    revision_requested_at: null,
    revision_limit: null,
    revisions_used: 0,
    first_delivery_at: null,
    first_delivered_at: null,
    delivery_dispute_opens_at: null,
    next_milestone_approval_at: null,
    next_milestone_dispute_opens_at: null,
    has_milestones: 0,
    total_milestones: 0,
    undelivered_milestones: 0,
    delivered_awaiting: 0,
    in_revision: 0,
    deliveries_count: 0,
    client_timezone: 'America/Sao_Paulo',
    freelancer_timezone: 'America/Sao_Paulo',
    ...extra,
  }) as unknown as ContractRow;
const offer = (extra: Record<string, unknown> = {}): OfferRow =>
  ({
    id: 70,
    contract_id: ID,
    seq: 2,
    made_by: 'freelancer',
    price: '650.00',
    platform_fee: '97.50',
    freelancer_net: '552.50',
    deadline_at: null,
    milestones: null,
    message: 'Incluí a ilustração.',
    respond_by: RESPOND,
    outcome: 'open',
    created_at: NOW,
    resolved_at: null,
    ...extra,
  }) as unknown as OfferRow;
const marco = (id: number, extra: Record<string, unknown> = {}): MilestoneRow =>
  ({
    id,
    contract_id: ID,
    title: `Marco ${id}`,
    amount: '250.00',
    freelancer_net: '212.50',
    sort_order: id,
    status: 'pending',
    due_at: null,
    ...extra,
  }) as unknown as MilestoneRow;
const input = (extra: Partial<CounterOfferInput> = {}): CounterOfferInput => ({
  seq: 1,
  price: 650,
  deadlineAt: null,
  message: '  Incluí a ilustração.  ',
  ...extra,
});
const expectNoWrites = () => {
  expect(offers.counter).not.toHaveBeenCalled();
  expect(repo.transition).not.toHaveBeenCalled();
  expect(wallets.ensure).not.toHaveBeenCalled();
  expect(notifications.notify).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.resetAllMocks();
  setClockForTests(NOW, { frozen: true });
  repo.findById.mockResolvedValue(row());
  repo.transition.mockResolvedValue(true);
  repo.listHistory.mockResolvedValue([]);
  offers.list.mockResolvedValue([]);
  offers.counter.mockResolvedValue('ok');
  milestones.listForContract.mockResolvedValue([]);
  milestones.escrowRemaining.mockResolvedValue(null);
  vi.mocked(settingsRepository).getNumber.mockImplementation(async (_key, fallback) => fallback);
  vi.mocked(settingsService).number.mockResolvedValue(24);
  vi.mocked(settingsService).feeRate.mockResolvedValue(0.2);
  users.findById.mockResolvedValue({
    id: FREELANCER,
    role: 'freelancer',
    status: 'active',
    deleted_at: null,
  } as never);
  wallets.ensure.mockResolvedValue(undefined);
  notifications.notify.mockResolvedValue(undefined);
  vi.spyOn(contractsService, 'getById').mockResolvedValue({ id: ID } as never);
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

describe('RN-030: envio de contrapropostas', () => {
  it('freelancer não aceita sua própria contraproposta par, sem transição, carteira ou aviso', async () => {
    repo.findById.mockResolvedValue(row({ offer_seq: 2 }));
    offers.list.mockResolvedValue([offer()]);

    await expect(contractsService.accept(ID, FREELANCER, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'not_your_turn',
    });
    expectNoWrites();
  });

  it.each([
    [1, CLIENT, 1, 'not_your_turn'],
    [2, FREELANCER, 2, 'not_your_turn'],
    [2, CLIENT, 1, 'offer_changed'],
    [5, FREELANCER, 5, 'offer_limit'],
  ])(
    'estado oferta%s/ator%s/body%s rejeita %s antes de escrever',
    async (seq, uid, bodySeq, code) => {
      repo.findById.mockResolvedValue(row({ offer_seq: seq }));
      await expect(
        contractsService.counter(ID, Number(uid), input({ seq: Number(bodySeq) })),
      ).rejects.toMatchObject({ statusCode: 409, code });
      expectNoWrites();
    },
  );

  it.each([
    ['participante alheio', {}, 99, 403, 'forbidden'],
    ['contrato aceito', { status: 'accepted' }, FREELANCER, 409, 'invalid_transition'],
    ['troca', { barter_agreement_id: 4 }, FREELANCER, 409, 'invalid_transition'],
    ['validade no limite exato', { proposal_expires_at: NOW }, FREELANCER, 409, 'proposal_expired'],
  ])('%s rejeita sem financeiro nem aviso', async (_case, fields, uid, statusCode, code) => {
    repo.findById.mockResolvedValue(row(fields as Record<string, unknown>));
    await expect(contractsService.counter(ID, Number(uid), input())).rejects.toMatchObject({
      statusCode,
      code,
    });
    expectNoWrites();
  });

  it('freelancer contrapõe sem alterar carteira, usando taxa histórica15% apesar do painel20%', async () => {
    await contractsService.counter(ID, FREELANCER, input());
    expect(offers.counter).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: expect.objectContaining({ price: '500.00', offer_seq: 1 }),
        terms: { price: 650, fee: 97.5, net: 552.5, milestones: null },
        pct: 15,
        respondBy: RESPOND,
        deadlineAt: null,
        uid: FREELANCER,
        now: NOW,
        message: 'Incluí a ilustração.',
      }),
    );
    expect(wallets.ensure).not.toHaveBeenCalled();
    expect(vi.mocked(settingsService).feeRate).not.toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({
        type: 'contract_counter_offer',
        title: 'Contraproposta: Logo nova',
        body: expect.stringContaining('o freelancer propõe R$ 650,00'),
      }),
      {},
    );
  });

  it('cliente contrapõe650→600 sem recalcular a reserva anterior500; ensure vem antes do repository', async () => {
    repo.findById.mockResolvedValue(row({ offer_seq: 2 }));
    offers.list.mockResolvedValue([offer()]);
    await contractsService.counter(ID, CLIENT, input({ seq: 2, price: 600 }));
    expect(wallets.ensure.mock.calls).toEqual([[CLIENT]]);
    expect(wallets.ensure.mock.invocationCallOrder[0]!).toBeLessThan(
      offers.counter.mock.invocationCallOrder[0]!,
    );
    expect(offers.counter.mock.calls[0]![0]).toMatchObject({
      expected: { price: '500.00' },
      terms: { price: 600, fee: 90, net: 510 },
      uid: CLIENT,
    });
    expect(notifications.notify).toHaveBeenCalledWith(
      FREELANCER,
      expect.objectContaining({ title: 'Contraproposta do cliente: Logo nova' }),
      {},
    );
  });

  it('é possível trocar prazo vencido da entrega se a resposta continua válida', async () => {
    repo.findById.mockResolvedValue(row({ deadline_at: new Date('2026-10-01T02:59:59Z') }));
    await contractsService.counter(ID, FREELANCER, input({ deadlineAt: DEADLINE.toISOString() }));
    expect(offers.counter.mock.calls[0]![0].deadlineAt).toEqual(DEADLINE);
  });

  it.each([
    ['introduz prazo', null, DEADLINE.toISOString()],
    ['remove prazo', DEADLINE, null],
  ])('não %s no meio da negociação', async (_case, before, after) => {
    repo.findById.mockResolvedValue(row({ deadline_at: before }));
    await expect(
      contractsService.counter(ID, FREELANCER, input({ deadlineAt: after })),
    ).rejects.toMatchObject({ statusCode: 422, code: 'offer_shape' });
    expectNoWrites();
  });

  it('mesmos termos não geram nova oferta mesmo quando a mensagem muda', async () => {
    await expect(
      contractsService.counter(ID, FREELANCER, input({ price: 500, message: 'Texto diferente.' })),
    ).rejects.toMatchObject({ statusCode: 422, code: 'offer_unchanged' });
    expectNoWrites();
  });

  it('compara com a oferta vigente do freelancer, não com os500 reservados', async () => {
    repo.findById.mockResolvedValue(row({ offer_seq: 2 }));
    offers.list.mockResolvedValue([offer()]);
    await expect(
      contractsService.counter(ID, CLIENT, input({ seq: 2, price: 650 })),
    ).rejects.toMatchObject({ code: 'offer_unchanged' });
    expectNoWrites();
  });

  it.each([{ rows: [] }, { rows: [offer({ outcome: 'closed' })] }])(
    'oferta corrente ausente/encerrada dá409, sem substituir por termos reservados: $rows',
    async ({ rows }) => {
      repo.findById.mockResolvedValue(row({ offer_seq: 2 }));
      offers.list.mockResolvedValue(rows as OfferRow[]);
      await expect(
        contractsService.counter(ID, CLIENT, input({ seq: 2, price: 600 })),
      ).rejects.toMatchObject({ code: 'offer_changed' });
      expectNoWrites();
    },
  );

  it.each([
    ['remove marcos', undefined],
    [
      'troca ids',
      [
        { id: 12, amount: 300, dueAt: null },
        { id: 11, amount: 350, dueAt: null },
      ],
    ],
    [
      'adiciona marco',
      [
        { id: 11, amount: 200, dueAt: null },
        { id: 12, amount: 200, dueAt: null },
        { id: 13, amount: 250, dueAt: null },
      ],
    ],
  ])('%s viola a forma e a ordem da contratação', async (_case, next) => {
    milestones.listForContract.mockResolvedValue([marco(11), marco(12)]);
    await expect(
      contractsService.counter(ID, FREELANCER, input({ milestones: next })),
    ).rejects.toMatchObject({ code: 'offer_shape' });
    expectNoWrites();
  });

  it('preserva títulos dos marcos e rateia o líquido novo em centavos', async () => {
    milestones.listForContract.mockResolvedValue([
      marco(11, { title: 'Rascunho' }),
      marco(12, { title: 'Arte final' }),
    ]);
    await contractsService.counter(
      ID,
      FREELANCER,
      input({
        milestones: [
          { id: 11, amount: 300, dueAt: null },
          { id: 12, amount: 350, dueAt: null },
        ],
      }),
    );
    expect(offers.counter.mock.calls[0]![0].terms.milestones).toEqual([
      { id: 11, title: 'Rascunho', amount: 300, freelancerNet: 255, dueAt: null },
      { id: 12, title: 'Arte final', amount: 350, freelancerNet: 297.5, dueAt: null },
    ]);
    expect(notifications.notify.mock.calls[0]![1].body).toContain('(2 marcos)');
  });

  it.each([
    ['hora fora do fim do dia', '2026-10-20T15:00:00Z'],
    ['dia já passado', '2026-10-01T02:59:59Z'],
  ])('%s não vira prazo gravado', async (_case, deadlineAt) => {
    repo.findById.mockResolvedValue(row({ deadline_at: DEADLINE }));
    await expect(
      contractsService.counter(ID, FREELANCER, input({ deadlineAt })),
    ).rejects.toMatchObject({ code: 'offer_deadline_invalid' });
    expectNoWrites();
  });

  it('a resposta segue horas do painel e o fuso do CLIENTE na oferta par', async () => {
    repo.findById.mockResolvedValue(row({ client_timezone: 'America/Rio_Branco' }));
    vi.mocked(settingsRepository).getNumber.mockResolvedValue(72);
    await contractsService.counter(ID, FREELANCER, input());
    expect(vi.mocked(settingsRepository).getNumber).toHaveBeenCalledWith(
      'counter_offer_response_hours',
      48,
    );
    expect(offers.counter.mock.calls[0]![0].respondBy).toEqual(new Date('2026-10-11T15:00:00Z'));
    expect(notifications.notify.mock.calls[0]![1].body).toContain('dom, 11/10 às 10:00');
  });

  it.each(['client', 'freelancer'] as const)(
    'respond_by usa o fuso de quem responde quando %s propõe à noite no próprio fuso',
    async (proposer) => {
      const now = new Date('2026-10-08T23:45:00Z');
      setClockForTests(now, { frozen: true });
      const clientProposes = proposer === 'client';
      repo.findById.mockResolvedValue(
        row({
          offer_seq: clientProposes ? 2 : 1,
          client_timezone: clientProposes ? 'America/Sao_Paulo' : 'America/Rio_Branco',
          freelancer_timezone: clientProposes ? 'America/Rio_Branco' : 'America/Sao_Paulo',
        }),
      );
      if (clientProposes) offers.list.mockResolvedValue([offer()]);

      await contractsService.counter(
        ID,
        clientProposes ? CLIENT : FREELANCER,
        input({ seq: clientProposes ? 2 : 1, price: clientProposes ? 600 : 650 }),
      );

      // 20:45 para quem propõe; 18:45 para quem responde. O destinatário pode
      // responder até 18:45 dois dias depois, sem adiar para a manhã seguinte.
      expect(offers.counter.mock.calls[0]![0].respondBy).toEqual(new Date('2026-10-10T23:45:00Z'));
    },
  );

  it('prazo menos de uma hora para resposta é rejeitado', async () => {
    setClockForTests(new Date('2026-10-08T23:00:00Z'), { frozen: true });
    repo.findById.mockResolvedValue(row({ deadline_at: new Date('2026-10-09T02:59:59Z') }));
    await expect(
      contractsService.counter(ID, FREELANCER, input({ deadlineAt: '2026-10-09T02:59:59Z' })),
    ).rejects.toMatchObject({ code: 'deadline_too_soon' });
    expectNoWrites();
  });

  it('créditos rejeitam fração e os termos aceitos não cobram taxa nem reservam dinheiro', async () => {
    repo.findById.mockResolvedValue(
      row({
        payment_mode: 'credits',
        price: '10.00',
        platform_fee: '0.00',
        freelancer_net: '10.00',
      }),
    );
    await expect(
      contractsService.counter(ID, FREELANCER, input({ price: 12.5 })),
    ).rejects.toMatchObject({ code: 'invalid_offer' });
    expectNoWrites();
    await contractsService.counter(ID, FREELANCER, input({ price: 12 }));
    expect(offers.counter.mock.calls[0]![0].terms).toEqual({
      price: 12,
      fee: 0,
      net: 12,
      milestones: null,
    });
    expect(wallets.ensure).not.toHaveBeenCalled();
  });

  it.each([
    ['insufficient', 402, 'insufficient_balance'],
    ['changed', 409, 'offer_changed'],
  ] as const)('repository%s rejeita sem emitir aviso', async (result, statusCode, code) => {
    offers.counter.mockResolvedValue(result);
    await expect(contractsService.counter(ID, FREELANCER, input())).rejects.toMatchObject({
      statusCode,
      code,
    });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('aviso aguarda o resultado da transação; falha da transação não anuncia sucesso', async () => {
    let reject!: (error: Error) => void;
    offers.counter.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const action = contractsService.counter(ID, FREELANCER, input());
    const rejected = expect(action).rejects.toThrow('COMMIT falhou');
    await vi.waitFor(() => expect(offers.counter).toHaveBeenCalledOnce());
    expect(notifications.notify).not.toHaveBeenCalled();
    reject(new Error('COMMIT falhou'));
    await rejected;
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('notifica sucesso uma única vez depois de a transação de contraproposta resolver', async () => {
    let commit!: (value: 'ok') => void;
    offers.counter.mockImplementation(
      () =>
        new Promise((resolve) => {
          commit = resolve;
        }),
    );
    const action = contractsService.counter(ID, FREELANCER, input());
    await vi.waitFor(() => expect(offers.counter).toHaveBeenCalledOnce());
    expect(notifications.notify).not.toHaveBeenCalled();
    commit('ok');
    await action;
    expect(notifications.notify).toHaveBeenCalledOnce();
  });

  it('erro da taxa histórica falha antes de garantir carteira ou gravar oferta', async () => {
    repo.findById.mockResolvedValue(
      row({ offer_seq: 2, fee_percentage: '15.00', platform_fee: '100.00' }),
    );
    offers.list.mockResolvedValue([offer()]);
    await expect(
      contractsService.counter(ID, CLIENT, input({ seq: 2, price: 600 })),
    ).rejects.toMatchObject({ code: 'offer_fee_invalid' });
    expectNoWrites();
  });

  it('oferta vigente vencida também impede contrapropor quando o espelho legado ainda aponta o futuro', async () => {
    repo.findById.mockResolvedValue(row({ offer_seq: 2 }));
    offers.list.mockResolvedValue([offer({ respond_by: NOW })]);
    await expect(
      contractsService.counter(ID, CLIENT, input({ seq: 2, price: 600 })),
    ).rejects.toMatchObject({ code: 'proposal_expired' });
    expectNoWrites();
  });
});

describe('RN-030: cliente aceita a oferta do freelancer', () => {
  const setup = (extra: Record<string, unknown> = {}, offerExtra: Record<string, unknown> = {}) => {
    repo.findById.mockResolvedValue(row({ offer_seq: 2, ...extra }));
    offers.list.mockResolvedValue([offer(offerExtra)]);
  };

  it.each([
    [CLIENT, 1, 'offer_changed'],
    [FREELANCER, 2, 'forbidden'],
  ])('ator%s/body%s rejeita %s sem dinheiro', async (uid, seq, code) => {
    setup();
    await expect(
      contractsService.acceptCounter(ID, Number(uid), Number(seq)),
    ).rejects.toMatchObject({ code });
    expectNoWrites();
  });

  it('oferta ímpar não pode ser aceita pelo cliente', async () => {
    setup({ offer_seq: 3 });
    await expect(contractsService.acceptCounter(ID, CLIENT, 3)).rejects.toMatchObject({
      code: 'not_your_turn',
    });
    expectNoWrites();
  });

  it.each([
    ['ausente', null],
    ['de autoria errada', { made_by: 'client' }],
    ['encerrada', { outcome: 'accepted' }],
  ])('oferta %s dá409changed', async (_case, fields) => {
    setup();
    offers.list.mockResolvedValue(fields ? [offer(fields as Record<string, unknown>)] : []);
    await expect(contractsService.acceptCounter(ID, CLIENT, 2)).rejects.toMatchObject({
      code: 'offer_changed',
    });
    expectNoWrites();
  });

  it.each([
    ['resposta vencida', { proposal_expires_at: NOW }, {}, 'proposal_expired'],
    ['entrega vencida', {}, { deadline_at: NOW }, 'deadline_passed'],
  ])('%s na fronteira exata não contrata', async (_case, fields, terms, code) => {
    setup(fields as Record<string, unknown>, terms as Record<string, unknown>);
    await expect(contractsService.acceptCounter(ID, CLIENT, 2)).rejects.toMatchObject({ code });
    expectNoWrites();
  });

  it('validade imutável da oferta vencida não pode ser estendida só pelo espelho legado', async () => {
    setup({}, { respond_by: NOW });
    await expect(contractsService.acceptCounter(ID, CLIENT, 2)).rejects.toMatchObject({
      code: 'proposal_expired',
    });
    expectNoWrites();
  });

  it.each([
    ['ausente', undefined],
    ['excluído', { deleted_at: NOW }],
    ['suspenso', { status: 'suspended' }],
    ['banido', { status: 'banned' }],
    ['admin', { role: 'admin' }],
  ])('freelancer%s impede contratação e débito', async (_case, fields) => {
    setup();
    users.findById.mockResolvedValue(
      fields
        ? ({
            id: FREELANCER,
            role: 'freelancer',
            status: 'active',
            deleted_at: null,
            ...fields,
          } as never)
        : undefined,
    );
    await expect(contractsService.acceptCounter(ID, CLIENT, 2)).rejects.toMatchObject({
      code: 'freelancer_unavailable',
    });
    expectNoWrites();
  });

  it('freelancer pending_verification pode ter a contraproposta aceita pelo cliente', async () => {
    setup();
    users.findById.mockResolvedValue({
      id: FREELANCER,
      role: 'freelancer',
      status: 'pending_verification',
      deleted_at: null,
    } as never);
    await expect(contractsService.acceptCounter(ID, CLIENT, 2)).resolves.toMatchObject({ id: ID });
    expect(repo.transition).toHaveBeenCalledOnce();
    expect(repo.transition.mock.calls[0]![0]).toMatchObject({
      to: 'accepted',
      offerResolution: {
        activeFreelancerId: FREELANCER,
        terms: { price: 650, fee: 97.5, net: 552.5 },
      },
      walletEffects: [
        { userId: CLIENT, balanceDelta: -150, pendingDelta: 150, reason: 'hold' },
        { userId: CLIENT, balanceDelta: 0, pendingDelta: -650, reason: 'payment' },
        { userId: FREELANCER, balanceDelta: 0, pendingDelta: 552.5, reason: 'escrow_in' },
      ],
    });
    expect(notifications.notify).toHaveBeenCalledOnce();
  });

  it('falha de saldo com freelancer ainda pending_verification não vira unavailable na releitura', async () => {
    setup();
    users.findById.mockResolvedValue({
      id: FREELANCER,
      role: 'freelancer',
      status: 'pending_verification',
      deleted_at: null,
    } as never);
    repo.transition.mockResolvedValue(false);
    await expect(contractsService.acceptCounter(ID, CLIENT, 2)).rejects.toMatchObject({
      statusCode: 402,
      code: 'insufficient_balance',
    });
    expect(users.findById).toHaveBeenCalledTimes(2);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it.each([
    [
      650,
      '97.50',
      '552.50',
      { userId: CLIENT, balanceDelta: -150, pendingDelta: 150, reason: 'hold' },
    ],
    [
      450,
      '67.50',
      '382.50',
      { userId: CLIENT, balanceDelta: 50, pendingDelta: -50, reason: 'hold_release' },
    ],
  ])(
    'aceite de%s ajusta reserva500, paga com balance0 e credita escrow na ordem',
    async (price, fee, net, adjustment) => {
      setup(
        {},
        { price: String(price), platform_fee: fee, freelancer_net: net, deadline_at: DEADLINE },
      );
      await contractsService.acceptCounter(ID, CLIENT, 2);
      expect(wallets.ensure.mock.calls).toEqual([[CLIENT], [FREELANCER]]);
      expect(wallets.ensure.mock.invocationCallOrder[1]!).toBeLessThan(
        repo.transition.mock.invocationCallOrder[0]!,
      );
      const call = repo.transition.mock.calls[0]![0];
      expect(call.walletEffects).toEqual([
        adjustment,
        { userId: CLIENT, balanceDelta: 0, pendingDelta: -Number(price), reason: 'payment' },
        { userId: FREELANCER, balanceDelta: 0, pendingDelta: Number(net), reason: 'escrow_in' },
      ]);
      expect(call).toMatchObject({
        from: 'pending',
        to: 'accepted',
        timestampColumn: 'accepted_at',
        changedBy: CLIENT,
        now: NOW,
        offerResolution: {
          seq: 2,
          heldPrice: 500,
          outcome: 'accepted',
          feePercentage: 15,
          activeFreelancerId: FREELANCER,
          terms: { price: Number(price), fee: Number(fee), net: Number(net), deadlineAt: DEADLINE },
        },
      });
      expect(call.guard!.sql).toContain('c.offer_seq = :gOfferSeq AND c.price = :gHeldPrice');
      expect(call.guard!.params).toMatchObject({
        gOfferSeq: 2,
        gHeldPrice: 500,
        acceptedDeadline: DEADLINE,
      });
      expect(notifications.notify.mock.invocationCallOrder[0]!).toBeGreaterThan(
        repo.transition.mock.invocationCallOrder[0]!,
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        FREELANCER,
        expect.objectContaining({
          type: 'contract_accepted',
          title: 'Sua contraproposta foi aceita: Logo nova',
        }),
        {},
      );
    },
  );

  it('aceite em créditos move o preço da oferta12, sem hold financeiro', async () => {
    setup(
      { payment_mode: 'credits', price: '10.00', platform_fee: '0.00', freelancer_net: '10.00' },
      { price: '12.00', platform_fee: '0.00', freelancer_net: '12.00' },
    );
    await contractsService.acceptCounter(ID, CLIENT, 2);
    expect(repo.transition.mock.calls[0]![0].walletEffects).toBeUndefined();
    expect(repo.transition.mock.calls[0]![0].creditsEffects).toEqual([
      { userId: CLIENT, balanceDelta: -12, pendingDelta: 0, reason: 'escrow_hold' },
      { userId: FREELANCER, balanceDelta: 0, pendingDelta: 12, reason: 'escrow_in' },
    ]);
  });

  it('termos financeiros divergentes não são recalculados silenciosamente', async () => {
    setup({}, { platform_fee: '130.00', freelancer_net: '520.00' });
    await expect(contractsService.acceptCounter(ID, CLIENT, 2)).rejects.toMatchObject({
      code: 'offer_fee_invalid',
    });
    expectNoWrites();
  });

  it.each([
    ['cash', 402, 'insufficient_balance'],
    ['credits', 409, 'insufficient_credits'],
  ] as const)(
    'falha da carteira em%s mantém aviso silencioso e distingue insuficiente',
    async (mode, statusCode, code) => {
      setup(
        mode === 'credits'
          ? {
              payment_mode: 'credits',
              price: '10.00',
              platform_fee: '0.00',
              freelancer_net: '10.00',
            }
          : {},
        mode === 'credits' ? { price: '12.00', platform_fee: '0.00', freelancer_net: '12.00' } : {},
      );
      repo.transition.mockResolvedValue(false);
      await expect(contractsService.acceptCounter(ID, CLIENT, 2)).rejects.toMatchObject({
        statusCode,
        code,
      });
      expect(notifications.notify).not.toHaveBeenCalled();
    },
  );

  it.each([{ offer_seq: 3 }, { status: 'accepted' }, { price: '600.00' }])(
    'falhaCAS com estado novo%j dáchanged em vez de insuficiente',
    async (fresh) => {
      setup();
      repo.findById
        .mockResolvedValueOnce(row({ offer_seq: 2 }))
        .mockResolvedValueOnce(row({ offer_seq: 2, ...fresh }));
      repo.transition.mockResolvedValue(false);
      await expect(contractsService.acceptCounter(ID, CLIENT, 2)).rejects.toMatchObject({
        statusCode: 409,
        code: 'offer_changed',
      });
      expect(notifications.notify).not.toHaveBeenCalled();
    },
  );

  it('validade que vence enquanto espera a transação dáexpired em vez de insuficiente', async () => {
    setup();
    repo.transition.mockImplementation(async () => {
      setClockForTests(RESPOND, { frozen: true });
      return false;
    });
    await expect(contractsService.acceptCounter(ID, CLIENT, 2)).rejects.toMatchObject({
      code: 'proposal_expired',
    });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('validade imutável que vence na espera prevalece sobre o espelho ainda futuro', async () => {
    setup({ proposal_expires_at: new Date('2026-10-12T15:00:00Z') });
    repo.transition.mockImplementation(async () => {
      setClockForTests(RESPOND, { frozen: true });
      return false;
    });
    await expect(contractsService.acceptCounter(ID, CLIENT, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'proposal_expired',
    });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('banimento após a pré-leitura dá unavailable quando a transação recusa o aceite', async () => {
    setup();
    users.findById
      .mockResolvedValueOnce({
        id: FREELANCER,
        role: 'freelancer',
        status: 'active',
        deleted_at: null,
      } as never)
      .mockResolvedValueOnce({
        id: FREELANCER,
        role: 'freelancer',
        status: 'banned',
        deleted_at: null,
      } as never);
    repo.transition.mockResolvedValue(false);
    await expect(contractsService.acceptCounter(ID, CLIENT, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'freelancer_unavailable',
    });
    expect(repo.transition.mock.calls[0]![0].offerResolution).toMatchObject({
      activeFreelancerId: FREELANCER,
    });
    expect(users.findById).toHaveBeenCalledTimes(2);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('aceite não avisa o freelancer até a transição confirmar sucesso', async () => {
    setup();
    let commit!: (value: boolean) => void;
    repo.transition.mockImplementation(
      () =>
        new Promise((resolve) => {
          commit = resolve;
        }),
    );
    const action = contractsService.acceptCounter(ID, CLIENT, 2);
    await vi.waitFor(() => expect(repo.transition).toHaveBeenCalledOnce());
    expect(notifications.notify).not.toHaveBeenCalled();
    commit(true);
    await action;
    expect(notifications.notify).toHaveBeenCalledOnce();
    expect(notifications.notify.mock.calls[0]![0]).toBe(FREELANCER);
  });
});
