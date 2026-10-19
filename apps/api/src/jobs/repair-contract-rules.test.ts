import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../test-support/fake-db';
import { repairDeliveryRules, repairOfferRules } from './repair-contract-rules';

vi.mock('../config/db', async () => (await import('../test-support/fake-db')).dbModule);

const FIRST = new Date('2026-10-01T15:00:00.000Z');
const LATER = new Date('2026-10-02T15:00:00.000Z');
const OPENS = new Date('2026-10-03T15:00:00.000Z');
const NOW = new Date('2026-10-05T15:00:00.000Z');
const OK = { affectedRows: 1 };
const ZERO = { firstDelivery: 0, deliveryDisputeSnapshot: 0, milestoneDisputeSnapshot: 0 };
const contract = (extra: Record<string, unknown> = {}) => ({
  id: 7,
  status: 'delivered',
  first_delivery_at: null,
  delivery_dispute_opens_at: null,
  approval_due_at: null,
  ...extra,
});
const milestone = (extra: Record<string, unknown> = {}) => ({
  id: 11,
  title: 'Arte final',
  status: 'delivered',
  delivered_at: LATER,
  approval_due_at: null,
  dispute_opens_at: null,
  ...extra,
});
const proposal = (extra: Record<string, unknown> = {}) => ({
  id: 7,
  status: 'pending',
  barter_agreement_id: null,
  offer_seq: 1,
  price: '200.01',
  platform_fee: '30.00',
  freelancer_net: '170.01',
  deadline_at: LATER,
  proposal_expires_at: NOW,
  created_at: FIRST,
  ...extra,
});
const error = (code: string) => Object.assign(new Error(code), { code });
const writes = () => fakeDb.calls.filter((call) => /^(UPDATE|INSERT|DELETE)/.test(call.sql));

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb.reset();
});

