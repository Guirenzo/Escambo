import type { BrazilTimezone } from '@escambo/types';
import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import {
  runDeadlineReminders,
  type DeadlineRemindersResult,
} from '../../src/jobs/deadline-reminders';
import { contractsRepository } from '../../src/modules/contracts/contracts.repository';
import { deadlineRemindersService } from '../../src/modules/contracts/deadline-reminders.service';
import { milestonesRepository } from '../../src/modules/contracts/milestones.repository';
import {
  remindersRepository,
  type ReminderCandidate,
} from '../../src/modules/contracts/reminders.repository';
import { REMINDER_PAGE, type ReminderKind } from '../../src/modules/contracts/reminders-sql';
import { notificationsRepository } from '../../src/modules/notifications/notifications.repository';
import { setClockForTests } from '../../src/utils/clock';
import { dayZones } from '../../src/utils/human-hours';
import {
  addDaysToDay,
  dayIn,
  endOfDayIn,
  formatDeadline,
  formatDeadlineDay,
  formatDue,
  localInstant,
} from '../../src/utils/timezone';
import { DAY, HOUR, startDaytimeClock, stopClock } from './clock.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * O motor dos lembretes (ADR 58, RN-079 e RN-081) contra o MySQL real: o job
 * (jobs/deadline-reminders.ts), o serviço que trava e grava na mesma transação e o livro
 * `deadline_reminders`. Cada lembrete sai às 9h da véspera (ou do próprio dia) no fuso ATUAL de
 * quem recebe, no máximo uma vez por (tipo, objeto, vencimento, nº do pedido), e a linha in-app
 * só fica se a trava ficou. A revisão parada avisa as duas partes 7 dias depois, com as duas de dia.
 *
 * O relógio do fluxo começa às 12:00 de Brasília do dia de hoje e fica PARADO em cada ação
 * (o que a API grava é exatamente o instante escolhido); os dias são contados a partir dele, e
 * o job roda no instante que cada caso escolhe. O banco é compartilhado pelos casos do arquivo:
 * tudo é conferido por contratação (ou marco) e por usuário. Configurações do seed: proposta de
 * 72 h, aprovação tácita em 5 dias e carência de 24 h.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const SP: BrazilTimezone = 'America/Sao_Paulo';
const NO: BrazilTimezone = 'America/Noronha';
const RB: BrazilTimezone = 'America/Rio_Branco';

const MILESTONES = [
  { title: 'Layout', amount: 150 },
  { title: 'Publicação', amount: 150 },
];

interface Actor {
  id: number;
  token: string;
}

interface Note {
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
}

/** 12:00 de Brasília do dia de hoje: o início do relógio de cada caso. */
let base: Date;
let seq = 0;

/** O relógio do fluxo parado no instante: as ações da API gravam exatamente ele. */
const setNow = (at: Date): void => setClockForTests(at, { frozen: true });

/** O dia `n` dias depois do dia do relógio, no fuso ("AAAA-MM-DD"). */
const day = (n: number, zone: BrazilTimezone = SP): string => addDaysToDay(dayIn(zone, base), n);

/** O instante em que o relógio de parede do fuso marca h:mi:s, `n` dias depois do dia do relógio. */
function wall(zone: BrazilTimezone, n: number, h: number, mi = 0, s = 0): Date {
  const [y, m, d] = day(n, zone).split('-').map(Number) as [number, number, number];
  return localInstant(zone, y, m, d, h, mi, s);
}

/** 23:59:59 do dia `n` no fuso: o prazo como o web grava. */
const endOf = (n: number, zone: BrazilTimezone = SP): Date => endOfDayIn(zone, day(n, zone));

const plus = (at: Date, ms: number): Date => new Date(at.getTime() + ms);

async function user(
  role: 'client' | 'freelancer',
  timezone: BrazilTimezone | null = null,
): Promise<Actor> {
  const email = `int_lembretes_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const id = login.body.user.id as number;
  if (timezone) await setTimezone(id, timezone);
  return { id, token: login.body.accessToken };
}

async function setTimezone(id: number, timezone: BrazilTimezone): Promise<void> {
  await pool.query('UPDATE users SET timezone = :timezone WHERE id = :id', { id, timezone });
}

/** Cliente com saldo e freelancer; sem fuso escolhido, os dois em Brasília. */
async function pair(
  funds: number,
  zones: { client?: BrazilTimezone; freelancer?: BrazilTimezone } = {},
): Promise<{ client: Actor; freelancer: Actor }> {
  const client = await user('client', zones.client ?? null);
  const freelancer = await user('freelancer', zones.freelancer ?? null);
  await fundWallet(app, client.token, funds);
  return { client, freelancer };
}

async function ok(path: string, actor: Actor, body: object = {}): Promise<void> {
  const res = await request(app).post(path).set(auth(actor.token)).send(body);
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
}

/** Proposta (em dinheiro, salvo `credits`), com prazo (padrão: fim do 5º dia em Brasília). */
async function propose(
  client: Actor,
  freelancer: Actor,
  title: string,
  opts: {
    price?: number;
    deadline?: Date;
    milestones?: { title: string; amount: number }[];
    credits?: boolean;
  } = {},
): Promise<number> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title,
      description: `Contratação do teste de lembretes: ${title}`,
      price: opts.price ?? 200,
      deadlineAt: (opts.deadline ?? endOf(5)).toISOString(),
      ...(opts.milestones ? { milestones: opts.milestones } : {}),
      ...(opts.credits ? { paymentMode: 'credits' } : {}),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

async function accepted(
  client: Actor,
  freelancer: Actor,
  title: string,
  opts: Parameters<typeof propose>[3] = {},
): Promise<number> {
  const id = await propose(client, freelancer, title, opts);
  await ok(`/api/contracts/${id}/accept`, freelancer);
  return id;
}

const deliver = (id: number, freelancer: Actor): Promise<void> =>
  ok(`/api/contracts/${id}/deliver`, freelancer, { message: 'Entregue: arquivos no chat.' });

const requestRevision = (id: number, client: Actor): Promise<void> =>
  ok(`/api/contracts/${id}/request-revision`, client, { note: 'Faltou a página de contato' });

const askExtension = (id: number, freelancer: Actor, deadline: Date): Promise<void> =>
  ok(`/api/contracts/${id}/extension`, freelancer, {
    deadlineAt: deadline.toISOString(),
    reason: 'O material do cliente chegou depois do combinado',
  });

/** Troca aceita entre `a` e `b`: devolve a contratação em que `a` entrega para `b`. */
async function barter(a: Actor, b: Actor): Promise<number> {
  const proposed = await request(app).post('/api/barters').set(auth(a.token)).send({
    receiverId: b.id,
    offeredDescription: 'Ofereço a revisão de textos do site',
    requestedDescription: 'Quero as fotos dos produtos da loja',
    estimatedValueOffered: 250,
    estimatedValueRequested: 250,
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const acc = await request(app).post(`/api/barters/${proposed.body.id}/accept`).set(auth(b.token));
  expect(acc.status, JSON.stringify(acc.body)).toBe(200);
  return acc.body.contractOfferedId as number;
}

/** Os marcos da contratação, na ordem. */
async function milestonesOf(id: number, actor: Actor): Promise<{ id: number; title: string }[]> {
  const res = await request(app).get(`/api/contracts/${id}`).set(auth(actor.token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.milestones as { id: number; title: string }[];
}

/** A linha como o repositório lê. */
async function dbRow(id: number) {
  const row = await contractsRepository.findById(id);
  expect(row, `contratação ${id}`).toBeDefined();
  return row!;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

/** As notificações in-app de um tipo, de um usuário, sobre uma contratação, na ordem. */
async function notes(userId: number, type: string, contractId: number): Promise<Note[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT title, body, data FROM notifications
      WHERE user_id = :userId AND type = :type ORDER BY id ASC`,
    { userId, type },
  );
  return rows
    .map((r) => ({
      title: String(r.title),
      body: r.body === null ? null : String(r.body),
      data: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Record<
        string,
        unknown
      > | null,
    }))
    .filter((n) => n.data?.contractId === contractId);
}

