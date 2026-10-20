import type { AdminFinanceReport, AdminMetrics, AdminUsageReport } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { runReportSnapshots } from '../../src/jobs/report-snapshots';
import { setClockForTests } from '../../src/utils/clock';

/**
 * Métricas e relatórios do admin contra o MySQL real (RF-076, RF-081): chamados de suporte no
 * painel, a semana de segunda a domingo em Brasília, o uso por período com a definição de ativo e
 * o snapshot gravado pelo job, idempotente e lido pelo relatório. Os períodos dos relatórios são
 * dias de 2024, que nenhum outro arquivo usa; as métricas do painel são medidas por diferença.
 */
const app = createApp();

interface Actor {
  id: number;
  key: string;
  token: string;
}

const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });

async function actor(
  role: 'client' | 'freelancer' | 'admin' = 'client',
  createdAt: Date | null = null,
): Promise<Actor> {
  const key = ulid();
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone, email_frequency, created_at)
     VALUES (:key, :email, :role, 'active', 'America/Sao_Paulo', 'off', COALESCE(:createdAt, NOW()))`,
    { key, email: `relatorio-${key}@escambo.test`, role, createdAt },
  );
  return {
    id: res.insertId,
    key,
    token: jwt.sign({ sub: key, uid: res.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

async function contract(
  client: Actor,
  freelancer: Actor,
  fields: { status?: string; createdAt?: Date; completedAt?: Date; cancelledAt?: Date } = {},
): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO contracts (ulid, client_id, freelancer_id, title, description, price,
       platform_fee, freelancer_net, payment_mode, status, created_at, completed_at, cancelled_at)
     VALUES (:key, :clientId, :freelancerId, 'Relatório de uso', 'Contrato fictício da integração',
       100, 15, 85, 'cash', :status, COALESCE(:createdAt, NOW()), :completedAt, :cancelledAt)`,
    {
      key: ulid(),
      clientId: client.id,
      freelancerId: freelancer.id,
      status: fields.status ?? 'accepted',
      createdAt: fields.createdAt ?? null,
      completedAt: fields.completedAt ?? null,
      cancelledAt: fields.cancelledAt ?? null,
    },
  );
  return res.insertId;
}

async function session(user: Actor, at: Date): Promise<void> {
  await pool.query(
    `INSERT INTO user_sessions (user_id, refresh_token, expires_at, created_at)
     VALUES (:userId, :token, :expires, :at)`,
    {
      userId: user.id,
      token: `relatorio-${ulid()}`,
      expires: new Date(at.getTime() + 86_400_000),
      at,
    },
  );
}

