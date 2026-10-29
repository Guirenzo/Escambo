import type { SupportTicketDetail } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { runSupportMaintenance } from '../../src/jobs/support-maintenance';
import { buildExport } from '../../src/modules/lgpd/lgpd.export';
import { setClockForTests } from '../../src/utils/clock';

/** HTTP, SQL e relógio reais: suporte privado não concede poderes financeiros. */
const app = createApp();
const BASE = new Date('2026-10-15T15:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const actors: number[] = [];
const contracts: number[] = [];

interface Actor {
  id: number;
  key: string;
  token: string;
}

const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
const at = (offset = 0) => setClockForTests(new Date(BASE.getTime() + offset), { frozen: true });

async function actor(role: 'client' | 'freelancer' | 'admin' = 'client'): Promise<Actor> {
  const key = ulid();
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone, email_frequency, email_verified_at)
     VALUES (:key, :email, :role, 'active', 'America/Sao_Paulo', 'off', NOW())`,
    { key, email: `support-${key}@escambo.test`, role },
  );
  actors.push(res.insertId);
  return {
    id: res.insertId,
    key,
    token: jwt.sign({ sub: key, uid: res.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

async function contract(client: Actor, freelancer: Actor): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO contracts (ulid, client_id, freelancer_id, title, description, price,
       platform_fee, freelancer_net, payment_mode, status)
     VALUES (:key, :clientId, :freelancerId, 'Suporte não movimenta dinheiro',
       'Contrato fictício exclusivo da integração', 100, 15, 85, 'cash', 'accepted')`,
    { key: ulid(), clientId: client.id, freelancerId: freelancer.id },
  );
  contracts.push(res.insertId);
  return res.insertId;
}

function opening(subject = `Atendimento ${ulid()}`, extra: Record<string, unknown> = {}) {
  return {
    category: 'account',
    subject,
    description: 'Descrição privada fictícia para atendimento.',
    ...extra,
  };
}

async function create(a: Actor, extra: Record<string, unknown> = {}): Promise<SupportTicketDetail> {
  const response = await request(app)
    .post('/api/support/tickets')
    .set(auth(a))
    .send(opening(undefined, extra));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as SupportTicketDetail;
}

async function detail(a: Actor, id: number, admin = false, beforeId?: number) {
  const response = await request(app)
    .get(`/api/${admin ? 'admin/' : ''}support/tickets/${id}`)
    .query(beforeId ? { beforeId } : {})
    .set(auth(a));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as SupportTicketDetail;
}

async function reply(
  a: Actor,
  id: number,
  extra: Record<string, unknown> = {},
  admin = false,
): Promise<SupportTicketDetail> {
  const response = await request(app)
    .post(`/api/${admin ? 'admin/' : ''}support/tickets/${id}/messages`)
    .set(auth(a))
    .send({ message: 'Resposta pública fictícia.', ...extra });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as SupportTicketDetail;
}

async function dbTicket(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM support_tickets WHERE id = :id', {
    id,
  });
  return rows[0]!;
}

async function notifications(id: number, type?: string, userId?: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT user_id, type, title, body, data FROM notifications
      WHERE JSON_EXTRACT(data, '$.supportTicketId') = :id
        ${type ? 'AND type = :type' : ''} ${userId ? 'AND user_id = :userId' : ''}
      ORDER BY id`,
    { id, type: type ?? null, userId: userId ?? null },
  );
  return rows;
}

/** As chamadas aguardam realmente a conta, em vez de depender da velocidade do Node. */
async function raceOnUser<T>(a: Actor, calls: (() => PromiseLike<T>)[], afterQueued?: () => void) {
  const blocker = await pool.getConnection();
  let results: Promise<T[]> | undefined;
  try {
    await blocker.beginTransaction();
    await blocker.query('SELECT id FROM users WHERE id = :id FOR UPDATE', { id: a.id });
    results = Promise.all(calls.map((call) => Promise.resolve(call())));
    let waiting = 0;
    const until = Date.now() + 5000;
    while (waiting < calls.length && Date.now() < until) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS waiting FROM performance_schema.data_lock_waits w
          JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
          WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'users'
            AND l.INDEX_NAME = 'PRIMARY' AND l.LOCK_DATA = :id`,
        { id: String(a.id) },
      );
      waiting = Number(rows[0]!.waiting);
      if (waiting < calls.length) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting, 'todas as chamadas chegaram à trava de users').toBeGreaterThanOrEqual(
      calls.length,
    );
    afterQueued?.();
  } finally {
    await blocker.rollback();
    blocker.release();
    // Mesmo se a barreira falhar, nenhuma requisição fica correndo contra o afterEach.
    if (results) await results.catch(() => undefined);
  }
  return results!;
}

