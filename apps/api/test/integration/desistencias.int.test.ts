import type { ContractWithHistory } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { QueryValues } from 'mysql2';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { runReconcileDropoutReviews } from '../../src/jobs/reconcile-dropout-reviews';
import { contractsRepository } from '../../src/modules/contracts/contracts.repository';
import { dropoutsRepository } from '../../src/modules/dropouts/dropouts.repository';
import { dropoutsService } from '../../src/modules/dropouts/dropouts.service';
import { reportsRepository } from '../../src/modules/reports/reports.repository';
import { openQueue } from '../../src/modules/reports/moderation.health';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { setClockForTests } from '../../src/utils/clock';
import { deleteUsersWithoutLedger } from './helpers/ledger-cleanup';

const app = createApp();
const NOW = new Date('2026-10-09T15:00:00Z');
const DAY = 86_400_000;
const ownedUsers: number[] = [],
  ownedContracts: number[] = [],
  ownedBarters: number[] = [];
interface Actor {
  id: number;
  token: string;
}
const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
async function actor(role: 'client' | 'freelancer'): Promise<Actor> {
  const key = ulid();
  const [r] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid,email,role,status,timezone) VALUES (:key,:email,:role,'active','America/Sao_Paulo')`,
    { key, email: `dropouts-${key}@escambo.test`, role },
  );
  ownedUsers.push(r.insertId);
  await walletRepository.ensure(r.insertId);
  await pool.query(
    'UPDATE wallets SET balance = 5000, credits_balance = 5000 WHERE user_id = :id',
    { id: r.insertId },
  );
  return {
    id: r.insertId,
    token: jwt.sign({ uid: r.insertId, sub: key, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}
async function accepted(
  c: Actor,
  f: Actor,
  mode: 'cash' | 'credits' | 'barter' = 'cash',
  barter?: number,
) {
  const [r] = await pool.query<ResultSetHeader>(
    `INSERT INTO contracts (ulid,client_id,freelancer_id,title,description,price,platform_fee,freelancer_net,status,payment_mode,accepted_at,created_at,barter_agreement_id)
     VALUES (:key,:client,:freelancer,'Desistência privada RN-026','Fixture de uma contratação aceita',100,15,85,'accepted',:mode,:now,:now,:barter)`,
    { key: ulid(), client: c.id, freelancer: f.id, mode, now: NOW, barter: barter ?? null },
  );
  ownedContracts.push(r.insertId);
  if (mode !== 'barter') {
    await pool.query(
      mode === 'cash'
        ? 'UPDATE wallets SET balance = balance - 100 WHERE user_id = :id'
        : 'UPDATE wallets SET credits_balance = credits_balance - 85 WHERE user_id = :id',
      { id: c.id },
    );
    await pool.query(
      mode === 'cash'
        ? 'UPDATE wallets SET balance_pending = balance_pending + 85 WHERE user_id = :id'
        : 'UPDATE wallets SET credits_pending = credits_pending + 85 WHERE user_id = :id',
      { id: f.id },
    );
  }
  return r.insertId;
}
async function detail(id: number, a: Actor) {
  const r = await request(app).get(`/api/contracts/${id}`).set(auth(a));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as ContractWithHistory;
}
const cancel = (id: number, a: Actor, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/contracts/${id}/cancel`).set(auth(a)).send(body);
async function rows(sql: string, params: QueryValues = {}) {
  return (await pool.query<RowDataPacket[]>(sql, params))[0];
}
const dropouts = (uid: number) =>
  rows('SELECT * FROM freelancer_dropouts WHERE freelancer_id = :uid ORDER BY id', { uid });
const reviews = (uid: number) =>
  rows(
    "SELECT * FROM content_reports WHERE target_type = 'user' AND target_id = :uid AND description LIKE 'Desistências:%' ORDER BY id",
    { uid },
  );
const financial = (id: number, c: Actor, f: Actor) =>
  Promise.all([
    rows(
      'SELECT user_id,balance,balance_pending,credits_balance,credits_pending FROM wallets WHERE user_id IN (:c,:f) ORDER BY user_id',
      { c: c.id, f: f.id },
    ),
    rows(
      'SELECT user_id,amount,pending_delta,reason FROM wallet_transactions WHERE contract_id = :id ORDER BY id',
      { id },
    ),
    rows(
      'SELECT user_id,amount,reason FROM credit_transactions WHERE contract_id = :id ORDER BY id',
      { id },
    ),
    rows('SELECT * FROM contract_status_history WHERE contract_id = :id ORDER BY id', { id }),
  ]);
