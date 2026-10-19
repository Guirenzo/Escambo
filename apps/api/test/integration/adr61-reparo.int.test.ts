import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, pool } from '../../src/config/db';
import { repairDeliveryRules, repairOfferRules } from '../../src/jobs/repair-contract-rules';
import { runRepairDeadlines } from '../../src/jobs/repair-deadlines';
import { contractsRepository } from '../../src/modules/contracts/contracts.repository';
import { disputeOpensAt, windowFacts } from '../../src/modules/contracts/dispute-window';

const FIRST = new Date('2026-10-01T15:00:00Z');
const LATER = new Date('2026-10-02T15:00:00Z');
const OPENS = new Date('2026-10-03T15:00:00Z');
const REPAIRED_APPROVAL = new Date('2026-10-04T15:00:00Z');
const NOW = new Date('2026-10-05T15:00:00Z');
let clientId: number;
let freelancerId: number;
const owned: number[] = [];
const originals = new Map<string, string>();

beforeAll(async () => {
  // Outras suítes deixam contratos ativos do legado no banco compartilhado. Este preparo
  // termina o trabalho anterior antes de criar nossas fixtures; as métricas dos testes
  // continuam exatas e precisam corresponder apenas aos contratos criados aqui.
  let baseline = await repairDeliveryRules();
  for (
    let batch = 1;
    batch < 100 && Object.values(baseline).some((count) => count !== 0);
    batch++
  ) {
    baseline = await repairDeliveryRules();
  }
  expect(baseline, 'o reparo do legado anterior convergiu antes das fixtures desta suíte').toEqual({
    firstDelivery: 0,
    deliveryDisputeSnapshot: 0,
    milestoneDisputeSnapshot: 0,
  });
  for (const role of ['client', 'freelancer']) {
    const key = ulid();
    const [created] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (ulid, email, role, status) VALUES (:key, :email, :role, 'active')`,
      { key, email: `adr61-repair-${key}@escambo.test`, role },
    );
    if (role === 'client') clientId = created.insertId;
    else freelancerId = created.insertId;
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT key_name, value FROM platform_settings
      WHERE key_name IN ('tacit_approval_days', 'extension_response_hours')`,
  );
  for (const row of rows) originals.set(row.key_name, row.value);
});

afterEach(async () => {
  if (owned.length) await pool.query(`DELETE FROM contracts WHERE id IN (:ids)`, { ids: owned });
  owned.length = 0;
  for (const [key, value] of originals) {
    await pool.query(`UPDATE platform_settings SET value = :value WHERE key_name = :key`, {
      key,
      value,
    });
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM users WHERE id IN (:clientId, :freelancerId)', {
      clientId,
      freelancerId,
    });
  } finally {
    await pool.end();
  }
});

async function contract(extra: Record<string, unknown> = {}): Promise<number> {
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO contracts (ulid, client_id, freelancer_id, title, description, price,
                            platform_fee, freelancer_net, status, created_at, accepted_at,
                            deadline_at, proposal_expires_at, first_delivery_at,
                            approval_due_at, delivery_dispute_opens_at)
     VALUES (:key, :clientId, :freelancerId, 'Reparo legado ADR 61', 'Termos históricos',
             :price, :fee, :net, :status, :created, :accepted, :deadline, :expires,
             :first, :approval, :opens)`,
    {
      key: ulid(),
      clientId,
      freelancerId,
      price: '200.01',
      fee: '30.00',
      net: '170.01',
      status: 'delivered',
      created: FIRST,
      accepted: FIRST,
      deadline: null,
      expires: null,
      first: null,
      approval: null,
      opens: null,
      ...extra,
    },
  );
  owned.push(created.insertId);
  return created.insertId;
}

async function delivery(id: number, at: Date): Promise<void> {
  await pool.query(
    `INSERT INTO deliveries (contract_id, message, delivered_at, created_at)
       VALUES (:id, 'Entrega histórica', :at, :at)`,
    { id, at },
  );
}

async function history(
  id: number,
  at: Date,
  note: string | null,
  status = 'in_progress',
): Promise<void> {
  await pool.query(
    `INSERT INTO contract_status_history (contract_id, changed_by, new_status, note, created_at)
       VALUES (:id, :freelancerId, :status, :note, :at)`,
    { id, freelancerId, status, note, at },
  );
}

async function milestone(id: number, extra: Record<string, unknown> = {}): Promise<number> {
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO contract_milestones (contract_id, title, amount, freelancer_net, sort_order,
                                     status, due_at, delivered_at, approval_due_at, dispute_opens_at)
     VALUES (:id, :title, :amount, :net, :order, :status, :due, :delivered, :approval, :opens)`,
    {
      id,
      title: 'Arte final % _',
      amount: '100.01',
      net: '85.01',
      order: 1,
      status: 'delivered',
      due: LATER,
      delivered: LATER,
      approval: null,
      opens: null,
      ...extra,
    },
  );
  return created.insertId;
}

