import type { BrazilTimezone, WalletEarnings } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { dayIn } from '../../src/utils/timezone';
import { DAY, fromNow, isoFromNow, startDaytimeClock, stopClock } from './clock.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * Ganhos do freelancer por período (RF-082) contra o MySQL real. Um freelancer passa por:
 *  - contratação de R$ 1.000 concluída (líquido R$ 850 liberado);
 *  - contratação de R$ 200 cancelada pelo cliente antes da metade do prazo (50%): só os R$ 85
 *    liberados contam, o estorno ao cliente já vem descontado na própria linha;
 *  - contratação de R$ 300 da qual ele desiste: escrow devolvido, nada liberado, não conta;
 *  - troca com torna recebida (R$ 100 − 15% = R$ 85);
 *  - contratação em créditos (40), que aparece à parte.
 * Total R$ 1.020 em 2 contratações e 1 troca: ticket médio R$ 340. O cliente não tem ganho nenhum.
 * Depois, linhas montadas em instantes certos conferem o dia, a semana e o mês no fuso da conta.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `ganhos_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

async function ganhos(who: Actor | string, query = ''): Promise<WalletEarnings> {
  const token = typeof who === 'string' ? who : who.token;
  const res = await request(app).get(`/api/wallet/earnings${query}`).set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as WalletEarnings;
}

async function propor(
  client: Actor,
  freelancer: Actor,
  p: { title: string; price: number; paymentMode?: 'cash' | 'credits'; deadlineAt?: string },
): Promise<number> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: p.title,
      description: 'Contratação do teste de ganhos do freelancer',
      price: p.price,
      paymentMode: p.paymentMode ?? 'cash',
      deadlineAt: p.deadlineAt ?? null,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

async function post(path: string, who: Actor, body: Record<string, unknown> = {}): Promise<void> {
  const res = await request(app).post(path).set(auth(who.token)).send(body);
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
}

/** Aceite, entrega e aprovação: o escrow é liberado ao freelancer. */
async function concluir(id: number, freelancer: Actor, client: Actor): Promise<void> {
  await post(`/api/contracts/${id}/accept`, freelancer);
  await post(`/api/contracts/${id}/deliver`, freelancer, { message: 'Entregue.' });
  await post(`/api/contracts/${id}/approve`, client);
}

let freelancer: Actor;
let cliente: Actor;
/** Hoje no fuso da conta (Brasília, o padrão): todas as linhas do fluxo caem nele. */
let hoje: string;
const ids: Record<'concluida' | 'parcial' | 'desistencia' | 'creditos', number> = {
  concluida: 0,
  parcial: 0,
  desistencia: 0,
  creditos: 0,
};

beforeAll(async () => {
  startDaytimeClock();
  hoje = dayIn('America/Sao_Paulo', new Date());
  freelancer = await registerAndLogin('freelancer');
  cliente = await registerAndLogin('client');

  // 1) R$ 1.000 concluída: R$ 850 liberados.
  await fundWallet(app, cliente.token, 1000);
  ids.concluida = await propor(cliente, freelancer, { title: 'Site da padaria', price: 1000 });
  await concluir(ids.concluida, freelancer, cliente);

  // 2) R$ 200 cancelada pelo cliente com 9 de 20 dias passados: 50% volta, R$ 85 liberados.
  const outro = await registerAndLogin('client');
  await fundWallet(app, outro.token, 200);
  ids.parcial = await propor(outro, freelancer, {
    title: 'Identidade visual do café',
    price: 200,
    deadlineAt: isoFromNow(5 * DAY),
  });
  await post(`/api/contracts/${ids.parcial}/accept`, freelancer);
  await pool.query(
    'UPDATE contracts SET accepted_at = :aceite, deadline_at = :prazo WHERE id = :id',
    { id: ids.parcial, aceite: fromNow(-9 * DAY), prazo: fromNow(11 * DAY) },
  );
  await post(`/api/contracts/${ids.parcial}/cancel`, outro, { expectedRefund: 100 });

  // 3) R$ 300 da qual o freelancer desiste: tudo volta ao cliente, nada é liberado.
  const terceiro = await registerAndLogin('client');
  await fundWallet(app, terceiro.token, 300);
  ids.desistencia = await propor(terceiro, freelancer, { title: 'Logo da oficina', price: 300 });
  await post(`/api/contracts/${ids.desistencia}/accept`, freelancer);
  await post(`/api/contracts/${ids.desistencia}/cancel`, freelancer);

  // 4) Troca: o outro lado oferece 300 e quer 400 do freelancer, então paga torna de R$ 100.
  const parceiro = await registerAndLogin('freelancer');
  await fundWallet(app, parceiro.token, 100);
  const troca = await request(app).post('/api/barters').set(auth(parceiro.token)).send({
    receiverId: freelancer.id,
    offeredDescription: 'Ofereço revisão de textos',
    requestedDescription: 'Quero a identidade visual',
    estimatedValueOffered: 300,
    estimatedValueRequested: 400,
  });
  expect(troca.status, JSON.stringify(troca.body)).toBe(201);
  const aceita = await request(app)
    .post(`/api/barters/${troca.body.id}/accept`)
    .set(auth(freelancer.token));
  expect(aceita.status, JSON.stringify(aceita.body)).toBe(200);
  for (const [id, quemEntrega, quemAprova] of [
    [aceita.body.contractOfferedId as number, parceiro, freelancer],
    [aceita.body.contractRequestedId as number, freelancer, parceiro],
  ] as const) {
    await post(`/api/contracts/${id}/deliver`, quemEntrega, { message: 'Entregue.' });
    await post(`/api/contracts/${id}/approve`, quemAprova);
  }
  const fechada = await request(app)
    .get(`/api/barters/${troca.body.id}`)
    .set(auth(freelancer.token));
  expect(fechada.body).toMatchObject({ status: 'completed', tornaStatus: 'paid', tornaNet: 85 });

  // 5) Créditos: 40 do bônus de boas-vindas do cliente, à parte do dinheiro.
  await request(app).get('/api/wallet').set(auth(cliente.token)).expect(200);
  ids.creditos = await propor(cliente, freelancer, {
    title: 'Aula de violão',
    price: 40,
    paymentMode: 'credits',
  });
  await concluir(ids.creditos, freelancer, cliente);
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('ganhos do freelancer (RF-082)', () => {
  it('a carteira confere com o fluxo: 850 + 85 + 85 disponíveis, nada retido', async () => {
    const w = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(w.body).toMatchObject({ balance: 1020, balancePending: 0 });
  });

  it('total, contratações pagas, trocas e ticket médio do dia; créditos à parte', async () => {
    const g = await ganhos(freelancer, `?granularity=day&from=${hoje}&to=${hoje}`);

    expect(g).toMatchObject({
      from: hoje,
      to: hoje,
      granularity: 'day',
      timezone: 'America/Sao_Paulo',
      hasEarnings: true,
      // A desistência (escrow devolvido) não conta; o cancelamento conta só a parte liberada.
      totals: { amount: 1020, contracts: 2, barters: 1, averageTicket: 340 },
      credits: { total: 40, contracts: 1 },
    });
    expect(g.series).toEqual([{ bucket: hoje, amount: 1020, contracts: 2, barters: 1 }]);
  });

  it('as linhas que entram são as de liberação e de torna; escrow retido e devolvido ficam de fora', async () => {
    const extrato = await request(app)
      .get('/api/wallet/transactions?limit=50')
      .set(auth(freelancer.token));
    const linhas = extrato.body.items as {
      reason: string;
      amount: number;
      pendingDelta: number;
      contractId: number | null;
    }[];
    const ganhas = linhas.filter((t) => ['escrow_release', 'barter_in'].includes(t.reason));
    expect(ganhas.map((t) => [t.reason, t.amount, t.contractId])).toEqual([
      ['barter_in', 85, null],
      ['escrow_release', 85, ids.parcial],
      ['escrow_release', 850, ids.concluida],
    ]);
    // O estorno da desistência existe no extrato, mas não mexe no disponível.
    expect(linhas.find((t) => t.reason === 'escrow_refund')).toMatchObject({
      amount: 0,
      pendingDelta: -255,
      contractId: ids.desistencia,
    });
  });

  it('sem período: os últimos 12 meses, por mês, com o mês de hoje no fim', async () => {
    const g = await ganhos(freelancer);

    expect(g.granularity).toBe('month');
    expect(g.to).toBe(hoje);
    expect(g.series).toHaveLength(12);
    expect(g.series.at(-1)).toEqual({
      bucket: hoje.slice(0, 7),
      amount: 1020,
      contracts: 2,
      barters: 1,
    });
    expect(g.series.slice(0, -1).every((b) => b.amount === 0)).toBe(true);
    expect(g.totals.amount).toBe(1020);
  });

  it('quem só contratou não tem ganho: vazio honesto, e o dinheiro alheio não aparece', async () => {
    const g = await ganhos(cliente, `?granularity=week`);

    expect(g.hasEarnings).toBe(false);
    expect(g.totals).toEqual({ amount: 0, contracts: 0, barters: 0, averageTicket: null });
    expect(g.credits).toEqual({ total: 0, contracts: 0 });
    expect(g.series).toHaveLength(12);
  });

  it('período sem ganho: zeros, mas a pessoa já recebeu antes', async () => {
    const g = await ganhos(freelancer, '?granularity=day&from=2026-01-01&to=2026-01-03');

    expect(g.hasEarnings).toBe(true);
    expect(g.series.map((b) => b.amount)).toEqual([0, 0, 0]);
    expect(g.credits).toEqual({ total: 0, contracts: 0 });
  });

  it('período invertido é 400, longo demais é 400, dia inexistente é 422', async () => {
    const inv = await request(app)
      .get('/api/wallet/earnings?from=2026-10-02&to=2026-10-01')
      .set(auth(freelancer.token))
      .expect(400);
    expect(inv.body.error).toBe('invalid_range');

    const longo = await request(app)
      .get('/api/wallet/earnings?granularity=day&from=2024-01-01&to=2026-01-01')
      .set(auth(freelancer.token))
      .expect(400);
    expect(longo.body.error).toBe('range_too_long');

    const ruim = await request(app)
      .get('/api/wallet/earnings?to=2026-02-30')
      .set(auth(freelancer.token))
      .expect(422);
    expect(ruim.body.details.to).toEqual(['Informe um dia válido no formato AAAA-MM-DD']);
  });
});

/** Conta com fuso escolhido e linhas em instantes certos (sem contratação: cada uma é um pagamento). */
async function conta(timezone: BrazilTimezone): Promise<Actor> {
  const key = ulid();
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone)
     VALUES (:key, :email, 'freelancer', 'active', :timezone)`,
    { key, email: `ganhos-fuso-${key}@escambo.test`, timezone },
  );
  return {
    id: created.insertId,
    token: jwt.sign({ sub: key, uid: created.insertId, role: 'freelancer' }, env.JWT_SECRET, {
      expiresIn: '1h',
    }),
  };
}

