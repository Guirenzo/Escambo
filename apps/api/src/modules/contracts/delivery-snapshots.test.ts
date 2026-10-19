import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { contractsRepository } from './contracts.repository';
import { recoverDeliveryRules, type DeliveryRuleContract } from './delivery-snapshots';
import { milestonesRepository } from './milestones.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
const NOW = new Date('2026-10-08T15:00:00Z');
const FIRST = new Date('2026-10-03T15:00:00Z');
const LAST = new Date('2026-10-04T15:00:00Z');
const OPENS = new Date('2026-10-05T15:00:00Z');
const NEXT_APPROVAL = new Date('2026-10-11T15:00:00Z');
const OK = { affectedRows: 1 };
const conn = fakeDb.conn as unknown as PoolConnection;
const contract = (extra: Record<string, unknown> = {}) =>
  ({
    id: 31,
    status: 'revision_requested',
    first_delivery_at: null,
    delivery_dispute_opens_at: null,
    approval_due_at: null,
    ...extra,
  }) as DeliveryRuleContract;

beforeEach(() => {
  fakeDb.reset();
  for (const fn of [fakeDb.conn.beginTransaction, fakeDb.conn.commit, fakeDb.conn.rollback])
    fn.mockReset().mockResolvedValue(undefined);
});
function rollback() {
  expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.commit).not.toHaveBeenCalled();
  expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
}

describe('recuperação histórica usada pela API antes do job', () => {
  it('escolhe o menor registro entre entregas, histórico e marcos antes de gravar o snapshot', async () => {
    fakeDb.reply(
      [{ d_at: LAST, h_at: FIRST }],
      [
        {
          id: 81,
          status: 'delivered',
          delivered_at: LAST,
          approval_due_at: NEXT_APPROVAL,
          dispute_opens_at: null,
        },
      ],
      OK,
      OK,
    );
    const result = await recoverDeliveryRules(conn, 31, contract({ status: 'in_progress' }));
    expect(result.firstDeliveryAt).toEqual(FIRST);
    expect(result.counts).toEqual({
      firstDelivery: 1,
      deliveryDisputeSnapshot: 0,
      milestoneDisputeSnapshot: 1,
    });
    expect(result.milestones[0]!.dispute_opens_at).toEqual(OPENS);
    expect(fakeDb.calls[0]!.sql).toContain('MIN(d.created_at)');
    expect(fakeDb.calls[0]!.sql).toContain("h.note LIKE 'Marco «%» entregue:%'");
    expect(fakeDb.calls[1]!.sql).toContain('ORDER BY sort_order, id');
    expect(fakeDb.calls[2]!.params).toEqual({ id: 31, first: FIRST });
    expect(fakeDb.calls[3]!.params).toEqual({ id: 81, contractId: 31, opens: OPENS });
    expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
    expect(fakeDb.conn.beginTransaction).not.toHaveBeenCalled();
    expect(fakeDb.conn.commit).not.toHaveBeenCalled();
  });

  it('sem entrega histórica não inventa primeira entrega na época zero', async () => {
    fakeDb.reply([{ d_at: null, h_at: null }], []);
    const result = await recoverDeliveryRules(conn, 31, contract());
    expect(result.firstDeliveryAt).toBeNull();
    expect(result.deliveryDisputeOpensAt).toBeNull();
    expect(result.counts).toEqual({
      firstDelivery: 0,
      deliveryDisputeSnapshot: 0,
      milestoneDisputeSnapshot: 0,
    });
    expect(fakeDb.sqls().every((sql) => sql.startsWith('SELECT'))).toBe(true);
  });

  it.each(['pending', 'cancelled', 'completed', 'rejected'])(
    'não recupera regra fora de contrato ativo: %s',
    async (status) => {
      expect(
        (await recoverDeliveryRules(conn, 31, contract({ status }))).firstDeliveryAt,
      ).toBeNull();
      expect(fakeDb.calls).toHaveLength(0);
    },
  );

  it('primeira entrega e abertura persistidas prevalecem nas reentradas sem novas escritas', async () => {
    fakeDb.reply([{ d_at: FIRST, h_at: FIRST }], []);
    const result = await recoverDeliveryRules(
      conn,
      31,
      contract({ first_delivery_at: LAST, delivery_dispute_opens_at: OPENS }),
    );
    expect(result.firstDeliveryAt).toEqual(LAST);
    expect(result.deliveryDisputeOpensAt).toEqual(OPENS);
    expect(result.counts).toEqual({
      firstDelivery: 0,
      deliveryDisputeSnapshot: 0,
      milestoneDisputeSnapshot: 0,
    });
    expect(fakeDb.calls).toHaveLength(2);
  });

  it('tácita antiga conhecida conserva a abertura antecipada antes de a revisão limpar a data', async () => {
    const approval = new Date(FIRST.getTime() + 24 * 3_600_000);
    fakeDb.reply([{ d_at: FIRST, h_at: null }], [], OK, OK);
    const result = await recoverDeliveryRules(
      conn,
      31,
      contract({ status: 'delivered', approval_due_at: approval }),
    );
    expect(result.deliveryDisputeOpensAt).toEqual(FIRST);
    expect(fakeDb.calls[3]!.params).toEqual({ id: 31, opens: FIRST });
  });
});