async function offer(id: number): Promise<void> {
  await pool.query(
    `INSERT INTO contract_offers (contract_id, seq, made_by, price, platform_fee,
                                  freelancer_net, created_at, respond_by)
       VALUES (:id, 1, 'client', 200.01, 30, 170.01, :created, :expires)`,
    { id, created: FIRST, expires: NOW },
  );
}

async function row(id: number): Promise<RowDataPacket> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM contracts WHERE id = :id`, {
    id,
  });
  return rows[0]!;
}

async function offers(id: number): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM contract_offers WHERE contract_id = :id ORDER BY seq`,
    { id },
  );
  return rows;
}

async function histories(id: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM contract_status_history WHERE contract_id = :id`,
    { id },
  );
  return Number(rows[0]!.n);
}

async function waitForContractWaiters(minimum: number): Promise<void> {
  let waiting = 0;
  const end = Date.now() + 5_000;
  while (waiting < minimum && Date.now() < end) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
        WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'contracts'`,
    );
    waiting = Number(rows[0]!.n);
    if (waiting < minimum) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(waiting, 'operações chegaram à fila da trava real da contratação').toBeGreaterThanOrEqual(
    minimum,
  );
}

async function concurrent<T, U>(
  id: number,
  first: () => Promise<T>,
  second: () => Promise<U>,
): Promise<[T, U]> {
  const blocker = await pool.getConnection();
  let pending: Promise<PromiseSettledResult<T | U>[]> | undefined;
  try {
    await blocker.beginTransaction();
    await blocker.query(`SELECT id FROM contracts WHERE id = :id FOR UPDATE`, { id });
    pending = Promise.allSettled([first(), second()]);
    await waitForContractWaiters(2);
  } finally {
    await blocker.rollback();
    blocker.release();
    if (pending) await pending;
  }
  const results = await pending!;
  expect(results.map((item) => item.status)).toEqual(['fulfilled', 'fulfilled']);
  return results.map((item) => (item as PromiseFulfilledResult<T | U>).value) as [T, U];
}