async function message(from: Actor, to: Actor, at: Date, type: 'text' | 'system' = 'text') {
  // LAST_INSERT_ID(id) faz o insertId devolver a conversa que já existia, na mesma conexão.
  const [conv] = await pool.query<ResultSetHeader>(
    `INSERT INTO conversations (participant_a, participant_b, created_at)
     VALUES (:a, :b, :at) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    { a: Math.min(from.id, to.id), b: Math.max(from.id, to.id), at },
  );
  await pool.query(
    `INSERT INTO messages (conversation_id, sender_id, type, content, created_at)
     VALUES (:conv, :from, :type, 'Mensagem do relatório', :at)`,
    { conv: conv.insertId, from: from.id, type, at },
  );
}

/** Mudança de status com a origem que a API grava (migration 0048): 'system' é a plataforma. */
async function statusChange(
  contractId: number,
  by: Actor,
  at: Date,
  note: string | null,
  newStatus = 'in_progress',
  source: 'user' | 'system' = 'user',
): Promise<void> {
  await pool.query(
    `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note, source, created_at)
     VALUES (:contractId, :by, 'accepted', :newStatus, :note, :source, :at)`,
    { contractId, by: by.id, newStatus, note, source, at },
  );
}

const metrics = async (admin: Actor): Promise<AdminMetrics> => {
  const res = await request(app).get('/api/admin/metrics').set(auth(admin));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as AdminMetrics;
};
const usage = async (admin: Actor, qs: string): Promise<AdminUsageReport> => {
  const res = await request(app).get(`/api/admin/usage?${qs}`).set(auth(admin));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as AdminUsageReport;
};

afterEach(() => setClockForTests(null));
afterAll(async () => {
  await pool.end();
});

describe('RF-076: chamados de suporte nas métricas do painel', () => {
  it('em aberto, aguardando a equipe e SLA vencido; a resposta pública e a conta anonimizada tiram da conta', async () => {
    setClockForTests(new Date(), { frozen: true });
    const admin = await actor('admin');
    const user = await actor('client');
    const client = await actor('client');
    await request(app).get('/api/admin/metrics').set(auth(client)).expect(403);

    const before = await metrics(admin);
    const open = async (subject: string): Promise<number> => {
      const res = await request(app).post('/api/support/tickets').set(auth(user)).send({
        category: 'account',
        subject,
        description: 'Preciso de ajuda com a minha conta, por favor.',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as number;
    };
    const a = await open(`Chamado A ${ulid()}`);
    await open(`Chamado B ${ulid()}`);
    const d = (m: AdminMetrics) => ({
      open: m.supportOpen - before.supportOpen,
      awaiting: m.supportAwaitingReply - before.supportAwaitingReply,
      overdue: m.supportSlaOverdue - before.supportSlaOverdue,
    });
    expect(d(await metrics(admin))).toEqual({ open: 2, awaiting: 2, overdue: 0 });

    // O prazo de primeira resposta do A passou sem resposta pública.
    await pool.query('UPDATE support_tickets SET sla_due_at = :due WHERE id = :id', {
      id: a,
      due: new Date(Date.now() - 3_600_000),
    });
    expect(d(await metrics(admin))).toEqual({ open: 2, awaiting: 2, overdue: 1 });

    // Nota interna não é resposta: continua vencido e aguardando a equipe.
    await request(app)
      .post(`/api/admin/support/tickets/${a}/messages`)
      .set(auth(admin))
      .send({ message: 'Verificando internamente.', internal: true })
      .expect(201);
    expect(d(await metrics(admin))).toEqual({ open: 2, awaiting: 2, overdue: 1 });

    // Resposta pública: a vez passa ao titular e o SLA de primeira resposta está cumprido.
    await request(app)
      .post(`/api/admin/support/tickets/${a}/messages`)
      .set(auth(admin))
      .send({ message: 'Pode conferir de novo, por favor?' })
      .expect(201);
    expect(d(await metrics(admin))).toEqual({ open: 2, awaiting: 1, overdue: 0 });

    // Conta anonimizada (LGPD): os chamados ficam congelados e saem da fila do painel.
    await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = :id', { id: user.id });
    expect(d(await metrics(admin))).toEqual({ open: 0, awaiting: 0, overdue: 0 });
  });
});

describe('RF-081: semana de segunda a domingo em Brasília', () => {
  // Domingo 29/12/2024 23:59:59 em Brasília é 30/12 02:59:59 UTC; a segunda começa às 03:00 UTC.
  const SUNDAY_LAST_SECOND = new Date('2024-12-30T02:59:59Z');
  const MONDAY_FIRST_SECOND = new Date('2024-12-30T03:00:00Z');

  it('financeiro e uso põem o último segundo de domingo numa semana e a meia-noite de segunda na outra', async () => {
    const admin = await actor('admin');
    const sunday = await actor('client', SUNDAY_LAST_SECOND);
    const monday = await actor('freelancer', MONDAY_FIRST_SECOND);
    // Taxa retida (fora depósito e saque, o que some do ledger é receita): 10 no domingo, 20 na segunda.
    for (const [user, amount, at] of [
      [sunday, -10, SUNDAY_LAST_SECOND],
      [monday, -20, MONDAY_FIRST_SECOND],
    ] as const) {
      await pool.query(
        `INSERT INTO wallet_transactions (user_id, amount, pending_delta, balance_after, pending_after, reason, created_at)
         VALUES (:userId, :amount, 0, 0, 0, 'payment', :at)`,
        { userId: user.id, amount, at },
      );
    }

    const fin = await request(app)
      .get('/api/admin/finance?from=2024-12-23&to=2025-01-05&granularity=week')
      .set(auth(admin))
      .expect(200);
    const report = fin.body as AdminFinanceReport;
    expect(report.granularity).toBe('week');
    expect(report.series.map((b) => [b.bucket, b.revenue])).toEqual([
      ['2024-12-23', 10],
      ['2024-12-30', 20],
    ]);

    const weekly = await usage(admin, 'from=2024-12-23&to=2025-01-05&granularity=week');
    expect(weekly.series.map((b) => [b.bucket, b.newUsers, b.source])).toEqual([
      ['2024-12-23', 1, 'live'],
      ['2024-12-30', 1, 'live'],
    ]);
    // Por dia, os mesmos instantes caem em domingo 29 e segunda 30.
    const daily = await usage(admin, 'from=2024-12-29&to=2024-12-30&granularity=day');
    expect(daily.series.map((b) => [b.bucket, b.newUsers])).toEqual([
      ['2024-12-29', 1],
      ['2024-12-30', 1],
    ]);
    // A semana que atravessa o ano é uma só, com a chave na segunda-feira.
    const monthly = await usage(admin, 'from=2024-12-01&to=2025-01-31&granularity=month');
    expect(monthly.series.map((b) => [b.bucket, b.newUsers])).toEqual([
      ['2024-12', 2],
      ['2025-01', 0],
    ]);
  });
});

describe('RF-081: uso por período e snapshot', () => {
  // Quarta 13/11/2024 em Brasília: das 03:00 UTC do dia 13 às 03:00 UTC do dia 14.
  const DAY = '2024-11-13';
  const noon = new Date('2024-11-13T15:00:00Z');
  let admin: Actor;
  let lateSession: Actor;

  it('ativo é sessão, mensagem ou mudança de status própria; admin, mensagem de sistema e mudança automática não contam', async () => {
    admin = await actor('admin');
    const [withSession, withMessage, withChange, systemOnly, tacit, expired, autoDispute] =
      await Promise.all(Array.from({ length: 7 }, () => actor('client', noon)));
    lateSession = systemOnly!;
    const freelancer = await actor('freelancer');

    await session(withSession!, noon);
    await session(admin, noon); // a equipe não é uso
    await message(withMessage!, freelancer, noon);
    await message(systemOnly!, freelancer, noon, 'system');

    const done = await contract(withChange!, freelancer, {
      status: 'completed',
      createdAt: noon,
      completedAt: noon,
    });
    await statusChange(done, withChange!, noon, null, 'completed');
    const gone = await contract(tacit!, freelancer, { status: 'cancelled', cancelledAt: noon });
    await statusChange(
      gone,
      tacit!,
      noon,
      'Aprovação tácita: sem resposta do cliente até 13/11/2024 12:00',
      'in_progress',
      'system',
    );
    await statusChange(
      gone,
      expired!,
      noon,
      'Proposta expirada: sem resposta do freelancer até 13/11/2024',
      'in_progress',
      'system',
    );
    const disputed = await contract(autoDispute!, freelancer);
    await pool.query(
      `INSERT INTO disputes (ulid, contract_id, opened_by, reason, description)
       VALUES (:key, :contractId, :openedBy, 'deadline', :description)`,
      {
        key: ulid(),
        contractId: disputed,
        openedBy: autoDispute!.id,
        description: 'Aberta automaticamente pela plataforma (RN-029): o prazo venceu sem entrega.',
      },
    );
    await statusChange(disputed, autoDispute!, noon, 'Disputa aberta', 'disputed', 'system');

    const r = await usage(admin, `from=${DAY}&to=${DAY}&granularity=day`);
    expect(r.series).toEqual([
      {
        bucket: DAY,
        source: 'live',
        // Os 7 clientes do dia; o freelancer e o admin foram criados hoje.
        newUsers: 7,
        newContracts: 1,
        completedContracts: 1,
        cancelledContracts: 1,
        activeUsers: 3,
      },
    ]);
    expect(r.totals.activeUsers).toBe(3);
    expect(r.activeDefinition).toContain('Administradores');
  });

  it('o job grava o snapshot do dia fechado uma vez só, e o relatório passa a ler dele', async () => {
    // Quinta 14/11/2024 ao meio-dia em Brasília: fechou o dia 13, a semana de 04 a 10/11 e outubro.
    const now = new Date('2024-11-14T15:00:00Z');
    setClockForTests(now, { frozen: true });

    const first = await runReportSnapshots(now);
    expect(first.closedDay).toBe(DAY);
    expect(first.failed).toEqual([]);
    expect(first.written).toEqual(
      expect.arrayContaining(['daily:2024-11-13', 'weekly:2024-11-04', 'monthly:2024-10-01']),
    );
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT period_end, new_users, new_contracts, completed_contracts, cancelled_contracts,
              active_users, platform_fees, total_revenue, payload, generated_at
         FROM report_snapshots WHERE period_type = 'daily' AND period_start = :day`,
      { day: DAY },
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      new_users: 7,
      new_contracts: 1,
      completed_contracts: 1,
      cancelled_contracts: 1,
      active_users: 3,
      platform_fees: '0.00',
      total_revenue: '100.00', // GMV: a contratação em dinheiro concluída no dia
    });
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    expect(payload).toMatchObject({ version: 1, completedCashContracts: 1 });

    // Idempotente: a segunda rodada não grava nem recalcula nada.
    const second = await runReportSnapshots(now);
    expect(second.written).toEqual([]);
    const [again] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n, MAX(generated_at) AS generated_at FROM report_snapshots
        WHERE period_type = 'daily' AND period_start = :day`,
      { day: DAY },
    );
    expect(Number(again[0]!.n)).toBe(1);
    expect(new Date(again[0]!.generated_at).getTime()).toBe(new Date(row.generated_at).getTime());

    // Depois do snapshot, chega mais uma sessão com data do dia 13 (dado de origem mudou): o balde
    // do dia continua a fotografia gravada; o total do período, calculado agora, vê a mudança.
    await session(lateSession, noon);
    const r = await usage(admin, `from=${DAY}&to=${DAY}&granularity=day`);
    expect(r.series[0]).toMatchObject({ bucket: DAY, source: 'snapshot', activeUsers: 3 });
    expect(r.totals.activeUsers).toBe(4);

    // A semana e o mês fechados também saem do snapshot; a semana cortada pelo período, não.
    const weekly = await usage(admin, 'from=2024-11-04&to=2024-11-13&granularity=week');
    expect(weekly.series.map((b) => [b.bucket, b.source])).toEqual([
      ['2024-11-04', 'snapshot'],
      ['2024-11-11', 'live'],
    ]);
    expect(weekly.series[1]).toMatchObject({ newUsers: 7, activeUsers: 4 });
  });
});