describe('reparo da primeira entrega e abertura histórica (ADR 61)', () => {
  it('seleciona só candidatos ativos em lote de 200, incluindo evidência histórica sem entrega atual', async () => {
    expect(await repairDeliveryRules()).toEqual(ZERO);
    expect(fakeDb.calls).toHaveLength(1);
    const sql = fakeDb.calls[0]!.sql;
    expect(sql).toContain(
      "c.status IN ('accepted', 'in_progress', 'delivered', 'revision_requested', 'disputed')",
    );
    expect(sql).toContain("h.note LIKE 'Marco «%» entregue:%'");
    expect(sql).toContain(
      "(m.status = 'delivered' OR (m.status = 'funded' AND m.delivered_at IS NOT NULL)) AND m.dispute_opens_at IS NULL",
    );
    expect(sql).toMatch(/ORDER BY c.id LIMIT 200$/);
    expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
  });

  it('trava contrato primeiro, depois lê as três fontes e grava o mínimo sem criar histórico', async () => {
    const older = new Date('2026-09-30T15:00:00.987Z');
    fakeDb.reply([{ id: 7 }], [contract()], [{ d_at: LATER, h_at: older }], [milestone()], OK, OK);
    expect(await repairDeliveryRules()).toEqual({
      ...ZERO,
      firstDelivery: 1,
      milestoneDisputeSnapshot: 1,
    });
    expect(fakeDb.calls[1]!.sql).toContain('FROM contracts WHERE id = :id FOR UPDATE');
    expect(fakeDb.calls[2]!.sql).toContain('MIN(d.created_at)');
    expect(fakeDb.calls[2]!.sql).toContain('MIN(h.created_at)');
    expect(fakeDb.calls[3]!.sql).toContain('FROM contract_milestones');
    expect(writes()[0]!.params).toEqual({ id: 7, first: new Date('2026-09-30T15:00:00Z') });
    expect(writes()[1]!.params).toEqual({
      id: 11,
      contractId: 7,
      opens: new Date('2026-10-02T15:00:00Z'),
    });
    expect(fakeDb.conn.commit).toHaveBeenCalledOnce();
    expect(fakeDb.conn.release).toHaveBeenCalledOnce();
    expect(writes().every((call) => !/history|wallet|revision_limit|dropout/.test(call.sql))).toBe(
      true,
    );
  });

  it.each(['entrega', 'marco', 'histórico'])(
    'recupera pela fonte %s quando as outras estão ausentes',
    async (source) => {
      const rows = source === 'marco' ? [milestone({ delivered_at: FIRST })] : [];
      fakeDb.reply(
        [{ id: 7 }],
        [contract()],
        [
          {
            d_at: source === 'entrega' ? FIRST : null,
            h_at: source === 'histórico' ? FIRST : null,
          },
        ],
        rows,
        OK,
        OK,
      );
      expect((await repairDeliveryRules()).firstDelivery).toBe(1);
      expect(writes()[0]!.params).toEqual({ id: 7, first: FIRST });
    },
  );

  it('não inventa primeira entrega se a evidência desapareceu antes da trava', async () => {
    fakeDb.reply([{ id: 7 }], [contract()], [{ d_at: null, h_at: null }], []);
    expect(await repairDeliveryRules()).toEqual(ZERO);
    expect(writes()).toHaveLength(0);
  });

  it('preserva primeira data existente, mesmo quando encontra histórico anterior ou reentrega', async () => {
    fakeDb.reply(
      [{ id: 7 }],
      [contract({ first_delivery_at: FIRST })],
      [{ d_at: LATER, h_at: new Date('2026-09-01T15:00:00Z') }],
      [],
      OK,
    );
    expect(await repairDeliveryRules()).toEqual({ ...ZERO, deliveryDisputeSnapshot: 1 });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.params).toEqual({ id: 7, opens: OPENS });
  });

  it.each([
    ['sem tácita conhecida', null, OPENS],
    ['tácita um dia depois', LATER, FIRST],
    ['tácita longa', new Date('2026-10-10T15:00:00Z'), OPENS],
  ])('snapshot único: %s', async (_label, due, opens) => {
    fakeDb.reply(
      [{ id: 7 }],
      [contract({ first_delivery_at: FIRST, approval_due_at: due })],
      [{}],
      [],
      OK,
    );
    await repairDeliveryRules();
    expect(writes()[0]!.params).toEqual({ id: 7, opens });
    expect(writes()[0]!.sql).toContain('delivery_dispute_opens_at IS NULL');
  });

  it('preserva snapshots anteriores de revisão/reentrega e só inicializa marcos ainda relevantes', async () => {
    fakeDb.reply(
      [{ id: 7 }],
      [contract({ first_delivery_at: FIRST, delivery_dispute_opens_at: FIRST })],
      [{}],
      [
        milestone({ id: 11, status: 'funded', approval_due_at: LATER }),
        milestone({ id: 12, dispute_opens_at: FIRST }),
        milestone({ id: 13, status: 'approved' }),
        milestone({ id: 14, status: 'cancelled' }),
        milestone({ id: 15, status: 'funded', delivered_at: null }),
      ],
      OK,
    );
    expect(await repairDeliveryRules()).toEqual({ ...ZERO, milestoneDisputeSnapshot: 1 });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.params).toEqual({ id: 11, contractId: 7, opens: FIRST });
    expect(writes()[0]!.sql).toContain('dispute_opens_at IS NULL');
  });

  it.each(['completed', 'cancelled', 'pending'])(
    'reconfere estado %s após a trava e adia dado que deixou de ser elegível',
    async (status) => {
      fakeDb.reply([{ id: 7 }], [contract({ status })]);
      expect(await repairDeliveryRules()).toEqual(ZERO);
      expect(fakeDb.calls).toHaveLength(2);
    },
  );

  it.each(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_DUP_ENTRY'])(
    '%s desfaz esta linha, libera a conexão e repara a próxima',
    async (code) => {
      fakeDb.reply(
        [{ id: 7 }, { id: 8 }],
        [contract({ first_delivery_at: FIRST })],
        [{}],
        [],
        error(code),
        [contract({ id: 8, first_delivery_at: FIRST })],
        [{}],
        [],
        OK,
      );
      expect(await repairDeliveryRules()).toEqual({ ...ZERO, deliveryDisputeSnapshot: 1 });
      expect(fakeDb.conn.rollback).toHaveBeenCalledOnce();
      expect(fakeDb.conn.commit).toHaveBeenCalledOnce();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(2);
    },
  );

  it('não conta escritas de uma transação que falhou no COMMIT', async () => {
    fakeDb.conn.commit.mockRejectedValueOnce(error('ER_LOCK_DEADLOCK'));
    fakeDb.reply([{ id: 7 }], [contract({ first_delivery_at: FIRST })], [{}], [], OK);
    expect(await repairDeliveryRules()).toEqual(ZERO);
    expect(fakeDb.conn.rollback).toHaveBeenCalledOnce();
  });

  it('propaga erro desconhecido depois do rollback', async () => {
    fakeDb.reply([{ id: 7 }], error('ER_BAD_FIELD_ERROR'));
    await expect(repairDeliveryRules()).rejects.toMatchObject({ code: 'ER_BAD_FIELD_ERROR' });
    expect(fakeDb.conn.rollback).toHaveBeenCalledOnce();
  });
});