/** As linhas do livro de um objeto, por vencimento e nº do pedido. */
async function ledger(
  kind: ReminderKind,
  entityId: number,
): Promise<{ due: string; seq: number }[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT due_at, seq FROM deadline_reminders
      WHERE kind = :kind AND entity_id = :entityId ORDER BY due_at ASC, seq ASC`,
    { kind, entityId },
  );
  return rows.map((r) => ({ due: new Date(r.due_at).toISOString(), seq: Number(r.seq) }));
}

/** Uma rodada do job no instante (o relógio do fluxo vai junto). */
function run(at: Date): Promise<DeadlineRemindersResult> {
  setNow(at);
  return runDeadlineReminders(at);
}

/** A candidata de um objeto no instante, percorrendo as páginas como o job. */
async function candidateOf(
  kind: ReminderKind,
  at: Date,
  entityId: number,
): Promise<ReminderCandidate | undefined> {
  let after = { due: new Date(0), id: 0 };
  for (;;) {
    const rows = await remindersRepository.candidates(kind, {
      now: at,
      zones: dayZones(at),
      after,
    });
    const hit = rows.find((r) => Number(r.entity_id) === entityId);
    if (hit) return hit;
    if (rows.length < REMINDER_PAGE) return undefined;
    const last = rows[rows.length - 1]!;
    after = { due: new Date(last.due_at), id: Number(last.entity_id) };
  }
}

beforeAll(async () => {
  base = startDaytimeClock();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

beforeEach(() => {
  setNow(base);
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('Sem fuso de dia', () => {
  it('às 03:00Z não é dia em fuso nenhum: o job não consulta o banco nem abre conexão', async () => {
    const night = plus(base, 12 * HOUR);
    expect(night.getUTCHours()).toBe(3);
    expect(dayZones(night)).toEqual([]);
    const query = vi.spyOn(pool, 'query');
    const connect = vi.spyOn(pool, 'getConnection');
    try {
      const r = await runDeadlineReminders(night);
      expect(r.zones).toEqual([]);
      expect(Object.values(r.sent).flat()).toEqual([]);
      expect(r.waiting).toBe(0);
      expect(r.lost).toBe(0);
      expect(r.failed).toEqual([]);
      expect(query.mock.calls).toEqual([]);
      expect(connect.mock.calls).toEqual([]);
    } finally {
      query.mockRestore();
      connect.mockRestore();
    }
  });
});

describe('Lembrete antes do vencimento', () => {
  it('proposta: sai às 9h da véspera no fuso do freelancer, com título e corpo exatos, uma vez só', async () => {
    const { client, freelancer } = await pair(300);
    const deadline = endOf(5);
    const id = await propose(client, freelancer, 'Logo da padaria', { deadline });
    const row = await dbRow(id);
    expect(iso(row.created_at)).toBe(base.toISOString());
    // 72 h depois do envio, de dia: vale até as 12:00 do 3º dia; a véspera é o 2º dia às 9h.
    const due = wall(SP, 3, 12);
    expect(iso(row.proposal_expires_at)).toBe(due.toISOString());
    const slot = wall(SP, 2, 9);

    const early = await run(plus(slot, -1000));
    expect(early.sent.proposal).not.toContain(id);
    expect(await ledger('proposal', id)).toEqual([]);
    expect(await notes(freelancer.id, 'contract_proposal_reminder', id)).toEqual([]);

    const first = await run(slot);
    expect(first.sent.proposal).toContain(id);
    expect(await ledger('proposal', id)).toEqual([{ due: due.toISOString(), seq: 0 }]);
    const sent = await notes(freelancer.id, 'contract_proposal_reminder', id);
    expect(sent).toEqual([
      {
        title: `Responda à proposta até ${formatDue(due, SP)}: Logo da padaria`,
        body: `Aceite ou recuse até lá. Sem resposta, a proposta se encerra e o valor reservado volta ao cliente. Se aceitar, o prazo de entrega é ${formatDeadline(deadline, SP, SP)}.`,
        data: { contractId: id },
      },
    ]);
    // O prazo vai como dia; a hora de agir, como instante.
    expect(sent[0]!.title).toContain(' às 12:00: Logo da padaria');
    expect(sent[0]!.body).toMatch(/, até 23:59\.$/);
    expect(await notes(client.id, 'contract_proposal_reminder', id)).toEqual([]);

    const again = await run(plus(slot, 5 * 60_000));
    expect(again.sent.proposal).not.toContain(id);
    expect(await ledger('proposal', id)).toHaveLength(1);
    expect(await notes(freelancer.id, 'contract_proposal_reminder', id)).toHaveLength(1);
  });

  it('duas instâncias do job no mesmo instante geram um aviso só e uma linha no livro', async () => {
    const { client, freelancer } = await pair(300);
    const id = await propose(client, freelancer, 'Cartão de visita');
    const slot = wall(SP, 2, 9);
    setNow(slot);
    const [a, b] = await Promise.all([runDeadlineReminders(slot), runDeadlineReminders(slot)]);
    expect([...a.sent.proposal, ...b.sent.proposal].filter((x) => x === id)).toEqual([id]);
    expect(await ledger('proposal', id)).toHaveLength(1);
    expect(await notes(freelancer.id, 'contract_proposal_reminder', id)).toHaveLength(1);
  });

  it('entrega: diz a hora do aviso de atraso e a carência de hoje; a extensão aceita gera um lembrete novo, com o vencimento novo', async () => {
    const { client, freelancer } = await pair(300);
    const deadline = endOf(3);
    const id = await accepted(client, freelancer, 'Site da clínica', { deadline });

    const first = await run(wall(SP, 2, 9));
    expect(first.sent.delivery).toContain(id);
    expect(await notes(freelancer.id, 'contract_deadline_reminder', id)).toEqual([
      {
        title: `Entregue até ${formatDeadlineDay(deadline, SP)}: Site da clínica`,
        body: `Registre a entrega até lá ou peça a extensão antes. Sem entrega, a partir de ${formatDue(wall(SP, 4, 9), SP)} o Escambo avisa vocês dois, o cliente pode cancelar com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é ${formatDeadline(deadline, SP, SP)}.`,
        data: { contractId: id },
      },
    ]);
    expect(await notes(client.id, 'contract_deadline_reminder', id)).toEqual([]);
    expect(await ledger('delivery', id)).toEqual([{ due: deadline.toISOString(), seq: 0 }]);

    // Pedido no mesmo dia, aceito uma hora depois: o prazo passa para o fim do 6º dia.
    const extended = endOf(6);
    setNow(wall(SP, 2, 10));
    await askExtension(id, freelancer, extended);
    setNow(wall(SP, 2, 11));
    await ok(`/api/contracts/${id}/extension/accept`, client);
    expect(iso((await dbRow(id)).deadline_at)).toBe(extended.toISOString());

    const second = await run(wall(SP, 5, 9));
    expect(second.sent.delivery).toContain(id);
    const all = await notes(freelancer.id, 'contract_deadline_reminder', id);
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual({
      title: `Entregue até ${formatDeadlineDay(extended, SP)}: Site da clínica`,
      body: `Registre a entrega até lá: não há mais pedido de extensão. Sem entrega, a partir de ${formatDue(wall(SP, 7, 9), SP)} o Escambo avisa vocês dois, o cliente pode cancelar com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é ${formatDeadline(extended, SP, SP)}.`,
      data: { contractId: id },
    });
    expect(await ledger('delivery', id)).toEqual([
      { due: deadline.toISOString(), seq: 0 },
      { due: extended.toISOString(), seq: 0 },
    ]);
  });

  it('pedido de extensão pendente segura o lembrete da entrega; recusado às 8h da véspera, o lembrete sai às 9h do próprio dia', async () => {
    const { client, freelancer } = await pair(600);
    const deadline = endOf(3);
    const pending = await accepted(client, freelancer, 'Cardápio com pedido pendente', {
      deadline,
    });
    const declined = await accepted(client, freelancer, 'Cardápio com pedido recusado', {
      deadline,
    });
    setNow(wall(SP, 1, 12));
    await askExtension(pending, freelancer, endOf(6));
    await askExtension(declined, freelancer, endOf(6));
    setNow(wall(SP, 2, 8));
    await ok(`/api/contracts/${declined}/extension/decline`, client);
    expect(iso((await dbRow(declined)).extension_resolved_at)).toBe(wall(SP, 2, 8).toISOString());

    // Às 9h da véspera: o pendente segura a entrega (o cliente é lembrado do pedido); o recusado
    // às 8h ainda não tem 12 h.
    const eve = await run(wall(SP, 2, 9));
    expect(eve.sent.delivery).not.toContain(pending);
    expect(eve.sent.delivery).not.toContain(declined);
    expect(eve.sent.extension).toContain(pending);
    expect(eve.sent.extension).not.toContain(declined);

    const dawn = await run(wall(SP, 3, 8, 59, 59));
    expect(dawn.sent.delivery).not.toContain(declined);

    const morning = await run(wall(SP, 3, 9));
    expect(morning.sent.delivery).toContain(declined);
    expect(morning.sent.delivery).not.toContain(pending);
    expect(await notes(freelancer.id, 'contract_deadline_reminder', declined)).toEqual([
      {
        title: `Entregue até ${formatDeadlineDay(deadline, SP)}: Cardápio com pedido recusado`,
        body: `Registre a entrega até lá ou peça a extensão antes. Sem entrega, a partir de ${formatDue(wall(SP, 4, 9), SP)} o Escambo avisa vocês dois, o cliente pode cancelar com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é ${formatDeadline(deadline, SP, SP)}.`,
        data: { contractId: declined },
      },
    ]);
    expect(await ledger('delivery', declined)).toEqual([{ due: deadline.toISOString(), seq: 0 }]);
    expect(await notes(freelancer.id, 'contract_deadline_reminder', pending)).toEqual([]);
    expect(await ledger('delivery', pending)).toEqual([]);
  });

  it('por marcos: lista o que falta; com marco entregue em aberto, some a oferta do cancelamento; com marco aprovado, é o que falta', async () => {
    const { client, freelancer } = await pair(900);
    const deadline = endOf(3);
    const opts = { price: 300, deadline, milestones: MILESTONES };
    const none = await accepted(client, freelancer, 'Loja virtual', opts);
    const open = await accepted(client, freelancer, 'Revista digital', opts);
    const approved = await accepted(client, freelancer, 'Catálogo de produtos', opts);
    setNow(wall(SP, 1, 12));
    const [openLayout] = await milestonesOf(open, client);
    await ok(`/api/contracts/${open}/milestones/${openLayout!.id}/deliver`, freelancer, {
      message: 'Layout pronto.',
    });
    const [approvedLayout] = await milestonesOf(approved, client);
    await ok(`/api/contracts/${approved}/milestones/${approvedLayout!.id}/deliver`, freelancer, {
      message: 'Layout pronto.',
    });
    await ok(`/api/contracts/${approved}/milestones/${approvedLayout!.id}/approve`, client);

    const r = await run(wall(SP, 2, 9));
    expect(r.sent.delivery).toEqual(expect.arrayContaining([none, open, approved]));
    const notice = formatDue(wall(SP, 4, 9), SP);
    const prazo = formatDeadline(deadline, SP, SP);
    const title = (t: string): string => `Entregue até ${formatDeadlineDay(deadline, SP)}: ${t}`;
    expect(await notes(freelancer.id, 'contract_deadline_reminder', none)).toEqual([
      {
        title: title('Loja virtual'),
        body: `Entregue os marcos «Layout» e «Publicação» até lá ou peça a extensão antes. Sem as entregas, a partir de ${notice} o Escambo avisa vocês dois, o cliente pode cancelar com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é ${prazo}.`,
        data: { contractId: none },
      },
    ]);
    expect(await notes(freelancer.id, 'contract_deadline_reminder', open)).toEqual([
      {
        title: title('Revista digital'),
        body: `Entregue o marco «Publicação» até lá ou peça a extensão antes. Sem as entregas, a partir de ${notice} o Escambo avisa vocês dois e começa a carência até a disputa automática (hoje, 24 horas). O prazo é ${prazo}.`,
        data: { contractId: open },
      },
    ]);
    expect(await notes(freelancer.id, 'contract_deadline_reminder', approved)).toEqual([
      {
        title: title('Catálogo de produtos'),
        body: `Entregue o marco «Publicação» até lá ou peça a extensão antes. Sem as entregas, a partir de ${notice} o Escambo avisa vocês dois, o cliente pode cancelar o que falta com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é ${prazo}.`,
        data: { contractId: approved },
      },
    ]);
  });

  it('aprovação tácita: lembra o cliente de que depois não cabe revisão nem disputa; revisão e nova entrega geram um lembrete novo', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, 'Vídeo institucional');
    await deliver(id, freelancer);
    const due = wall(SP, 5, 12);
    expect(iso((await dbRow(id)).approval_due_at)).toBe(due.toISOString());

    const early = await run(wall(SP, 4, 8, 59, 59));
    expect(early.sent.approval).not.toContain(id);
    const first = await run(wall(SP, 4, 9));
    expect(first.sent.approval).toContain(id);
    expect(await notes(client.id, 'contract_approval_reminder', id)).toEqual([
      {
        title: `Aprove ou peça revisão até ${formatDue(due, SP)}: Vídeo institucional`,
        body: 'Depois disso, a entrega é aprovada sozinha, o pagamento é liberado ao freelancer e não cabe mais revisão nem disputa. Valor da contratação: R$ 200,00.',
        data: { contractId: id },
      },
    ]);
    expect(await notes(freelancer.id, 'contract_approval_reminder', id)).toEqual([]);
    expect(await ledger('approval', id)).toEqual([{ due: due.toISOString(), seq: 0 }]);

    setNow(wall(SP, 4, 10));
    await requestRevision(id, client);
    setNow(wall(SP, 4, 11));
    await deliver(id, freelancer);
    const due2 = wall(SP, 9, 11);
    expect(iso((await dbRow(id)).approval_due_at)).toBe(due2.toISOString());

    const second = await run(wall(SP, 8, 9));
    expect(second.sent.approval).toContain(id);
    const all = await notes(client.id, 'contract_approval_reminder', id);
    expect(all.map((n) => n.title)).toEqual([
      `Aprove ou peça revisão até ${formatDue(due, SP)}: Vídeo institucional`,
      `Aprove ou peça revisão até ${formatDue(due2, SP)}: Vídeo institucional`,
    ]);
    expect(await ledger('approval', id)).toEqual([
      { due: due.toISOString(), seq: 0 },
      { due: due2.toISOString(), seq: 0 },
    ]);
  });

  it('dois marcos da mesma contratação no mesmo lembrete: um aviso, duas linhas no livro; com horas diferentes, "o primeiro até"', async () => {
    const { client, freelancer } = await pair(600);
    const opts = { price: 300, deadline: endOf(10), milestones: MILESTONES };
    const same = await accepted(client, freelancer, 'Identidade visual', opts);
    const apart = await accepted(client, freelancer, 'Papelaria', opts);
    const [s1, s2] = await milestonesOf(same, client);
    const [a1, a2] = await milestonesOf(apart, client);
    for (const m of [s1!, s2!]) {
      await ok(`/api/contracts/${same}/milestones/${m.id}/deliver`, freelancer, {
        message: 'Pronto.',
      });
    }
    await ok(`/api/contracts/${apart}/milestones/${a1!.id}/deliver`, freelancer, {
      message: 'Pronto.',
    });
    setNow(wall(SP, 0, 13));
    await ok(`/api/contracts/${apart}/milestones/${a2!.id}/deliver`, freelancer, {
      message: 'Pronto.',
    });

    const r = await run(wall(SP, 4, 9));
    expect(r.sent.milestone_approval).toEqual(
      expect.arrayContaining([s1!.id, s2!.id, a1!.id, a2!.id]),
    );
    const first = formatDue(wall(SP, 5, 12), SP);
    expect(await notes(client.id, 'contract_approval_reminder', same)).toEqual([
      {
        title: `Aprove ou peça revisão de 2 marcos até ${first}: Identidade visual`,
        body: 'Depois disso, os marcos «Layout» e «Publicação» são aprovados sozinhos, o pagamento deles é liberado ao freelancer e não cabe mais pedir revisão. Valor dos marcos: R$ 300,00.',
        data: { contractId: same },
      },
    ]);
    expect(await notes(client.id, 'contract_approval_reminder', apart)).toEqual([
      {
        title: `2 marcos esperam a sua resposta, o primeiro até ${first}: Papelaria`,
        body: 'Cada um é aprovado sozinho na hora dele (a de cada marco está na Sala): os marcos «Layout» e «Publicação». O pagamento é liberado ao freelancer e não cabe mais pedir revisão. Valor dos marcos: R$ 300,00.',
        data: { contractId: apart },
      },
    ]);
    expect(await ledger('milestone_approval', s1!.id)).toEqual([
      { due: wall(SP, 5, 12).toISOString(), seq: 0 },
    ]);
    expect(await ledger('milestone_approval', s2!.id)).toEqual([
      { due: wall(SP, 5, 12).toISOString(), seq: 0 },
    ]);
    expect(await ledger('milestone_approval', a1!.id)).toEqual([
      { due: wall(SP, 5, 12).toISOString(), seq: 0 },
    ]);
    expect(await ledger('milestone_approval', a2!.id)).toEqual([
      { due: wall(SP, 5, 13).toISOString(), seq: 0 },
    ]);
  });

  it('marco em créditos: o valor de um marco de 1 crédito vai no singular ("1 crédito")', async () => {
    const client = await user('client');
    const freelancer = await user('freelancer');
    // Bônus de boas-vindas (100 créditos) no primeiro acesso à carteira.
    const wallet = await request(app).get('/api/wallet').set(auth(client.token));
    expect(wallet.body.credits).toBe(100);
    const id = await accepted(client, freelancer, 'Aulas de violão', {
      price: 10,
      deadline: endOf(10),
      credits: true,
      milestones: [
        { title: 'Layout', amount: 1 },
        { title: 'Publicação', amount: 9 },
      ],
    });
    expect((await dbRow(id)).payment_mode).toBe('credits');
    const [layout] = await milestonesOf(id, client);
    await ok(`/api/contracts/${id}/milestones/${layout!.id}/deliver`, freelancer, {
      message: 'Primeira aula dada.',
    });

    const due = wall(SP, 5, 12);
    const r = await run(wall(SP, 4, 9));
    expect(r.sent.milestone_approval).toContain(layout!.id);
    expect(await notes(client.id, 'contract_approval_reminder', id)).toEqual([
      {
        title: `Até ${formatDue(due, SP)}: aprove ou peça revisão do marco «Layout»`,
        body: 'Depois disso, o marco é aprovado sozinho, os créditos dele são liberados ao freelancer e não cabe mais pedir revisão. Valor do marco: 1 crédito. Contratação: Aulas de violão.',
        data: { contractId: id, milestoneId: layout!.id },
      },
    ]);
    expect(await ledger('milestone_approval', layout!.id)).toEqual([
      { due: due.toISOString(), seq: 0 },
    ]);
  });

  it('pedido de extensão: lembra o cliente; o 2º pedido para a mesma data, com a mesma hora de resposta, tem lembrete próprio (seq 2); resposta em 12 h não tem lembrete', async () => {
    const { client, freelancer } = await pair(400);
    const deadline = endOf(2);
    const proposed = endOf(3);
    const id = await accepted(client, freelancer, 'Tradução do manual', { deadline });
    const late = await accepted(client, freelancer, 'Tradução do site', { deadline });

    // Pedido às 14:00 do 1º dia para o fim do 3º: a resposta fica 12 h antes da data pedida.
    setNow(wall(SP, 1, 14));
    await askExtension(id, freelancer, proposed);
    const respondBy = wall(SP, 3, 11, 59, 59);
    expect(iso((await dbRow(id)).extension_respond_by)).toBe(respondBy.toISOString());

    const first = await run(wall(SP, 2, 9));
    expect(first.sent.extension).toContain(id);
    const title = `Responda ao pedido de extensão até ${formatDue(respondBy, SP)}: Tradução do manual`;
    expect(await notes(client.id, 'contract_extension_reminder', id)).toEqual([
      {
        title,
        body: `Aceite o novo prazo, ${formatDeadline(proposed, SP, SP)}, ou recuse. Sem resposta, o pedido expira e vale o prazo atual, ${formatDeadline(deadline, SP, SP)}.`,
        data: { contractId: id },
      },
    ]);
    expect(await ledger('extension', id)).toEqual([{ due: respondBy.toISOString(), seq: 1 }]);

    // Recusado e pedido de novo para a mesma data: a hora de resposta é a mesma.
    setNow(wall(SP, 2, 10));
    await ok(`/api/contracts/${id}/extension/decline`, client);
    setNow(wall(SP, 2, 10, 30));
    await askExtension(id, freelancer, proposed);
    const row = await dbRow(id);
    expect(Number(row.extension_requests)).toBe(2);
    expect(iso(row.extension_respond_by)).toBe(respondBy.toISOString());

    // Pedido às 23:59 do 2º dia: a resposta fica 12 h depois, e o lembrete não cabe.
    setNow(wall(SP, 2, 23, 59));
    await askExtension(late, freelancer, proposed);
    expect(iso((await dbRow(late)).extension_respond_by)).toBe(respondBy.toISOString());

    const second = await run(wall(SP, 3, 9));
    expect(second.sent.extension).toContain(id);
    expect(second.sent.extension).not.toContain(late);
    const all = await notes(client.id, 'contract_extension_reminder', id);
    expect(all).toHaveLength(2);
    // O prazo atual venceu à meia-noite: o corpo diz que a disputa espera a decisão.
    expect(all[1]).toEqual({
      title,
      body: `Aceite o novo prazo, ${formatDeadline(proposed, SP, SP)}, ou recuse. Sem resposta, o pedido expira e vale o prazo atual, que já venceu. Enquanto você decide, a disputa automática espera.`,
      data: { contractId: id },
    });
    expect(await ledger('extension', id)).toEqual([
      { due: respondBy.toISOString(), seq: 1 },
      { due: respondBy.toISOString(), seq: 2 },
    ]);

    const later = await run(wall(SP, 3, 9, 30));
    expect(later.sent.extension).not.toContain(late);
    expect(await notes(client.id, 'contract_extension_reminder', late)).toEqual([]);
    expect(await ledger('extension', late)).toEqual([]);
  });

  it('fuso atual de quem recebe: o freelancer que muda de Noronha para Rio Branco é lembrado às 9h de Rio Branco', async () => {
    const { client, freelancer } = await pair(300, { freelancer: NO });
    // O dia escolhido no fuso de quem entregava (Noronha): 23:59:59 de lá.
    const deadline = endOf(3, NO);
    const id = await accepted(client, freelancer, 'Edição do podcast', { deadline });
    await setTimezone(freelancer.id, RB);

    const noronhaNine = await run(wall(NO, 2, 9));
    expect(noronhaNine.zones).toContain(NO);
    expect(noronhaNine.zones).not.toContain(RB);
    expect(noronhaNine.sent.delivery).not.toContain(id);
    const almost = await run(wall(RB, 2, 8, 59, 59));
    expect(almost.zones).not.toContain(RB);
    expect(almost.sent.delivery).not.toContain(id);
    expect(await ledger('delivery', id)).toEqual([]);

    const rioBrancoNine = await run(wall(RB, 2, 9));
    expect(rioBrancoNine.sent.delivery).toContain(id);
    const sent = await notes(freelancer.id, 'contract_deadline_reminder', id);
    expect(sent).toEqual([
      {
        title: `Entregue até ${formatDeadlineDay(deadline, NO)}: Edição do podcast`,
        body: `Registre a entrega até lá ou peça a extensão antes. Sem entrega, a partir de ${formatDue(wall(RB, 4, 9), RB)} o Escambo avisa vocês dois, o cliente pode cancelar com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é ${formatDeadline(deadline, NO, RB)}.`,
        data: { contractId: id },
      },
    ]);
    // O dia continua o de Noronha, dito com a nota; o aviso de atraso, no relógio de Rio Branco.
    expect(sent[0]!.body).toMatch(/, até 23:59 \(horário de Fernando de Noronha\)\.$/);
    expect(await ledger('delivery', id)).toEqual([{ due: deadline.toISOString(), seq: 0 }]);
  });

  it('aceite há 11 h não entra nas candidatas; com 12 h entra, e o lembrete sai às 9h do dia do prazo', async () => {
    const { client, freelancer } = await pair(300);
    const deadline = endOf(2);
    const id = await propose(client, freelancer, 'Planilha de custos', { deadline });
    setNow(wall(SP, 0, 22));
    await ok(`/api/contracts/${id}/accept`, freelancer);
    expect(iso((await dbRow(id)).accepted_at)).toBe(wall(SP, 0, 22).toISOString());

    const eleven = wall(SP, 1, 9);
    expect(dayZones(eleven)).toContain(SP);
    expect(await candidateOf('delivery', eleven, id)).toBeUndefined();
    expect((await run(eleven)).sent.delivery).not.toContain(id);

    const twelve = wall(SP, 1, 10);
    const row = await candidateOf('delivery', twelve, id);
    expect(row).toBeDefined();
    expect(iso(row!.start_at)).toBe(wall(SP, 0, 22).toISOString());
    expect(iso(row!.due_at)).toBe(deadline.toISOString());
    // Candidata, mas a véspera ficou a menos de 12 h do aceite: espera as 9h do dia do prazo.
    expect((await run(twelve)).sent.delivery).not.toContain(id);
    expect(await ledger('delivery', id)).toEqual([]);

    expect((await run(wall(SP, 2, 9))).sent.delivery).toContain(id);
    expect(await ledger('delivery', id)).toEqual([{ due: deadline.toISOString(), seq: 0 }]);
  });

  it('troca: a contratação da troca não tem lembrete de proposta; a aprovação tem, com "conta para fechar a troca"', async () => {
    const a = await user('freelancer');
    const b = await user('freelancer');
    const id = await barter(a, b);
    const row = await dbRow(id);
    expect(row).toMatchObject({ freelancer_id: a.id, client_id: b.id, payment_mode: 'barter' });

    // A troca nasce aceita e sem validade (RN-021). Mesmo levada a 'pending' com uma validade
    // dentro da janela, é o predicado da troca que a tira do lembrete.
    await pool.query(
      `UPDATE contracts SET status = 'pending', created_at = :created, proposal_expires_at = :due
        WHERE id = :id`,
      { id, created: base, due: wall(SP, 3, 12) },
    );
    const asProposal = await run(wall(SP, 2, 9));
    expect(asProposal.sent.proposal).not.toContain(id);
    expect(await ledger('proposal', id)).toEqual([]);
    expect(await notes(a.id, 'contract_proposal_reminder', id)).toEqual([]);
    await pool.query(
      `UPDATE contracts SET status = 'accepted', proposal_expires_at = NULL WHERE id = :id`,
      { id },
    );

    setNow(wall(SP, 2, 10));
    await deliver(id, a);
    const due = wall(SP, 7, 10);
    expect(iso((await dbRow(id)).approval_due_at)).toBe(due.toISOString());
    const r = await run(wall(SP, 6, 9));
    expect(r.sent.approval).toContain(id);
    expect(await notes(b.id, 'contract_approval_reminder', id)).toEqual([
      {
        title: `Aprove ou peça revisão até ${formatDue(due, SP)}: ${row.title}`,
        body: 'Depois disso, a entrega é aprovada sozinha, conta para fechar a troca e não cabe mais revisão nem disputa.',
        data: { contractId: id },
      },
    ]);
    expect(await notes(a.id, 'contract_approval_reminder', id)).toEqual([]);
  });
});

describe('Revisão parada', () => {
  it('avisa as duas partes 7 dias depois, só com as duas de dia; uma vez por pedido; nova revisão, novo aviso', async () => {
    const { client, freelancer } = await pair(300, { client: NO, freelancer: RB });
    setNow(wall(SP, 0, 7));
    const id = await accepted(client, freelancer, 'Ensaio fotográfico');
    await deliver(id, freelancer);
    setNow(wall(SP, 0, 8));
    await requestRevision(id, client);
    const requested = wall(SP, 0, 8);
    expect(iso((await dbRow(id)).revision_requested_at)).toBe(requested.toISOString());

    // 7 dias depois: 09:00 em Noronha, 06:00 em Rio Branco. Só a cliente está de dia.
    const week = plus(requested, 7 * DAY);
    const half = await run(week);
    expect(half.zones).toContain(NO);
    expect(half.zones).not.toContain(RB);
    expect(half.sent.revision).not.toContain(id);
    expect(await notes(client.id, 'contract_revision_stalled', id)).toEqual([]);
    expect(await notes(freelancer.id, 'contract_revision_stalled', id)).toEqual([]);

    // 09:00 em Rio Branco (11:00 em Noronha): as duas de dia.
    const both = await run(wall(RB, 7, 9));
    expect(both.sent.revision).toContain(id);
    expect(await notes(client.id, 'contract_revision_stalled', id)).toEqual([
      {
        title: 'Revisão sem nova entrega há 7 dias: Ensaio fotográfico',
        body: `Você pediu revisão em ${formatDue(requested, NO)} e ainda não houve nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala, e a mediação do Escambo decide sobre o valor.`,
        data: { contractId: id },
      },
    ]);
    expect(await notes(freelancer.id, 'contract_revision_stalled', id)).toEqual([
      {
        title: 'Revisão esperando você há 7 dias: Ensaio fotográfico',
        body: `O cliente pediu revisão em ${formatDue(requested, RB)}. Registre a nova entrega ou combine pelo chat. Nada muda sozinho, mas qualquer um de vocês pode abrir uma disputa pela Sala.`,
        data: { contractId: id },
      },
    ]);
    expect(await ledger('revision', id)).toEqual([{ due: requested.toISOString(), seq: 0 }]);

    const again = await run(plus(wall(RB, 7, 9), 5 * 60_000));
    expect(again.sent.revision).not.toContain(id);
    expect(await notes(client.id, 'contract_revision_stalled', id)).toHaveLength(1);
    expect(await notes(freelancer.id, 'contract_revision_stalled', id)).toHaveLength(1);

    // Nova entrega e nova revisão: um aviso novo, 7 dias depois do novo pedido.
    setNow(wall(SP, 7, 12));
    await deliver(id, freelancer);
    const requested2 = wall(SP, 7, 13);
    setNow(requested2);
    await requestRevision(id, client);
    const week2 = plus(requested2, 7 * DAY);
    expect((await run(plus(week2, -1000))).sent.revision).not.toContain(id);
    const second = await run(week2);
    expect(second.sent.revision).toContain(id);
    const clientNotes = await notes(client.id, 'contract_revision_stalled', id);
    expect(clientNotes).toHaveLength(2);
    expect(clientNotes[1]).toEqual({
      title: 'Revisão sem nova entrega há 7 dias: Ensaio fotográfico',
      body: `Você pediu revisão em ${formatDue(requested2, NO)} e ainda não houve nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala, e a mediação do Escambo decide sobre o valor.`,
      data: { contractId: id },
    });
    expect(await notes(freelancer.id, 'contract_revision_stalled', id)).toHaveLength(2);
    expect(await ledger('revision', id)).toEqual([
      { due: requested.toISOString(), seq: 0 },
      { due: requested2.toISOString(), seq: 0 },
    ]);
  });

  it('revisão parada de um marco: o título começa pelo fato ("Revisão … há 7 dias") e termina no nome do marco', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, 'Aplicativo de agenda', {
      price: 300,
      deadline: endOf(10),
      milestones: MILESTONES,
    });
    const [layout] = await milestonesOf(id, client);
    setNow(wall(SP, 1, 12));
    await ok(`/api/contracts/${id}/milestones/${layout!.id}/deliver`, freelancer, {
      message: 'Layout pronto.',
    });
    const requested = wall(SP, 1, 15);
    setNow(requested);
    await ok(`/api/contracts/${id}/milestones/${layout!.id}/request-revision`, client, {
      note: 'Ajustar as cores',
    });
    const m = (await milestonesRepository.listForContract(id)).find((x) => x.id === layout!.id);
    expect(iso(m?.revision_requested_at)).toBe(requested.toISOString());

    const week = plus(requested, 7 * DAY);
    expect((await run(plus(week, -1000))).sent.milestone_revision).not.toContain(layout!.id);
    expect(await notes(client.id, 'contract_revision_stalled', id)).toEqual([]);

    const r = await run(week);
    expect(r.sent.milestone_revision).toContain(layout!.id);
    const data = { contractId: id, milestoneId: layout!.id };
    expect(await notes(client.id, 'contract_revision_stalled', id)).toEqual([
      {
        title: 'Revisão sem nova entrega há 7 dias, marco «Layout»',
        body: `Aplicativo de agenda: você pediu revisão em ${formatDue(requested, SP)} e o marco ainda não foi entregue de novo. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.`,
        data,
      },
    ]);
    expect(await notes(freelancer.id, 'contract_revision_stalled', id)).toEqual([
      {
        title: 'Revisão esperando você há 7 dias, marco «Layout»',
        body: `Aplicativo de agenda: o cliente pediu revisão em ${formatDue(requested, SP)}. Entregue o marco de novo ou combine pelo chat; qualquer um de vocês pode abrir uma disputa pela Sala.`,
        data,
      },
    ]);
    expect(await ledger('milestone_revision', layout!.id)).toEqual([
      { due: requested.toISOString(), seq: 0 },
    ]);
  });

  it('troca: sem valor em garantia, o aviso ao cliente termina em "abra uma disputa pela Sala." (sem a mediação decidir sobre o valor); o do freelancer é o mesmo', async () => {
    const a = await user('freelancer');
    const b = await user('freelancer');
    const id = await barter(a, b);
    const row = await dbRow(id);
    expect(row).toMatchObject({ freelancer_id: a.id, client_id: b.id, payment_mode: 'barter' });
    await deliver(id, a);
    const requested = wall(SP, 0, 14);
    setNow(requested);
    await requestRevision(id, b);

    const r = await run(plus(requested, 7 * DAY));
    expect(r.sent.revision).toContain(id);
    expect(await notes(b.id, 'contract_revision_stalled', id)).toEqual([
      {
        title: `Revisão sem nova entrega há 7 dias: ${row.title}`,
        body: `Você pediu revisão em ${formatDue(requested, SP)} e ainda não houve nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.`,
        data: { contractId: id },
      },
    ]);
    expect(await notes(a.id, 'contract_revision_stalled', id)).toEqual([
      {
        title: `Revisão esperando você há 7 dias: ${row.title}`,
        body: `O cliente pediu revisão em ${formatDue(requested, SP)}. Registre a nova entrega ou combine pelo chat. Nada muda sozinho, mas qualquer um de vocês pode abrir uma disputa pela Sala.`,
        data: { contractId: id },
      },
    ]);
    expect(await ledger('revision', id)).toEqual([{ due: requested.toISOString(), seq: 0 }]);
  });
});

describe('A trava do lembrete', () => {
  it('estado mudou entre a leitura e a trava: a entrega (ou a aprovação) registrada depois da leitura não deixa linha nem aviso', async () => {
    const { client, freelancer } = await pair(500);
    const deadline = endOf(3);
    const id = await accepted(client, freelancer, 'Relatório anual', { deadline });
    const approvalId = await accepted(client, freelancer, 'Relatório trimestral');
    await deliver(approvalId, freelancer);

    const slot = wall(SP, 2, 9);
    const stale = await candidateOf('delivery', slot, id);
    expect(stale).toBeDefined();
    expect(iso(stale!.due_at)).toBe(deadline.toISOString());
    setNow(slot);
    await deliver(id, freelancer);
    expect(await deadlineRemindersService.delivery(stale!, 24, slot)).toBe(false);
    expect(await ledger('delivery', id)).toEqual([]);
    expect(await notes(freelancer.id, 'contract_deadline_reminder', id)).toEqual([]);
    expect((await run(slot)).sent.delivery).not.toContain(id);
    expect(await ledger('delivery', id)).toEqual([]);

    // Na aprovação, só o estado repetido na trava separa a linha velha da atual.
    const approvalSlot = wall(SP, 4, 9);
    const staleApproval = await candidateOf('approval', approvalSlot, approvalId);
    expect(staleApproval).toBeDefined();
    setNow(approvalSlot);
    await ok(`/api/contracts/${approvalId}/approve`, client);
    expect(await deadlineRemindersService.approval(staleApproval!, approvalSlot)).toBe(false);
    expect(await ledger('approval', approvalId)).toEqual([]);
    expect(await notes(client.id, 'contract_approval_reminder', approvalId)).toEqual([]);
  });

  it('o início mudou entre a leitura e a trava: pedido e recusa de extensão depois da leitura (mesmo prazo, mesmo estado, mesma chave) não deixam linha nem aviso', async () => {
    const { client, freelancer } = await pair(300);
    const deadline = endOf(3);
    const id = await accepted(client, freelancer, 'Relatório de sustentabilidade', { deadline });

    const slot = wall(SP, 2, 9);
    const stale = await candidateOf('delivery', slot, id);
    expect(stale).toBeDefined();
    expect(iso(stale!.due_at)).toBe(deadline.toISOString());
    expect(Number(stale!.seq)).toBe(0);
    // O início lido é o aceite.
    expect(iso(stale!.start_at)).toBe(base.toISOString());

    // Depois da leitura: o pedido e a recusa. O prazo e o estado voltam ao que eram; só o início
    // (a hora da recusa) mudou.
    setNow(plus(slot, 60_000));
    await askExtension(id, freelancer, endOf(6));
    const declinedAt = plus(slot, 2 * 60_000);
    setNow(declinedAt);
    await ok(`/api/contracts/${id}/extension/decline`, client);
    const row = await dbRow(id);
    expect(row).toMatchObject({ status: 'accepted', extension_status: 'declined' });
    expect(iso(row.deadline_at)).toBe(deadline.toISOString());
    expect(iso(row.extension_resolved_at)).toBe(declinedAt.toISOString());

    const at = plus(slot, 3 * 60_000);
    setNow(at);
    expect(await deadlineRemindersService.delivery(stale!, 24, at)).toBe(false);
    expect(await ledger('delivery', id)).toEqual([]);
    expect(await notes(freelancer.id, 'contract_deadline_reminder', id)).toEqual([]);
    expect(await notes(client.id, 'contract_deadline_reminder', id)).toEqual([]);
    // Relida agora, a candidata traz o início novo, que ainda não tem 12 h: fica de fora.
    expect(await candidateOf('delivery', at, id)).toBeUndefined();
  });

  it('falha ao gravar a notificação desfaz a trava e o aviso já gravado à outra parte; a rodada seguinte envia', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, 'Manual da marca');
    await deliver(id, freelancer);
    const requested = wall(SP, 0, 13);
    setNow(requested);
    await requestRevision(id, client);
    const week = plus(requested, 7 * DAY);

    // O aviso da cliente é gravado primeiro; o do freelancer falha uma vez.
    const original = notificationsRepository.create.bind(notificationsRepository);
    let thrown = false;
    const create = vi
      .spyOn(notificationsRepository, 'create')
      .mockImplementation(async (d, conn) => {
        if (!thrown && d.userId === freelancer.id && d.type === 'contract_revision_stalled') {
          thrown = true;
          throw new Error('falha simulada ao gravar a notificação');
        }
        return original(d, conn);
      });
    try {
      const failed = await run(week);
      expect(thrown).toBe(true);
      expect(failed.failed).toContain(id);
      expect(failed.sent.revision).not.toContain(id);
    } finally {
      create.mockRestore();
    }
    expect(await ledger('revision', id)).toEqual([]);
    expect(await notes(client.id, 'contract_revision_stalled', id)).toEqual([]);
    expect(await notes(freelancer.id, 'contract_revision_stalled', id)).toEqual([]);

    const next = await run(plus(week, 5 * 60_000));
    expect(next.sent.revision).toContain(id);
    expect(next.failed).not.toContain(id);
    expect(await ledger('revision', id)).toEqual([{ due: requested.toISOString(), seq: 0 }]);
    expect(await notes(client.id, 'contract_revision_stalled', id)).toHaveLength(1);
    expect(await notes(freelancer.id, 'contract_revision_stalled', id)).toHaveLength(1);
  });
});