async function seedDropout(c: Actor, f: Actor, at = NOW) {
  const id = await accepted(c, f, 'barter');
  await pool.query("UPDATE contracts SET status = 'cancelled',cancelled_at = :at WHERE id = :id", {
    id,
    at,
  });
  await pool.query(
    'INSERT INTO freelancer_dropouts (contract_id,freelancer_id,dropped_at) VALUES (:id,:uid,:at)',
    { id, uid: f.id, at },
  );
  return id;
}
/** Confirma espera no InnoDB, sem presumir concorrência pelo tempo de execução. */
async function waiters(table: 'users' | 'contracts' | 'wallets', n = 1) {
  const end = Date.now() + 5000;
  let waiting = 0;
  while (waiting < n && Date.now() < end) {
    waiting = Number(
      (
        await rows(`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
      JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
      WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = '${table}'`)
      )[0]!.n,
    );
    if (waiting < n) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(waiting, `pedidos aguardaram ${table} no MySQL`).toBeGreaterThanOrEqual(n);
}
beforeEach(() => setClockForTests(NOW, { frozen: true }));
afterEach(async () => {
  vi.restoreAllMocks();
  setClockForTests(NOW, { frozen: true });
  // Só IDs criados por esta suíte; conserva os dados das outras suítes.
  if (ownedUsers.length) {
    await pool.query(
      "DELETE FROM content_reports WHERE target_type = 'user' AND target_id IN (:ids)",
      { ids: ownedUsers },
    );
    await pool.query('DELETE FROM notifications WHERE user_id IN (:ids)', { ids: ownedUsers });
  }
  if (ownedContracts.length)
    await pool.query('DELETE FROM contracts WHERE id IN (:ids)', { ids: ownedContracts });
  if (ownedBarters.length)
    await pool.query('DELETE FROM barter_agreements WHERE id IN (:ids)', { ids: ownedBarters });
  // Extrato imutável (RNF-036): quem tem lançamento fica, com os lançamentos.
  await deleteUsersWithoutLedger(ownedUsers);
  ownedUsers.length = ownedContracts.length = ownedBarters.length = 0;
});
afterAll(async () => {
  setClockForTests(null);
  await pool.end();
});

describe('RN-026: reembolso, reputação e revisão durável', () => {
  it.each(['Desistências:', 'Reincidência:'] as const)(
    'uma denúncia normal com prefixo %s não bloqueia revisão nem escapa da meta',
    async (prefix) => {
      const c = await actor('client'),
        f = await actor('freelancer');
      const before = await openQueue(NOW, 24);
      await pool.query(
        `INSERT INTO content_reports (reporter_id,target_type,target_id,reason,description,created_at)
      VALUES (:c,'user',:f,'other',:description,:created)`,
        {
          c: c.id,
          f: f.id,
          description: `${prefix} relato do usuário`,
          created: new Date(NOW.getTime() - 2 * DAY),
        },
      );
      expect(await reportsRepository.hasOpenAccountReview(f.id, prefix)).toBe(false);
      expect(
        await reportsRepository.openAccountReview({
          userId: f.id,
          prefix,
          description: `${prefix} revisão do sistema`,
        }),
      ).toBe(true);
      const after = await openQueue(NOW, 24);
      expect(after.pending).toBe(before.pending + 2);
      expect(after.reviews).toBe(before.reviews + 1);
      expect(after.automatic).toBe(before.automatic);
      expect(after.overSla).toBe(before.overSla + 1);
    },
  );

  it('revisão legada feita por admin conserva deduplicação e fica fora da meta', async () => {
    const admin = await actor('client'),
      f = await actor('freelancer');
    await pool.query("UPDATE users SET role='admin' WHERE id=:id", { id: admin.id });
    const before = await openQueue(NOW, 24);
    await pool.query(
      `INSERT INTO content_reports (reporter_id,target_type,target_id,reason,description,created_at)
      VALUES (:admin,'user',:f,'other','Reincidência: revisão legada',:created)`,
      { admin: admin.id, f: f.id, created: new Date(NOW.getTime() - 2 * DAY) },
    );
    expect(await reportsRepository.hasOpenAccountReview(f.id, 'Reincidência:')).toBe(true);
    expect(
      await reportsRepository.openAccountReview({
        userId: f.id,
        prefix: 'Reincidência:',
        description: 'Reincidência: duplicata',
      }),
    ).toBe(false);
    const after = await openQueue(NOW, 24);
    expect(after.reviews).toBe(before.reviews + 1);
    expect(after.overSla).toBe(before.overSla);
  });

  it('duas revisões da mesma causa aguardam a trava da conta e abrem uma só', async () => {
    const f = await actor('freelancer');
    const blocker = await pool.getConnection();
    let pending: Promise<boolean[]> | undefined;
    try {
      await blocker.beginTransaction();
      await blocker.query('SELECT id FROM users WHERE id=:id FOR UPDATE', { id: f.id });
      const input = {
        userId: f.id,
        prefix: 'Desistências:' as const,
        description: 'Desistências: revisão concorrente do sistema',
      };
      pending = Promise.all([
        reportsRepository.openAccountReview(input),
        reportsRepository.openAccountReview(input),
      ]);
      await waiters('users', 2);
      await blocker.commit();
      expect((await pending).sort()).toEqual([false, true]);
      expect(await reviews(f.id)).toHaveLength(1);
    } finally {
      await blocker.rollback();
      blocker.release();
      if (pending) await pending;
    }
  });

  it('uma falha ao inserir a desistência desfaz o reembolso e a mudança de status', async () => {
    const c = await actor('client'),
      f = await actor('freelancer');
    const id = await accepted(c, f);
    // Violação deliberada do UNIQUE: prova o rollback mesmo depois dos movimentos financeiros.
    await pool.query(
      'INSERT INTO freelancer_dropouts (contract_id,freelancer_id,dropped_at) VALUES (:id,:uid,:now)',
      { id, uid: f.id, now: NOW },
    );
    const before = await financial(id, c, f);
    await expect(
      contractsRepository.transition({
        id,
        changedBy: f.id,
        source: 'user',
        from: 'accepted',
        to: 'cancelled',
        note: 'Reembolso em rollback',
        timestampColumn: 'cancelled_at',
        now: NOW,
        dropout: { freelancerId: f.id, expectedCountAfter: 2 },
        walletEffects: [
          { userId: f.id, pendingDelta: -85, balanceDelta: 0, reason: 'escrow_refund' },
          { userId: c.id, pendingDelta: 0, balanceDelta: 100, reason: 'refund' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(await financial(id, c, f)).toEqual(before);
    expect((await detail(id, f)).status).toBe('accepted');
    expect(await dropouts(f.id)).toHaveLength(1);
  });

  it('esperar a carteira não confirma um total que venceu durante o reembolso', async () => {
    const c = await actor('client'),
      f = await actor('freelancer');
    await seedDropout(c, f, new Date(NOW.getTime() - 60 * DAY));
    const id = await accepted(c, f);
    const before = await financial(id, c, f);
    const blocker = await pool.getConnection();
    let pending: Promise<request.Response> | undefined;
    try {
      await blocker.beginTransaction();
      await blocker.query('SELECT user_id FROM wallets WHERE user_id=:id FOR UPDATE', { id: f.id });
      pending = Promise.resolve(cancel(id, f, { expectedDropoutCount: 2 }));
      await waiters('wallets');
      setClockForTests(new Date(NOW.getTime() + 1000), { frozen: true });
      await blocker.commit();
      const r = await pending;
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('cancel_quote_changed');
      expect(await financial(id, c, f)).toEqual(before);
      expect(await dropouts(f.id)).toHaveLength(1);
    } finally {
      await blocker.rollback();
      blocker.release();
      if (pending) await pending;
    }
  });

  it.each(['cash', 'credits'] as const)(
    'desistência em %s reembolsa e registra uma vez',
    async (mode) => {
      const c = await actor('client'),
        f = await actor('freelancer');
      const id = await accepted(c, f, mode);
      const before = await financial(id, c, f);
      const quote = (await detail(id, f)).cancellation!;
      expect(quote.dropout).toEqual({
        countAfter: 1,
        windowDays: 60,
        alertAt: 3,
        alertUntil: null,
      });
      expect((await detail(id, c)).cancellation?.dropout).toBeUndefined();
      const result = await cancel(id, f, {
        expectedRefund: quote.refundClient,
        expectedDropoutCount: 1,
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const ds = await dropouts(f.id);
      expect(ds).toHaveLength(1);
      expect(ds[0]!.dropped_at).toEqual(NOW);
      expect(ds[0]!.review_checked_at).toEqual(NOW);
      expect(await reviews(f.id)).toHaveLength(0);
      const wallets = (await financial(id, c, f))[0];
      expect(
        Number(
          wallets.find((w) => w.user_id === c.id)![mode === 'cash' ? 'balance' : 'credits_balance'],
        ),
      ).toBe(5000);
      expect(
        Number(
          wallets.find((w) => w.user_id === f.id)![
            mode === 'cash' ? 'balance_pending' : 'credits_pending'
          ],
        ),
      ).toBe(0);
      const after = await financial(id, c, f);
      expect((await cancel(id, f)).status).toBe(409);
      expect(await financial(id, c, f)).toEqual(after);
      expect(before).not.toEqual(after);
      const d = (await detail(id, c)).dropout!;
      expect(Object.keys(d).sort()).toEqual(['agreeUntil', 'agreedAt', 'at', 'counts']);
      expect(d).toEqual({
        at: NOW.toISOString(),
        agreedAt: null,
        agreeUntil: new Date(NOW.getTime() + 7 * DAY).toISOString(),
        counts: true,
      });
    },
  );

  it('troca registra só o freelancer que desistiu; contraparte e torna seguem o fluxo existente', async () => {
    const c = await actor('client'),
      f = await actor('freelancer');
    const [b] = await pool.query<ResultSetHeader>(
      `INSERT INTO barter_agreements (ulid,proposer_id,receiver_id,estimated_value_offered,estimated_value_requested,status,accepted_at)
       VALUES (:key,:c,:f,100,100,'active',:now)`,
      { key: ulid(), c: c.id, f: f.id, now: NOW },
    );
    ownedBarters.push(b.insertId);
    const id = await accepted(c, f, 'barter', b.insertId),
      opposite = await accepted(f, c, 'barter', b.insertId);
    await pool.query(
      'UPDATE barter_agreements SET contract_offered_id=:opposite,contract_requested_id=:id WHERE id=:b',
      { opposite, id, b: b.insertId },
    );
    const wallets = (await financial(id, c, f))[0];
    expect((await cancel(id, f)).status).toBe(200);
    expect((await dropouts(f.id)).map((d) => d.contract_id)).toEqual([id]);
    expect(await dropouts(c.id)).toHaveLength(0);
    expect((await financial(id, c, f))[0]).toEqual(wallets);
    expect(
      (await rows('SELECT status FROM barter_agreements WHERE id=:id', { id: b.insertId }))[0]!
        .status,
    ).toBe('disputed');
    expect((await detail(opposite, c)).dropout).toBeNull();
  });

  it('cancelamento pelo cliente, retirada e recusa antes do aceite não contam', async () => {
    const c = await actor('client'),
      f = await actor('freelancer');
    const id = await accepted(c, f);
    expect((await cancel(id, c)).status).toBe(200);
    for (const action of ['cancel', 'reject']) {
      const created = await request(app).post('/api/contracts').set(auth(c)).send({
        freelancerId: f.id,
        title: 'Proposta sem desistência',
        description: 'Recusa e retirada de proposta antes do aceite',
        price: 100,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      ownedContracts.push(created.body.id);
      const result = await request(app)
        .post(`/api/contracts/${created.body.id}/${action}`)
        .set(auth(action === 'cancel' ? c : f))
        .send({});
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    }
    expect(await dropouts(f.id)).toHaveLength(0);
  });

  it('cotação antiga é recusada sem mudar saldo, histórico ou reputação', async () => {
    const c = await actor('client'),
      f = await actor('freelancer');
    const id = await accepted(c, f);
    await seedDropout(c, f);
    const before = await financial(id, c, f);
    const r = await cancel(id, f, { expectedDropoutCount: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cancel_quote_changed');
    expect(await financial(id, c, f)).toEqual(before);
    expect(await dropouts(f.id)).toHaveLength(1);
    // Uma falha na carteira também não cria a desistência.
    await pool.query('UPDATE wallets SET balance_pending=0 WHERE user_id=:uid', { uid: f.id });
    const broke = await financial(id, c, f);
    expect((await cancel(id, f, { expectedDropoutCount: 2 })).status).toBe(409);
    expect(await financial(id, c, f)).toEqual(broke);
    expect((await detail(id, f)).status).toBe('accepted');
    expect(await dropouts(f.id)).toHaveLength(1);
  });

  it('duas desistências simultâneas da mesma conta conferem o total sob a trava', async () => {
    const c = await actor('client'),
      f = await actor('freelancer');
    const a = await accepted(c, f),
      b = await accepted(c, f);
    const blocker = await pool.getConnection();
    let pending: Promise<request.Response[]> | undefined;
    try {
      await blocker.beginTransaction();
      await blocker.query('SELECT id FROM users WHERE id=:id FOR UPDATE', { id: f.id });
      pending = Promise.all([
        cancel(a, f, { expectedDropoutCount: 1 }),
        cancel(b, f, { expectedDropoutCount: 1 }),
      ]);
      await waiters('users', 2);
      await blocker.commit();
      const results = await pending;
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.error).toBe('cancel_quote_changed');
      expect(await dropouts(f.id)).toHaveLength(1);
      const other = results[0]!.status === 200 ? b : a;
      expect((await cancel(other, f, { expectedDropoutCount: 2 })).status).toBe(200);
      expect(await dropouts(f.id)).toHaveLength(2);
    } finally {
      await blocker.rollback();
      blocker.release();
      if (pending) await pending;
    }
  });

  it('falha depois do reembolso fica pendente; job recupera uma revisão por causa e não reabre evento antigo', async () => {
    const c = await actor('client'),
      f = await actor('freelancer');
    await seedDropout(c, f);
    await seedDropout(c, f);
    const id = await accepted(c, f);
    const hook = vi
      .spyOn(dropoutsService, 'afterDropout')
      .mockRejectedValueOnce(new Error('indisponível após COMMIT'));
    expect((await cancel(id, f, { expectedDropoutCount: 3 })).status).toBe(200);
    expect((await dropouts(f.id)).every((d) => d.review_checked_at === null)).toBe(true);
    expect(await reviews(f.id)).toHaveLength(0);
    hook.mockRestore();
    await reportsRepository.openAccountReview({
      userId: f.id,
      prefix: 'Reincidência:',
      description: 'Reincidência: outra causa independente',
    });
    expect(await runReconcileDropoutReviews()).toEqual({ processed: 3, reviewsOpened: 1 });
    expect(await reviews(f.id)).toHaveLength(1);
    const report = (await reviews(f.id))[0]!;
    expect(report.reporter_id).toBeNull();
    expect(report.status).toBe('pending');
    expect((await dropouts(f.id)).every((d) => d.review_checked_at instanceof Date)).toBe(true);
    expect((await rows('SELECT status FROM users WHERE id=:id', { id: f.id }))[0]!.status).toBe(
      'active',
    );
    await pool.query("UPDATE content_reports SET status='dismissed' WHERE id=:id", {
      id: report.id,
    });
    expect(await runReconcileDropoutReviews()).toEqual({ processed: 0, reviewsOpened: 0 });
    expect(await reviews(f.id)).toHaveLength(1);
    const next = await accepted(c, f);
    expect((await cancel(next, f, { expectedDropoutCount: 4 })).status).toBe(200);
    expect(await reviews(f.id)).toHaveLength(2);
  });

  it('review e marker falham juntos; duas reconciliações criam somente uma revisão', async () => {
    const c = await actor('client'),
      f = await actor('freelancer');
    for (let i = 0; i < 3; i++) await seedDropout(c, f);
    const insert = vi
      .spyOn(reportsRepository, 'openAccountReview')
      .mockRejectedValueOnce(new Error('INSERT falhou'));
    await expect(dropoutsRepository.reconcileReviews(f.id)).rejects.toThrow('INSERT falhou');
    expect((await dropouts(f.id)).every((d) => d.review_checked_at === null)).toBe(true);
    insert.mockRestore();
    const result = await Promise.all([
      dropoutsRepository.reconcileReviews(f.id),
      dropoutsRepository.reconcileReviews(f.id),
    ]);
    expect(result.reduce((n, r) => n + r.checked, 0)).toBe(3);
    expect(await reviews(f.id)).toHaveLength(1);
    expect((await dropouts(f.id)).every((d) => d.review_checked_at !== null)).toBe(true);
  });

  it('janela é recontada depois de esperar a contratação', async () => {
    const c = await actor('client'),
      f = await actor('freelancer');
    const old = new Date(NOW.getTime() - 60 * DAY);
    await seedDropout(c, f, old);
    const id = await accepted(c, f);
    expect((await detail(id, f)).cancellation!.dropout!.countAfter).toBe(2);
    const blocker = await pool.getConnection();
    let pending: Promise<request.Response> | undefined;
    try {
      await blocker.beginTransaction();
      await blocker.query('SELECT id FROM contracts WHERE id=:id FOR UPDATE', { id });
      pending = Promise.resolve(cancel(id, f, { expectedDropoutCount: 2 }));
      await waiters('contracts');
      setClockForTests(new Date(NOW.getTime() + 1000), { frozen: true });
      await blocker.commit();
      const r = await pending;
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('cancel_quote_changed');
      expect((await detail(id, f)).status).toBe('accepted');
      expect((await detail(id, f)).cancellation!.dropout!.countAfter).toBe(1);
    } finally {
      await blocker.rollback();
      blocker.release();
      if (pending) await pending;
    }
  });
});