describe('reparo de regras ADR 61 no MySQL', () => {
  it('recupera o mínimo histórico antes da reentrega e conserva primeira data/snapshots/limites sem escrever histórico', async () => {
    const id = await contract({ status: 'in_progress' });
    await delivery(id, LATER);
    await history(id, FIRST, 'Marco «Arte final % _» entregue: versão original');
    const m = await milestone(id, { delivered: LATER, approval: new Date('2026-10-03T15:00:00Z') });
    const historyCount = await histories(id);
    expect(await repairDeliveryRules()).toMatchObject({
      firstDelivery: 1,
      milestoneDisputeSnapshot: 1,
    });
    expect(await row(id)).toMatchObject({
      first_delivery_at: FIRST,
      revision_limit: null,
      revisions_used: 0,
    });
    const [before] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM contract_milestones WHERE id = :m`,
      { m },
    );
    expect(before[0]).toMatchObject({
      dispute_opens_at: LATER,
      revision_limit: null,
      revisions_used: 0,
    });
    // Uma API anterior pede revisão e reentrega, sem gravar as colunas novas.
    await pool.query(
      `UPDATE contract_milestones SET status = 'funded', approval_due_at = NULL WHERE id = :m`,
      { m },
    );
    await repairDeliveryRules();
    await pool.query(
      `UPDATE contract_milestones SET status = 'delivered', delivered_at = :now,
                      approval_due_at = :due WHERE id = :m`,
      { m, now: NOW, due: new Date('2026-10-10T15:00:00Z') },
    );
    expect(await repairDeliveryRules()).toMatchObject({
      firstDelivery: 0,
      milestoneDisputeSnapshot: 0,
    });
    expect((await row(id)).first_delivery_at).toEqual(FIRST);
    const [after] = await pool.query<RowDataPacket[]>(
      `SELECT dispute_opens_at FROM contract_milestones WHERE id = :m`,
      { m },
    );
    expect(after[0]!.dispute_opens_at).toEqual(LATER);
    expect(await histories(id)).toBe(historyCount);
  });

  it('preserva tácita conhecida e congela +48h quando desconhecida antes de inferir com configuração atual', async () => {
    await pool.query(
      `UPDATE platform_settings SET value = '1' WHERE key_name = 'tacit_approval_days'`,
    );
    const known = await contract({ approval: LATER });
    const unknown = await contract();
    await delivery(known, FIRST);
    await delivery(unknown, FIRST);
    await history(unknown, FIRST, null, 'delivered');
    await runRepairDeadlines(NOW);
    expect(await row(known)).toMatchObject({
      first_delivery_at: FIRST,
      delivery_dispute_opens_at: FIRST,
      approval_due_at: LATER,
    });
    expect(await row(unknown)).toMatchObject({
      first_delivery_at: FIRST,
      delivery_dispute_opens_at: OPENS,
      approval_due_at: REPAIRED_APPROVAL,
    });
    await runRepairDeadlines(NOW);
    expect((await row(unknown)).delivery_dispute_opens_at).toEqual(OPENS);
    expect(disputeOpensAt(windowFacts((await contractsRepository.findById(known))!))).toEqual(
      FIRST,
    );
    expect(disputeOpensAt(windowFacts((await contractsRepository.findById(unknown))!))).toEqual(
      OPENS,
    );
  });

  it('mais de 200 contratos: passos7/8 aguardam snapshot e a rodada seguinte não toma tácita inferida como histórica', async () => {
    await pool.query(
      `UPDATE platform_settings SET value = '1' WHERE key_name = 'tacit_approval_days'`,
    );
    const singles: number[] = [];
    const milestones: number[] = [];
    for (let i = 0; i < 205; i++) {
      const id = await contract({ status: i % 2 ? 'in_progress' : 'delivered' });
      if (i % 2) milestones.push(await milestone(id, { delivered: FIRST }));
      else {
        singles.push(id);
        await delivery(id, FIRST);
        await history(id, FIRST, null, 'delivered');
      }
    }
    const first = await runRepairDeadlines(NOW);
    expect(first.firstDelivery).toBe(200);
    const [remaining] = await pool.query<RowDataPacket[]>(
      `SELECT first_delivery_at, approval_due_at FROM contracts WHERE id IN (:ids)
         AND first_delivery_at IS NULL`,
      { ids: owned },
    );
    expect(remaining).toHaveLength(5);
    expect(remaining.every((item) => item.approval_due_at === null)).toBe(true);
    const [unfrozen] = await pool.query<RowDataPacket[]>(
      `SELECT approval_due_at FROM contract_milestones WHERE id IN (:ids) AND dispute_opens_at IS NULL`,
      { ids: milestones },
    );
    expect(unfrozen.every((item) => item.approval_due_at === null)).toBe(true);
    expect((await runRepairDeadlines(NOW)).firstDelivery).toBe(5);
    const [singleRows] = await pool.query<RowDataPacket[]>(
      `SELECT first_delivery_at, delivery_dispute_opens_at, approval_due_at FROM contracts WHERE id IN (:ids)`,
      { ids: singles },
    );
    expect(
      singleRows.every(
        (item) =>
          item.first_delivery_at.getTime() === FIRST.getTime() &&
          item.delivery_dispute_opens_at.getTime() === OPENS.getTime() &&
          item.approval_due_at.getTime() === REPAIRED_APPROVAL.getTime(),
      ),
    ).toBe(true);
    const [milestoneRows] = await pool.query<RowDataPacket[]>(
      `SELECT dispute_opens_at, approval_due_at FROM contract_milestones WHERE id IN (:ids)`,
      { ids: milestones },
    );
    expect(
      milestoneRows.every(
        (item) =>
          item.dispute_opens_at.getTime() === OPENS.getTime() &&
          item.approval_due_at.getTime() === REPAIRED_APPROVAL.getTime(),
      ),
    ).toBe(true);
    expect(await runRepairDeadlines(NOW)).toMatchObject({
      firstDelivery: 0,
      deliveryDisputeSnapshot: 0,
      milestoneDisputeSnapshot: 0,
    });
    for (const id of [singles[0]!, owned[1]!]) {
      expect(disputeOpensAt(windowFacts((await contractsRepository.findById(id))!))).toEqual(OPENS);
    }
  }, 60_000);

  it('oferta1 conserva termos exatos, títulos/ids/ordem/valores/datas, criação e resposta originais; reentrada não duplica', async () => {
    const id = await contract({ status: 'pending', expires: LATER, accepted: null, deadline: NOW });
    const last = await milestone(id, {
      title: 'Arte % _',
      order: 1,
      status: 'pending',
      delivered: null,
      due: NOW,
    });
    const first = await milestone(id, {
      title: 'Rascunho',
      order: 0,
      status: 'pending',
      amount: '100.00',
      net: '85.00',
      delivered: null,
      due: LATER,
    });
    const before = await row(id);
    expect(await repairOfferRules(NOW)).toMatchObject({ offerOne: 1 });
    const rows = await offers(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq: 1,
      made_by: 'client',
      price: '200.01',
      platform_fee: '30.00',
      freelancer_net: '170.01',
      created_at: FIRST,
      respond_by: LATER,
      deadline_at: NOW,
      message: null,
      outcome: 'open',
    });
    const terms =
      typeof rows[0]!.milestones === 'string'
        ? JSON.parse(rows[0]!.milestones)
        : rows[0]!.milestones;
    expect(terms).toEqual([
      { id: first, title: 'Rascunho', amount: 100, freelancerNet: 85, dueAt: LATER.toISOString() },
      {
        id: last,
        title: 'Arte % _',
        amount: 100.01,
        freelancerNet: 85.01,
        dueAt: NOW.toISOString(),
      },
    ]);
    expect(await repairOfferRules(NOW)).toMatchObject({ offerOne: 0 });
    expect(await row(id)).toEqual(before);
    expect(await histories(id)).toBe(0);
  });

  it('marco sem data atual recupera abertura pela primeira entrega já conhecida antes de inferir a tácita', async () => {
    const id = await contract({ status: 'in_progress', first: FIRST });
    const m = await milestone(id, { delivered: null });
    expect(await repairDeliveryRules()).toMatchObject({
      firstDelivery: 0,
      milestoneDisputeSnapshot: 1,
    });
    await runRepairDeadlines(NOW);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT delivered_at, dispute_opens_at, approval_due_at
         FROM contract_milestones WHERE id = :m`,
      { m },
    );
    expect(rows[0]).toMatchObject({
      delivered_at: null,
      dispute_opens_at: OPENS,
      approval_due_at: new Date('2026-10-10T15:00:00Z'),
    });
    expect((await row(id)).first_delivery_at).toEqual(FIRST);
  });

  it('200 marcos sem evidência não bloqueiam a recuperação posterior e conservam o fallback da tácita', async () => {
    const orphanMilestones: number[] = [];
    for (let i = 0; i < 200; i++) {
      const id = await contract({ status: 'in_progress' });
      orphanMilestones.push(await milestone(id, { delivered: null }));
    }
    const recoverable = await contract();
    await delivery(recoverable, FIRST);
    expect(await repairDeliveryRules()).toMatchObject({
      firstDelivery: 1,
      deliveryDisputeSnapshot: 1,
      milestoneDisputeSnapshot: 0,
    });
    expect(await row(recoverable)).toMatchObject({
      first_delivery_at: FIRST,
      delivery_dispute_opens_at: OPENS,
    });
    expect((await runRepairDeadlines(NOW)).milestoneApprovalDue).toBe(200);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT delivered_at, dispute_opens_at, approval_due_at
         FROM contract_milestones WHERE id IN (:ids)`,
      { ids: orphanMilestones },
    );
    expect(rows).toHaveLength(200);
    for (const orphan of rows) {
      expect(orphan).toMatchObject({
        delivered_at: null,
        dispute_opens_at: null,
        approval_due_at: new Date('2026-10-10T15:00:00Z'),
      });
    }
  }, 60_000);

  it('aceite da API antiga deixa open que o reparo fecha uma vez sem alterar termos e sem histórico/financeiro', async () => {
    const id = await contract({ status: 'pending', expires: NOW });
    await repairOfferRules(NOW);
    const before = (await offers(id))[0]!;
    await pool.query(`UPDATE contracts SET status = 'accepted' WHERE id = :id`, { id });
    expect(await repairOfferRules(NOW)).toMatchObject({ closedOffers: 1 });
    expect((await offers(id))[0]).toEqual({ ...before, outcome: 'closed', resolved_at: NOW });
    expect(await repairOfferRules(NOW)).toMatchObject({ closedOffers: 0 });
    expect(await histories(id)).toBe(0);
    const [financial] = await pool.query<RowDataPacket[]>(
      `SELECT (SELECT COUNT(*) FROM freelancer_dropouts WHERE contract_id = :id) AS dropouts,
              (SELECT COUNT(*) FROM payments WHERE contract_id = :id) AS payments`,
      { id },
    );
    expect(financial[0]).toMatchObject({ dropouts: 0, payments: 0 });
    expect((await row(id)).revision_limit).toBeNull();
  });

  it('10 corridas repair×repair: uma primeira data e uma oferta, sem deadlock nem histórico', async () => {
    for (let i = 0; i < 10; i++) {
      const id = await contract();
      await delivery(id, FIRST);
      const results = await concurrent(id, repairDeliveryRules, repairDeliveryRules);
      expect(results.reduce((sum, item) => sum + item.firstDelivery, 0)).toBe(1);
      expect(results.reduce((sum, item) => sum + item.deliveryDisputeSnapshot, 0)).toBe(1);
      expect((await row(id)).first_delivery_at).toEqual(FIRST);
      const pending = await contract({ status: 'pending', expires: NOW });
      const repaired = await concurrent(
        pending,
        () => repairOfferRules(NOW),
        () => repairOfferRules(NOW),
      );
      expect(repaired.reduce((sum, item) => sum + item.offerOne, 0)).toBe(1);
      expect(await offers(pending)).toHaveLength(1);
      expect(await histories(id)).toBe(0);
      expect(await histories(pending)).toBe(0);
    }
  });

  it('10 corridas repair×fechamento: recheck sob contrato impede oferta criada após aceite', async () => {
    for (let i = 0; i < 10; i++) {
      const id = await contract({ status: 'pending', expires: NOW });
      await concurrent(
        id,
        () => repairOfferRules(NOW),
        () =>
          inTransaction(async (conn) => {
            await conn.query(`SELECT id FROM contracts WHERE id = :id FOR UPDATE`, { id });
            await conn.query(`UPDATE contracts SET status = 'accepted' WHERE id = :id`, { id });
          }),
      );
      await repairOfferRules(NOW); // API antiga pode terminar depois da seleção do lote de fechamento.
      expect((await row(id)).status).toBe('accepted');
      const rows = await offers(id);
      expect(rows.length).toBeLessThanOrEqual(1);
      expect(rows.every((item) => item.outcome === 'closed')).toBe(true);
      expect(await histories(id)).toBe(0);
    }
  });

  it('fechamento selecionado relê status depois da trava; se voltou a pending conserva open', async () => {
    const id = await contract({ status: 'accepted' });
    await offer(id);
    const blocker = await pool.getConnection();
    let pending:
      Promise<ReturnType<typeof repairOfferRules> extends Promise<infer T> ? T : never> | undefined;
    try {
      await blocker.beginTransaction();
      await blocker.query(`UPDATE contracts SET status = 'pending' WHERE id = :id`, { id });
      pending = repairOfferRules(NOW);
      await waitForContractWaiters(1);
      await blocker.commit();
    } finally {
      await blocker.rollback();
      blocker.release();
      if (pending) await pending;
    }
    expect((await pending!).closedOffers).toBe(0);
    expect((await offers(id))[0]).toMatchObject({ outcome: 'open', resolved_at: null });
  });

  it('oferta1 selecionada relê o aceite após a espera e não cria uma proposta já encerrada', async () => {
    const id = await contract({ status: 'pending', expires: NOW });
    const blocker = await pool.getConnection();
    let pending: ReturnType<typeof repairOfferRules> | undefined;
    try {
      await blocker.beginTransaction();
      await blocker.query(`UPDATE contracts SET status = 'accepted' WHERE id = :id`, { id });
      pending = repairOfferRules(NOW);
      await waitForContractWaiters(1);
      await blocker.commit();
    } finally {
      await blocker.rollback();
      blocker.release();
      if (pending) await pending;
    }
    expect((await pending!).offerOne).toBe(0);
    expect(await offers(id)).toEqual([]);
    expect(await histories(id)).toBe(0);
  });
});