beforeEach(() => at());

afterEach(async () => {
  // Nenhum chamado desta suíte fica elegível para jobs executados por outros arquivos.
  if (actors.length) {
    await pool.query(
      `UPDATE support_tickets SET status = 'closed', closed_at = COALESCE(closed_at, :now)
       WHERE user_id IN (:ids) AND status <> 'closed'`,
      { ids: actors, now: BASE },
    );
  }
  setClockForTests(null);
});

afterAll(async () => {
  try {
    if (actors.length) {
      await pool.query(
        `DELETE n FROM notifications n JOIN support_tickets t
           ON JSON_EXTRACT(n.data, '$.supportTicketId') = t.id WHERE t.user_id IN (:ids)`,
        { ids: actors },
      );
      await pool.query(
        `DELETE m FROM support_ticket_messages m JOIN support_tickets t ON t.id = m.ticket_id
         WHERE t.user_id IN (:ids)`,
        { ids: actors },
      );
      await pool.query('DELETE FROM support_tickets WHERE user_id IN (:ids)', { ids: actors });
      if (contracts.length)
        await pool.query('DELETE FROM contracts WHERE id IN (:ids)', { ids: contracts });
      for (const table of ['notifications', 'email_outbox', 'wallets', 'data_deletion_requests']) {
        await pool.query(`DELETE FROM ${table} WHERE user_id IN (:ids)`, { ids: actors });
      }
      await pool.query('DELETE FROM admin_actions WHERE admin_id IN (:ids)', { ids: actors });
      await pool.query('DELETE FROM users WHERE id IN (:ids)', { ids: actors });
    }
  } finally {
    setClockForTests(null);
    await pool.end();
  }
});