describe('escritores preservam a entrega anterior na mesma transação', () => {
  const single = {
    id: 31,
    changedBy: 44,
    from: 'revision_requested',
    message: 'Nova versão',
    files: null,
    now: NOW,
    approvalDueAt: NEXT_APPROVAL,
  };

  it('reentrega única recupera o mínimo antes de gravar a nova entrega', async () => {
    fakeDb.reply([contract()], [{ d_at: FIRST, h_at: LAST }], [], OK, OK, OK, OK, OK);
    expect(await contractsRepository.deliver(single)).toBe(true);
    const mutation = fakeDb.calls.findIndex((call) =>
      call.sql.startsWith('UPDATE contracts c SET c.status'),
    );
    expect(fakeDb.calls[0]!.sql).toContain('FOR UPDATE');
    expect(mutation).toBe(5);
    expect(fakeDb.calls[3]!.params).toEqual({ id: 31, first: FIRST });
    expect(fakeDb.calls[4]!.params).toEqual({ id: 31, opens: OPENS });
    expect(fakeDb.calls[mutation]!.params).toMatchObject({
      first: FIRST,
      opens: OPENS,
      approvalDueAt: NEXT_APPROVAL,
    });
    expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
    expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
  });

  it('erro na nova entrega desfaz inclusive primeira entrega e snapshot recuperados', async () => {
    const failure = new Error('Falha na gravação da nova versão');
    fakeDb.reply([contract()], [{ d_at: FIRST, h_at: null }], [], OK, OK, OK, failure);
    await expect(contractsRepository.deliver(single)).rejects.toBe(failure);
    expect(fakeDb.calls[3]!.sql).toContain('SET first_delivery_at = :first');
    expect(fakeDb.calls[4]!.sql).toContain('SET delivery_dispute_opens_at = :opens');
    rollback();
  });

  it('reentrega de marco lê sua entrega antiga e o histórico antes de sobrescrever delivered_at', async () => {
    const m = {
      id: 81,
      title: 'Layout',
      status: 'funded',
      delivered_at: LAST,
      approval_due_at: null,
      dispute_opens_at: null,
    };
    fakeDb.reply(
      [{ status: 'in_progress' }],
      [contract({ status: 'in_progress' })],
      [{ d_at: null, h_at: FIRST }],
      [m],
      OK,
      OK,
      OK,
      OK,
      [{ title: 'Layout' }],
      OK,
      OK,
    );
    expect(
      await milestonesRepository.deliver({
        contractId: 31,
        milestoneId: 81,
        changedBy: 44,
        message: 'Nova versão',
        now: NOW,
        approvalDueAt: NEXT_APPROVAL,
      }),
    ).toBe(true);
    const update = fakeDb.calls.findIndex((call) =>
      call.sql.startsWith("UPDATE contract_milestones SET status = 'delivered'"),
    );
    expect(update).toBe(6);
    expect(fakeDb.calls[3]!.sql).toContain('delivered_at, approval_due_at, dispute_opens_at');
    expect(fakeDb.calls[4]!.params).toEqual({ id: 31, first: FIRST });
    expect(fakeDb.calls[5]!.params).toEqual({ id: 81, contractId: 31, opens: OPENS });
    expect(fakeDb.calls[update]!.params).toMatchObject({
      id: 81,
      contractId: 31,
      opens: OPENS,
      now: NOW,
    });
    expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('pedido de revisão do marco congela o cap histórico antes de apagar approval_due_at', async () => {
    const approval = new Date(FIRST.getTime() + 24 * 3_600_000);
    fakeDb.reply(
      [{ status: 'in_progress' }],
      [contract({ status: 'in_progress', first_delivery_at: FIRST })],
      [{ d_at: null, h_at: FIRST }],
      [
        {
          id: 81,
          title: 'Layout',
          status: 'delivered',
          delivered_at: FIRST,
          approval_due_at: approval,
          dispute_opens_at: null,
        },
      ],
      OK,
      OK,
      [{ title: 'Layout' }],
      OK,
    );
    expect(
      await milestonesRepository.requestRevision({
        contractId: 31,
        milestoneId: 81,
        changedBy: 7,
        expectedRevisionsUsed: 0,
        note: 'Ajustar',
        now: NOW,
      }),
    ).toBe(true);
    expect(fakeDb.calls[4]!.params).toEqual({ id: 81, contractId: 31, opens: FIRST });
    expect(fakeDb.calls[5]!.sql).toContain('approval_due_at = NULL');
    expect(fakeDb.calls[5]!.sql).toContain('revisions_used = revisions_used + 1');
    expect(fakeDb.calls[5]!.sql).toContain(
      '(revision_limit IS NULL OR revisions_used < revision_limit)',
    );
    expect(fakeDb.calls[7]!.params).toMatchObject({
      note: 'Revisão pedida no marco «Layout»: Ajustar',
      at: NOW,
    });
    expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('pedido recusado após recuperação faz rollback do snapshot sem criar histórico', async () => {
    fakeDb.reply(
      [{ status: 'in_progress' }],
      [contract({ status: 'in_progress', first_delivery_at: FIRST })],
      [{ d_at: null, h_at: FIRST }],
      [
        {
          id: 81,
          title: 'Layout',
          status: 'delivered',
          delivered_at: FIRST,
          approval_due_at: new Date(FIRST.getTime() + 24 * 3_600_000),
          dispute_opens_at: null,
        },
      ],
      OK,
      { affectedRows: 0 },
    );
    expect(
      await milestonesRepository.requestRevision({
        contractId: 31,
        milestoneId: 81,
        changedBy: 7,
        expectedRevisionsUsed: 0,
        note: 'Ajustar',
        now: NOW,
      }),
    ).toBe(false);
    expect(fakeDb.sqls().some((sql) => sql.startsWith('INSERT INTO contract_status_history'))).toBe(
      false,
    );
    rollback();
  });
});