async function linha(
  userId: number,
  reason: string,
  amount: number,
  pendingDelta: number,
  at: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO wallet_transactions
       (user_id, amount, pending_delta, balance_after, pending_after, reason, created_at)
     VALUES (:userId, :amount, :pendingDelta, 0, 0, :reason, :at)`,
    { userId, amount, pendingDelta, reason, at: new Date(at) },
  );
}

describe('ganhos no fuso da conta (ADR 46)', () => {
  let manaus: Actor;
  let brasilia: Actor;
  // Os mesmos instantes nas duas contas; o que muda é o dia, a semana e o mês de cada fuso.
  const instantes = [
    ['escrow_release', 10, '2026-09-30T23:30:00Z'], // Manaus 30/09 19:30 · Brasília 30/09 20:30
    ['barter_in', 20, '2026-10-01T03:30:00Z'], //       Manaus 30/09 23:30 · Brasília 01/10 00:30
    ['escrow_release', 40, '2026-10-01T04:00:00Z'], //  Manaus 01/10 00:00 · Brasília 01/10 01:00
    ['escrow_release', 80, '2026-10-05T03:30:00Z'], //  Manaus dom 04/10 23:30 · Brasília seg 05/10 00:30
  ] as const;

  beforeAll(async () => {
    manaus = await conta('America/Manaus');
    brasilia = await conta('America/Sao_Paulo');
    for (const who of [manaus, brasilia]) {
      for (const [reason, amount, at] of instantes) await linha(who.id, reason, amount, 0, at);
      // O que não é ganho, no mesmo período: escrow que entra, escrow devolvido, depósito e saque.
      await linha(who.id, 'escrow_in', 0, 500, '2026-10-02T15:00:00Z');
      await linha(who.id, 'escrow_refund', 0, -500, '2026-10-02T16:00:00Z');
      await linha(who.id, 'deposit', 300, 0, '2026-10-02T17:00:00Z');
      await linha(who.id, 'withdrawal', -100, 0, '2026-10-02T18:00:00Z');
    }
  });

  it('por dia: a meia-noite é a do fuso de quem lê', async () => {
    const q = '?granularity=day&from=2026-09-30&to=2026-10-02';
    expect((await ganhos(manaus, q)).series.map((b) => b.amount)).toEqual([30, 40, 0]);
    expect((await ganhos(brasilia, q)).series.map((b) => b.amount)).toEqual([10, 60, 0]);
  });

  it('por semana (segunda a domingo): o domingo à noite em Manaus ainda é a semana anterior', async () => {
    const q = '?granularity=week&from=2026-09-28&to=2026-10-11';
    expect((await ganhos(manaus, q)).series).toEqual([
      { bucket: '2026-09-28', amount: 150, contracts: 3, barters: 1 },
      { bucket: '2026-10-05', amount: 0, contracts: 0, barters: 0 },
    ]);
    expect((await ganhos(brasilia, q)).series.map((b) => [b.bucket, b.amount])).toEqual([
      ['2026-09-28', 70],
      ['2026-10-05', 80],
    ]);
  });

  it('por mês: o mesmo instante é setembro em Manaus e outubro em Brasília', async () => {
    const q = '?granularity=month&from=2026-09-01&to=2026-10-31';
    expect((await ganhos(manaus, q)).series.map((b) => b.amount)).toEqual([30, 120]);
    const b = await ganhos(brasilia, q);
    expect(b.series.map((x) => x.amount)).toEqual([10, 140]);
    // Sem contratação ligada, cada liberação é um pagamento à parte; a torna é uma troca.
    expect(b.totals).toEqual({ amount: 150, contracts: 3, barters: 1, averageTicket: 37.5 });
  });
});