describe('reparo de ofertas históricas (ADR 61)', () => {
  it('limita os dois lotes a 200 e não usa INSERT SELECT nem trava intervalos de ofertas', async () => {
    expect(await repairOfferRules(NOW)).toEqual({ offerOne: 0, closedOffers: 0 });
    expect(fakeDb.calls).toHaveLength(2);
    expect(fakeDb.calls.every((call) => /LIMIT 200$/.test(call.sql))).toBe(true);
    expect(fakeDb.calls[0]!.sql).toContain(
      "c.status = 'pending' AND c.barter_agreement_id IS NULL AND c.offer_seq = 1",
    );
  });

  it('copia valores exatos e termos dos marcos na ordem histórica, mantendo títulos e datas originais', async () => {
    fakeDb.reply(
      [{ id: 7 }],
      [proposal()],
      [],
      [
        { id: 14, title: 'Título % _', amount: '100.00', freelancer_net: '85.00', due_at: null },
        { id: 11, title: 'Arte final', amount: '100.01', freelancer_net: '85.01', due_at: LATER },
      ],
      OK,
      [],
    );
    expect(await repairOfferRules(NOW)).toEqual({ offerOne: 1, closedOffers: 0 });
    expect(fakeDb.calls[1]!.sql).toContain('FROM contracts WHERE id = :id FOR UPDATE');
    expect(fakeDb.calls[2]!.sql).toBe(
      'SELECT id FROM contract_offers WHERE contract_id = :id LIMIT 1',
    );
    expect(fakeDb.calls[3]!.sql).toMatch(/ORDER BY sort_order, id$/);
    expect(writes()[0]!.sql).toContain(
      "VALUES (:id, 1, 'client', :price, :fee, :net, :deadline, :milestones, NULL, :respondBy, :createdAt)",
    );
    expect(writes()[0]!.params).toEqual({
      id: 7,
      price: '200.01',
      fee: '30.00',
      net: '170.01',
      deadline: LATER,
      respondBy: NOW,
      createdAt: FIRST,
      milestones: JSON.stringify([
        { id: 14, title: 'Título % _', amount: 100, freelancerNet: 85, dueAt: null },
        {
          id: 11,
          title: 'Arte final',
          amount: 100.01,
          freelancerNet: 85.01,
          dueAt: LATER.toISOString(),
        },
      ]),
    });
    expect(
      fakeDb.sqls().some((sql) => /INSERT.*SELECT|contract_offers.*FOR UPDATE/.test(sql)),
    ).toBe(false);
  });

  it('entrega única conserva marcos e prazos nulos, sem recomputar dados do painel', async () => {
    fakeDb.reply(
      [{ id: 7 }],
      [proposal({ deadline_at: null, proposal_expires_at: null })],
      [],
      [],
      OK,
      [],
    );
    await repairOfferRules(NOW);
    expect(writes()[0]!.params).toMatchObject({
      milestones: null,
      deadline: null,
      respondBy: null,
      createdAt: FIRST,
    });
  });

  it.each([{ status: 'accepted' }, { barter_agreement_id: 3 }, { offer_seq: 2 }])(
    'reconfere elegibilidade após contrato travado: %j',
    async (extra) => {
      fakeDb.reply([{ id: 7 }], [proposal(extra)], []);
      expect(await repairOfferRules(NOW)).toEqual({ offerOne: 0, closedOffers: 0 });
      expect(writes()).toHaveLength(0);
      expect(fakeDb.calls).toHaveLength(3);
    },
  );

  it('repair concorrente já criou a oferta depois da seleção; não duplica nem lê marcos', async () => {
    fakeDb.reply([{ id: 7 }], [proposal()], [{ id: 18 }], []);
    expect(await repairOfferRules(NOW)).toEqual({ offerOne: 0, closedOffers: 0 });
    expect(writes()).toHaveLength(0);
    expect(fakeDb.calls).toHaveLength(4);
  });

  it('fecha somente ofertas ainda open depois de reler estado sob trava do contrato', async () => {
    fakeDb.reply([], [{ id: 7 }], [{ id: 7, status: 'accepted' }], { affectedRows: 2 });
    expect(await repairOfferRules(NOW)).toEqual({ offerOne: 0, closedOffers: 2 });
    expect(fakeDb.calls[2]!.sql).toBe('SELECT id, status FROM contracts WHERE id = :id FOR UPDATE');
    expect(writes()[0]!.sql).toBe(
      "UPDATE contract_offers SET outcome = 'closed', resolved_at = :now WHERE contract_id = :id AND outcome = 'open'",
    );
    expect(writes()[0]!.params).toEqual({ id: 7, now: NOW });
  });

  it('contrato voltou a pending enquanto aguardava a trava; conserva a oferta aberta', async () => {
    fakeDb.reply([], [{ id: 7 }], [{ id: 7, status: 'pending' }]);
    expect(await repairOfferRules(NOW)).toEqual({ offerOne: 0, closedOffers: 0 });
    expect(writes()).toHaveLength(0);
  });

  it.each(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_DUP_ENTRY'])(
    '%s na oferta não derruba o restante do lote',
    async (code) => {
      fakeDb.reply(
        [{ id: 7 }, { id: 8 }],
        [proposal()],
        [],
        [],
        error(code),
        [proposal({ id: 8 })],
        [],
        [],
        OK,
        [],
      );
      expect(await repairOfferRules(NOW)).toEqual({ offerOne: 1, closedOffers: 0 });
      expect(fakeDb.conn.rollback).toHaveBeenCalledOnce();
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(2);
    },
  );
});