describe('Suporte geral — HTTP real e regras RN-007/061/064/065', () => {
  it('abre com protocolo, lista só o titular e separa respostas públicas das notas internas', async () => {
    const owner = await actor();
    const admin = await actor('admin');
    const ticket = await create(owner);
    expect(ticket).toMatchObject({
      userId: owner.id,
      status: 'open',
      priority: 'medium',
      contractId: null,
      firstResponseAt: null,
      assignedTo: null,
      slaDueAt: new Date(BASE.getTime() + DAY).toISOString(),
    });
    expect(ticket.ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0]).toMatchObject({ from: 'user', internal: false });
    await reply(admin, ticket.id, { message: 'NOTA INTERNA PRIVADA', internal: true }, true);
    at(HOUR);
    const answered = await reply(admin, ticket.id, { message: 'Orientação pública.' }, true);
    expect(answered).toMatchObject({
      status: 'waiting_user',
      assignedTo: admin.id,
      firstResponseAt: new Date(BASE.getTime() + HOUR).toISOString(),
    });
    const own = await detail(owner, ticket.id);
    expect(own.messages.map((m) => m.message)).toEqual([
      'Descrição privada fictícia para atendimento.',
      'Orientação pública.',
    ]);
    expect(own.messages.every((m) => !m.internal)).toBe(true);
    expect(JSON.stringify(await notifications(ticket.id, undefined, owner.id))).not.toContain(
      'NOTA INTERNA PRIVADA',
    );
    const list = await request(app).get('/api/support/tickets').set(auth(owner)).expect(200);
    expect(list.body.items.map((t: { id: number }) => t.id)).toEqual([ticket.id]);
  });

  it('nega leitura, resposta e fechamento de outro titular sem revelar o chamado', async () => {
    const owner = await actor();
    const other = await actor();
    const ticket = await create(owner);
    await request(app).get(`/api/support/tickets/${ticket.id}`).set(auth(other)).expect(404);
    await request(app)
      .post(`/api/support/tickets/${ticket.id}/messages`)
      .set(auth(other))
      .send({ message: 'Não pode entrar na conversa alheia.' })
      .expect(404);
    await request(app).post(`/api/support/tickets/${ticket.id}/close`).set(auth(other)).expect(404);
    const list = await request(app).get('/api/support/tickets').set(auth(other)).expect(200);
    expect(list.body.items).toEqual([]);
    expect((await detail(owner, ticket.id)).messages).toHaveLength(1);
  });

  it('reconfere papel atual do banco e bloqueia administrador suspenso', async () => {
    const admin = await actor('admin');
    const ticket = await create(await actor());
    await request(app).get('/api/admin/support/tickets').set(auth(admin)).expect(200);
    await pool.query("UPDATE users SET role = 'client' WHERE id = :id", { id: admin.id });
    await request(app).get('/api/admin/support/tickets').set(auth(admin)).expect(403);
    await request(app)
      .post(`/api/admin/support/tickets/${ticket.id}/messages`)
      .set(auth(admin))
      .send({ message: 'JWT admin antigo não pode adicionar nota.', internal: true })
      .expect(403);
    await pool.query("UPDATE users SET role = 'admin', status = 'suspended' WHERE id = :id", {
      id: admin.id,
    });
    await request(app).get(`/api/admin/support/tickets/${ticket.id}`).set(auth(admin)).expect(403);
    expect((await dbTicket(ticket.id)).first_response_at).toBeNull();
  });

  it('vínculo exige participação; categoria dispute exige contrato sem abrir disputa financeira', async () => {
    const owner = await actor();
    const peer = await actor('freelancer');
    const stranger = await actor();
    const id = await contract(owner, peer);
    await request(app)
      .post('/api/support/tickets')
      .set(auth(owner))
      .send(opening(undefined, { category: 'dispute' }))
      .expect(422);
    for (const role of [stranger, await actor('admin')]) {
      await request(app)
        .post('/api/support/tickets')
        .set(auth(role))
        .send(opening(undefined, { category: 'dispute', contractId: id }))
        .expect(404);
    }
    expect(await create(owner, { category: 'dispute', contractId: id })).toMatchObject({
      contractId: id,
      category: 'dispute',
    });
    const [disputes] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM disputes WHERE contract_id = :id',
      { id },
    );
    expect(disputes).toEqual([]);
  });

  it('suspenso abre, responde e encerra suporte, mas continua sem poder transacionar', async () => {
    const owner = await actor();
    await pool.query("UPDATE users SET status = 'suspended' WHERE id = :id", { id: owner.id });
    const ticket = await create(owner);
    await reply(owner, ticket.id);
    await request(app).get(`/api/support/tickets/${ticket.id}`).set(auth(owner)).expect(200);
    const closed = await request(app)
      .post(`/api/support/tickets/${ticket.id}/close`)
      .set(auth(owner))
      .expect(200);
    expect(closed.body.status).toBe('closed');
    const blocked = await request(app)
      .post('/api/wallet/deposits')
      .set(auth(owner))
      .send({ amount: 100 })
      .expect(403);
    expect(blocked.body.error).toBe('account_suspended');
    // A exceção não é um prefixo que libera operações futuras arbitrárias.
    await request(app)
      .post(`/api/support/tickets/${ticket.id}/reopen`)
      .set(auth(owner))
      .expect(403);
  });

  it.each(['banned', 'deleted'] as const)('%s não acessa nem abre suporte', async (state) => {
    const owner = await actor();
    const ticket = await create(owner);
    if (state === 'banned')
      await pool.query("UPDATE users SET status = 'banned' WHERE id = :id", { id: owner.id });
    else
      await pool.query('UPDATE users SET deleted_at = :now WHERE id = :id', {
        id: owner.id,
        now: BASE,
      });
    await request(app).get('/api/support/tickets').set(auth(owner)).expect(403);
    await request(app).post('/api/support/tickets').set(auth(owner)).send(opening()).expect(403);
    await request(app)
      .post(`/api/support/tickets/${ticket.id}/messages`)
      .set(auth(owner))
      .send({ message: 'Não pode persistir.' })
      .expect(403);
    expect((await dbTicket(ticket.id)).status).toBe('open');
  });

  it('rejeita campos de autoridade no payload do titular', async () => {
    const owner = await actor();
    const ticket = await create(owner);
    await request(app)
      .post('/api/support/tickets')
      .set(auth(owner))
      .send(opening(undefined, { userId: (await actor()).id, priority: 'critical' }))
      .expect(422);
    await request(app)
      .post(`/api/support/tickets/${ticket.id}/messages`)
      .set(auth(owner))
      .send({ message: 'Não é uma nota interna.', internal: true, resolve: true })
      .expect(422);
    expect((await detail(owner, ticket.id)).messages).toHaveLength(1);
  });

  it('quatro aberturas aguardando a mesma conta admitem exatamente três', async () => {
    const owner = await actor();
    const results = await raceOnUser(
      owner,
      Array.from(
        { length: 4 },
        (_, index) => () =>
          request(app)
            .post('/api/support/tickets')
            .set(auth(owner))
            .send(opening(`Concorrência ${index}`)),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('ticket_limit');
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM support_tickets WHERE user_id = :id AND status <> 'closed'",
      { id: owner.id },
    );
    expect(rows).toHaveLength(3);
  });

  it('duplicado concorrente por assunto/categoria/vínculo cria um único protocolo', async () => {
    const owner = await actor();
    const results = await raceOnUser(owner, [
      () =>
        request(app).post('/api/support/tickets').set(auth(owner)).send(opening('Mesmo Assunto')),
      () =>
        request(app)
          .post('/api/support/tickets')
          .set(auth(owner))
          .send(opening('  mesmo assunto  ')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('ticket_duplicate');
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM support_tickets WHERE user_id = :id',
      { id: owner.id },
    );
    expect(rows).toHaveLength(1);
  });

  it('resolved ainda ocupa vaga; fechamento do titular libera nova abertura e é terminal', async () => {
    const owner = await actor();
    const admin = await actor('admin');
    const first = await create(owner);
    await create(owner);
    await create(owner);
    await reply(admin, first.id, { resolve: true }, true);
    const full = await request(app)
      .post('/api/support/tickets')
      .set(auth(owner))
      .send(opening())
      .expect(409);
    expect(full.body.error).toBe('ticket_limit');
    await request(app).post(`/api/support/tickets/${first.id}/close`).set(auth(owner)).expect(200);
    await create(owner);
    const response = await request(app)
      .post(`/api/support/tickets/${first.id}/messages`)
      .set(auth(owner))
      .send({ message: 'Fechado não deve reabrir.' })
      .expect(409);
    expect(response.body.error).toBe('ticket_closed');
    expect((await dbTicket(first.id)).status).toBe('closed');
  });

  it('paginação pública filtra notas antes do limite e não pula mensagens visíveis', async () => {
    const owner = await actor();
    const admin = await actor('admin');
    const ticket = await create(owner);
    for (let index = 0; index < 55; index++) {
      await pool.query(
        `INSERT INTO support_ticket_messages (ticket_id, sender_id, message, is_internal, created_at)
         VALUES (:ticketId, :sender, :message, 0, :now),
                (:ticketId, :admin, :note, 1, :now)`,
        {
          ticketId: ticket.id,
          sender: owner.id,
          admin: admin.id,
          message: `Pública ${index}`,
          note: `SEGREDO ${index}`,
          now: BASE,
        },
      );
    }
    const last = await detail(owner, ticket.id);
    expect(last.messages).toHaveLength(50);
    expect(last.nextBeforeId).toEqual(expect.any(Number));
    const older = await detail(owner, ticket.id, false, last.nextBeforeId!);
    expect(older.messages).toHaveLength(6);
    expect(older.nextBeforeId).toBeNull();
    const combined = [...older.messages, ...last.messages];
    expect(new Set(combined.map((m) => m.id)).size).toBe(56);
    expect(combined.map((m) => m.id)).toEqual(combined.map((m) => m.id).sort((a, b) => a - b));
    expect(JSON.stringify(combined)).not.toContain('SEGREDO');
    const internal = await detail(admin, ticket.id, true);
    expect(internal.messages.some((m) => m.internal && m.message.startsWith('SEGREDO'))).toBe(true);
  });

  it('nota interna não responde SLA, altera estado nem notifica; resposta pública encerra SLA', async () => {
    const owner = await actor();
    const admin = await actor('admin');
    const ticket = await create(owner);
    const before = await notifications(ticket.id, undefined, owner.id);
    at(23 * HOUR);
    const noted = await reply(
      admin,
      ticket.id,
      { internal: true, message: 'SOMENTE EQUIPE' },
      true,
    );
    expect(noted).toMatchObject({ status: 'open', firstResponseAt: null, assignedTo: null });
    expect(await notifications(ticket.id, undefined, owner.id)).toEqual(before);
    await request(app)
      .post(`/api/admin/support/tickets/${ticket.id}/messages`)
      .set(auth(admin))
      .send({ message: 'Não pode resolver em segredo.', internal: true, resolve: true })
      .expect(422);
    const answered = await reply(admin, ticket.id, {}, true);
    expect(answered.firstResponseAt).toBe(new Date(BASE.getTime() + 23 * HOUR).toISOString());
    at(30 * HOUR);
    await runSupportMaintenance();
    expect(await notifications(ticket.id, 'support_sla', admin.id)).toEqual([]);
    expect((await dbTicket(ticket.id)).sla_alerted_at).toBeNull();
  });

  it('prioridade recalcula desde a criação sem reiniciar relógio e alerta uma vez entre dois jobs', async () => {
    const owner = await actor();
    const admin = await actor('admin');
    const ticket = await create(owner);
    at(7 * HOUR);
    const changed = await request(app)
      .patch(`/api/admin/support/tickets/${ticket.id}`)
      .set(auth(admin))
      .send({ priority: 'high' })
      .expect(200);
    expect(changed.body.slaDueAt).toBe(new Date(BASE.getTime() + 8 * HOUR).toISOString());
    at(8 * HOUR - 1000);
    await runSupportMaintenance();
    expect(await notifications(ticket.id, 'support_sla', admin.id)).toEqual([]);
    at(8 * HOUR);
    await Promise.all([runSupportMaintenance(), runSupportMaintenance()]);
    expect(await notifications(ticket.id, 'support_sla', admin.id)).toHaveLength(1);
    expect((await dbTicket(ticket.id)).sla_alerted_at).not.toBeNull();
    at(9 * HOUR);
    await runSupportMaintenance();
    expect(await notifications(ticket.id, 'support_sla', admin.id)).toHaveLength(1);
    expect(await notifications(ticket.id, 'support_sla', owner.id)).toEqual([]);
  });

  it('resposta antes dos cinco dias reabre e impede encerramento pela rodada seguinte', async () => {
    const owner = await actor();
    const admin = await actor('admin');
    const ticket = await create(owner);
    await reply(admin, ticket.id, { resolve: true }, true);
    at(5 * DAY - 1000);
    const reopened = await reply(owner, ticket.id, { message: 'Preciso de mais uma orientação.' });
    expect(reopened).toMatchObject({ status: 'in_progress', resolvedAt: null, closedAt: null });
    at(5 * DAY);
    await runSupportMaintenance();
    expect((await dbTicket(ticket.id)).status).toBe('in_progress');
  });

  it('no quinto dia a própria resposta fecha antes de retornar 409, sem depender do job', async () => {
    const owner = await actor();
    const admin = await actor('admin');
    const ticket = await create(owner);
    await reply(admin, ticket.id, { resolve: true }, true);
    at(5 * DAY);
    const response = await request(app)
      .post(`/api/support/tickets/${ticket.id}/messages`)
      .set(auth(owner))
      .send({ message: 'Chegou exatamente no vencimento.' })
      .expect(409);
    expect(response.body.error).toBe('ticket_closed');
    expect((await dbTicket(ticket.id)).status).toBe('closed');
    expect((await detail(owner, ticket.id)).messages).toHaveLength(2);
  });

  it('job respeita limite exato dos cinco dias; notas internas não adiam encerramento', async () => {
    const owner = await actor();
    const admin = await actor('admin');
    const ticket = await create(owner);
    await reply(admin, ticket.id, { resolve: true }, true);
    at(4 * DAY);
    await reply(admin, ticket.id, { internal: true, message: 'Nota tardia da equipe.' }, true);
    at(5 * DAY - 1000);
    await runSupportMaintenance();
    expect((await dbTicket(ticket.id)).status).toBe('resolved');
    at(5 * DAY);
    await Promise.all([runSupportMaintenance(), runSupportMaintenance()]);
    expect((await dbTicket(ticket.id)).status).toBe('closed');
    const closedAt = (await dbTicket(ticket.id)).closed_at;
    at(6 * DAY);
    await runSupportMaintenance();
    expect((await dbTicket(ticket.id)).closed_at).toEqual(closedAt);
  });

  it('espera pela trava usa relógio novo: resposta iniciada antes do limite não reabre depois dele', async () => {
    const owner = await actor();
    const admin = await actor('admin');
    const ticket = await create(owner);
    await reply(admin, ticket.id, { resolve: true }, true);
    at(5 * DAY - 1000);
    const [response] = await raceOnUser(
      owner,
      [
        () =>
          request(app)
            .post(`/api/support/tickets/${ticket.id}/messages`)
            .set(auth(owner))
            .send({ message: 'Aguardou até passar o limite.' }),
      ],
      () => at(5 * DAY),
    );
    expect(response).toBeDefined();
    expect(response!.status, JSON.stringify(response!.body)).toBe(409);
    expect(response!.body.error).toBe('ticket_closed');
    expect((await dbTicket(ticket.id)).status).toBe('closed');
  });

  it('resposta e job concorrentes no vencimento não reabrem nem persistem nova mensagem', async () => {
    const owner = await actor();
    const admin = await actor('admin');
    const ticket = await create(owner);
    await reply(admin, ticket.id, { resolve: true }, true);
    at(5 * DAY);
    const results = await raceOnUser<
      request.Response | Awaited<ReturnType<typeof runSupportMaintenance>>
    >(owner, [
      () =>
        request(app)
          .post(`/api/support/tickets/${ticket.id}/messages`)
          .set(auth(owner))
          .send({ message: 'Resposta concorrente com manutenção.' }),
      () => runSupportMaintenance(),
    ]);
    const response = results.find((result): result is request.Response => 'status' in result)!;
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error).toBe('ticket_closed');
    expect((await dbTicket(ticket.id)).status).toBe('closed');
    expect((await detail(owner, ticket.id)).messages).toHaveLength(2);
  });

  it('exportação inclui só chamados próprios e mensagens públicas próprias sem notas nem assunto alheio', async () => {
    const owner = await actor('admin');
    const staff = await actor('admin');
    const own = await create(owner, { subject: 'ASSUNTO PRÓPRIO PORTÁVEL' });
    const foreign = await create(await actor(), { subject: 'ASSUNTO ALHEIO NÃO PORTÁVEL' });
    await reply(staff, own.id, { message: 'Resposta pública ao titular.' }, true);
    await reply(staff, own.id, { message: 'NOTA INTERNA NO TICKET PRÓPRIO', internal: true }, true);
    await reply(owner, foreign.id, { message: 'Resposta pública de autoria do titular.' }, true);
    await reply(
      owner,
      foreign.id,
      { message: 'NOTA INTERNA DE AUTORIA DO TITULAR', internal: true },
      true,
    );
    await reply(staff, foreign.id, { message: 'MENSAGEM ALHEIA NÃO PORTÁVEL' }, true);
    const exported = await buildExport(owner.id);
    expect(exported.formato).toBe('escambo-export/1.15');
    const support = exported.suporte as {
      chamados: { id: number }[];
      mensagens: { message: string }[];
    };
    expect(support.chamados.map((ticket) => ticket.id)).toEqual([own.id]);
    expect(support.mensagens.map((message) => message.message)).toEqual(
      expect.arrayContaining([
        'Descrição privada fictícia para atendimento.',
        'Resposta pública ao titular.',
        'Resposta pública de autoria do titular.',
      ]),
    );
    expect(support.mensagens).toHaveLength(3);
    const serialized = JSON.stringify(support);
    for (const secret of ['NOTA INTERNA', 'ASSUNTO ALHEIO', 'MENSAGEM ALHEIA'])
      expect(serialized).not.toContain(secret);
  });

  it('anonimização limpa todos os textos próprios, preserva terceiros e deixa atendimento só para consulta', async () => {
    const owner = await actor('admin');
    const staff = await actor('admin');
    const other = await actor();
    const own = await create(owner, { subject: 'ASSUNTO PESSOAL PARA APAGAR' });
    const foreign = await create(other, { subject: 'ASSUNTO DE TERCEIRO PRESERVADO' });
    await reply(
      staff,
      own.id,
      { message: 'NOTA SOBRE O TITULAR PARA APAGAR', internal: true },
      true,
    );
    await reply(owner, foreign.id, { message: 'AUTORIA PESSOAL PARA APAGAR' }, true);
    await reply(
      owner,
      foreign.id,
      { message: 'NOTA DE AUTORIA PESSOAL PARA APAGAR', internal: true },
      true,
    );
    await reply(staff, foreign.id, { message: 'RESPOSTA DE TERCEIRO PRESERVADA' }, true);
    const before = await dbTicket(own.id);
    const deletion = await request(app)
      .post('/api/lgpd/deletion-requests')
      .set(auth(owner))
      .send({ reason: 'Remoção fictícia dos dados privados de suporte.' })
      .expect(201);
    await request(app)
      .post(`/api/admin/deletion-requests/${deletion.body.id}/complete`)
      .set(auth(staff))
      .expect(200);
    const redacted = await dbTicket(own.id);
    expect(redacted).toMatchObject({
      id: before.id,
      ulid: before.ulid,
      status: before.status,
      created_at: before.created_at,
      resolved_at: before.resolved_at,
      closed_at: before.closed_at,
    });
    expect(redacted.subject).not.toContain('ASSUNTO PESSOAL');
    const retained = await detail(staff, own.id, true);
    expect(retained.ownerDeleted).toBe(true);
    expect(retained.messages).toHaveLength(2);
    expect(JSON.stringify(retained.messages)).not.toContain('PARA APAGAR');
    expect(JSON.stringify(retained.messages)).not.toContain('Descrição privada fictícia');
    const thirdParty = await detail(staff, foreign.id, true);
    expect(thirdParty.subject).toBe('ASSUNTO DE TERCEIRO PRESERVADO');
    expect(
      thirdParty.messages.some((message) => message.message === 'RESPOSTA DE TERCEIRO PRESERVADA'),
    ).toBe(true);
    expect(
      thirdParty.messages.some(
        (message) =>
          message.senderId === other.id &&
          message.message === 'Descrição privada fictícia para atendimento.',
      ),
    ).toBe(true);
    expect(JSON.stringify(thirdParty.messages)).not.toContain('AUTORIA PESSOAL PARA APAGAR');
    await request(app)
      .post(`/api/admin/support/tickets/${own.id}/messages`)
      .set(auth(staff))
      .send({ message: 'Texto novo após anonimização é proibido.' })
      .expect(404);
    at(2 * DAY);
    await runSupportMaintenance();
    expect(await notifications(own.id, 'support_sla')).toEqual([]);
    expect((await dbTicket(own.id)).sla_alerted_at).toBeNull();
  });

  it('resposta administrativa e anonimização concorrentes não deixam texto pessoal após o commit', async () => {
    // Titular vem antes do admin: reproduz a ordem que ciclaria se a FK do pedido fosse travada cedo.
    const owner = await actor();
    const admin = await actor('admin');
    expect(owner.id).toBeLessThan(admin.id);
    const ticket = await create(owner, { subject: 'DADO PESSOAL CONCORRENTE' });
    const deletion = await request(app)
      .post('/api/lgpd/deletion-requests')
      .set(auth(owner))
      .send({ reason: 'Anonimização concorrente fictícia.' })
      .expect(201);
    const results = await raceOnUser(owner, [
      () =>
        request(app)
          .post(`/api/admin/support/tickets/${ticket.id}/messages`)
          .set(auth(admin))
          .send({ message: 'TEXTO PESSOAL CONCORRENTE QUE NÃO PODE SOBRAR' }),
      () =>
        request(app)
          .post(`/api/admin/deletion-requests/${deletion.body.id}/complete`)
          .set(auth(admin)),
    ]);
    expect(results[1]!.status, JSON.stringify(results[1]!.body)).toBe(200);
    expect([201, 404]).toContain(results[0]!.status);
    const retained = await detail(admin, ticket.id, true);
    expect(retained.ownerDeleted).toBe(true);
    expect(JSON.stringify(retained)).not.toContain('DADO PESSOAL CONCORRENTE');
    expect(JSON.stringify(retained)).not.toContain('TEXTO PESSOAL CONCORRENTE');
    expect(JSON.stringify(retained.messages)).not.toContain('Descrição privada fictícia');
    const [deleted] = await pool.query<RowDataPacket[]>(
      'SELECT deleted_at FROM users WHERE id = :id',
      { id: owner.id },
    );
    expect(deleted[0]!.deleted_at).not.toBeNull();
  });

  it('atendimento e encerramento não alteram contratação, dinheiro, extratos ou disputas', async () => {
    const owner = await actor();
    const peer = await actor('freelancer');
    const admin = await actor('admin');
    const id = await contract(owner, peer);
    await pool.query(
      'INSERT INTO wallets (user_id, balance, balance_pending, credits_balance, credits_pending) VALUES (:id, 300, 50, 20, 5)',
      { id: owner.id },
    );
    const snapshot = async () => {
      const [wallet] = await pool.query<RowDataPacket[]>(
        'SELECT * FROM wallets WHERE user_id = :id',
        { id: owner.id },
      );
      const [agreement] = await pool.query<RowDataPacket[]>(
        'SELECT * FROM contracts WHERE id = :id',
        { id },
      );
      const [financial] = await pool.query<RowDataPacket[]>(
        `SELECT 'cash' AS kind, COUNT(*) AS n FROM wallet_transactions WHERE user_id = :uid
         UNION ALL SELECT 'credits', COUNT(*) FROM credit_transactions WHERE user_id = :uid
         UNION ALL SELECT 'disputes', COUNT(*) FROM disputes WHERE contract_id = :id
         UNION ALL SELECT 'payments', COUNT(*) FROM payments WHERE payer_id = :uid`,
        { uid: owner.id, id },
      );
      return { wallet, agreement, financial };
    };
    const before = await snapshot();
    const ticket = await create(owner, { category: 'dispute', contractId: id });
    await reply(admin, ticket.id, { resolve: true }, true);
    at(5 * DAY);
    await runSupportMaintenance();
    expect(await snapshot()).toEqual(before);
  });
});
