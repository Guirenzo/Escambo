import type { CancelTerms } from '@escambo/types';
import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runOverdueContracts } from '../../src/jobs/overdue-contracts';
import {
  contractsRepository,
  type ContractRow,
} from '../../src/modules/contracts/contracts.repository';
import { openDeliveredMilestone } from '../../src/modules/contracts/deadline-sql';
import { milestonesRepository } from '../../src/modules/contracts/milestones.repository';
import type { WalletEffect } from '../../src/modules/wallet/wallet.ledger';
import { setClockForTests } from '../../src/utils/clock';
import { formatDue } from '../../src/utils/timezone';
import {
  DAY,
  fromNow,
  HOUR,
  isoFromNow,
  noonBrasilia,
  now,
  startDaytimeClock,
  stopClock,
} from './clock.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * Cancelamento com valores (RN-025, RN-026, ADR 57) contra o MySQL real, conferindo as carteiras
 * (GET /api/wallet) e os avisos à outra parte:
 *  - o freelancer que desiste devolve tudo ao cliente, com ou sem prazo vencido;
 *  - prazo vencido sem entrega: 100% a partir do aviso das 9h no fuso de quem entrega (gravado
 *    pelo job ou previsto); antes disso, 409 wait_notice; com pedido de extensão esperando o
 *    cliente, 409 extension_pending_answer;
 *  - antes do prazo, 50% ou 0% pela fração do tempo contada do ACEITE (a metade exata já é 0%);
 *  - por marcos, marco entregue esperando o cliente ou em revisão trava (409 milestone_open);
 *  - créditos voltam inteiros; expectedRefund diferente do da tela → 409 cancel_quote_changed;
 *  - o "cancellation" do GET é o que o POST liquida; a guarda da gravação barra a corrida (marco
 *    entregue ou aprovado no meio, extensão aceita no meio) direto no repositório;
 *  - cancelar encerra o pedido de extensão pendente.
 * Contratações de R$ 200 (taxa 15%, líquido 170), salvo indicação. A troca não move dinheiro no
 * cancelamento e já é coberta por barter-flow.int.test.ts.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `cancel_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

async function fuso(a: Actor, timezone: string): Promise<void> {
  await pool.query('UPDATE users SET timezone = :timezone WHERE id = :id', {
    id: a.id,
    timezone,
  });
}

interface Carteira {
  balance: number;
  balancePending: number;
  credits: number;
  creditsPending: number;
}

async function carteira(token: string): Promise<Carteira> {
  const res = await request(app).get('/api/wallet').set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const { balance, balancePending, credits, creditsPending } = res.body as Carteira;
  return { balance, balancePending, credits, creditsPending };
}

/** R$ disponível e retido. */
async function reais(token: string): Promise<{ balance: number; balancePending: number }> {
  const w = await carteira(token);
  return { balance: w.balance, balancePending: w.balancePending };
}

/** Créditos disponíveis e em garantia. */
async function creditos(token: string): Promise<{ credits: number; creditsPending: number }> {
  const w = await carteira(token);
  return { credits: w.credits, creditsPending: w.creditsPending };
}

/** As duas carteiras inteiras, para conferir que nada se moveu. */
const carteiras = async (a: Actor, b: Actor): Promise<Carteira[]> => [
  await carteira(a.token),
  await carteira(b.token),
];

interface Detalhe {
  status: string;
  deadlineAt: string | null;
  overdueNotifiedAt: string | null;
  extension: { status: string; resolvedAt: string | null; seq: number } | null;
  deadline: { state: string; noticeAt: string | null };
  history: { status: string; previousStatus: string | null; note: string | null }[];
  milestones: { id: number; title: string; status: string; deliveredAt: string | null }[];
  cancellation: CancelTerms | null;
}

async function detalhe(id: number, token: string): Promise<Detalhe> {
  const res = await request(app).get(`/api/contracts/${id}`).set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Detalhe;
}

/** O cancelamento que a Sala mostra a quem abre. */
async function cotacao(id: number, token: string): Promise<CancelTerms> {
  const c = (await detalhe(id, token)).cancellation;
  expect(c).not.toBeNull();
  return c!;
}

const cancelar = (id: number, token: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/contracts/${id}/cancel`).set(auth(token)).send(body);

interface Proposta {
  title: string;
  price?: number;
  deadlineAt?: string | null;
  paymentMode?: 'cash' | 'credits';
  milestones?: { title: string; amount: number }[];
}

async function propor(client: Actor, freelancer: Actor, p: Proposta): Promise<number> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: p.title,
      description: 'Contratação do teste de cancelamento com valores',
      price: p.price ?? 200,
      paymentMode: p.paymentMode ?? 'cash',
      deadlineAt: p.deadlineAt ?? null,
      ...(p.milestones ? { milestones: p.milestones } : {}),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

async function aceitar(id: number, freelancer: Actor): Promise<void> {
  const res = await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/**
 * Cliente e freelancer novos e a contratação aceita (em dinheiro): o cliente fica com 0 e o
 * freelancer com o líquido retido (R$ 170 numa de R$ 200).
 */
async function contratado(
  p: Proposta & { fusoFreelancer?: string },
): Promise<{ client: Actor; freelancer: Actor; id: number }> {
  const client = await registerAndLogin('client');
  const freelancer = await registerAndLogin('freelancer');
  if (p.fusoFreelancer) await fuso(freelancer, p.fusoFreelancer);
  await fundWallet(app, client.token, p.price ?? 200);
  const id = await propor(client, freelancer, p);
  await aceitar(id, freelancer);
  return { client, freelancer, id };
}

async function definirPrazo(id: number, prazo: Date): Promise<void> {
  await pool.query('UPDATE contracts SET deadline_at = :prazo WHERE id = :id', { id, prazo });
}

/** Anda o tempo da contratação: aceite e prazo em relação ao agora do fluxo. */
async function aceiteEPrazo(id: number, aceite: Date, prazo: Date): Promise<void> {
  await pool.query(
    'UPDATE contracts SET accepted_at = :aceite, deadline_at = :prazo WHERE id = :id',
    {
      id,
      aceite,
      prazo,
    },
  );
}

const pedirExtensao = (id: number, freelancer: Actor, deadlineAt: string) =>
  request(app)
    .post(`/api/contracts/${id}/extension`)
    .set(auth(freelancer.token))
    .send({ deadlineAt, reason: 'O material do cliente chegou depois do combinado' });

async function entregarMarco(id: number, marco: number, freelancer: Actor): Promise<void> {
  const res = await request(app)
    .post(`/api/contracts/${id}/milestones/${marco}/deliver`)
    .set(auth(freelancer.token))
    .send({ message: 'Marco pronto, confira no link do chat' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function aprovarMarco(id: number, marco: number, client: Actor): Promise<void> {
  const res = await request(app)
    .post(`/api/contracts/${id}/milestones/${marco}/approve`)
    .set(auth(client.token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

interface Aviso {
  type: string;
  title: string;
  body: string | null;
  data: { contractId?: number } | null;
}

/** O aviso desse tipo sobre a contratação: é gravado depois da resposta, então espera aparecer. */
async function avisoDe(token: string, type: string, contractId: number): Promise<Aviso> {
  let achado: Aviso | undefined;
  await expect
    .poll(
      async () => {
        const res = await request(app).get('/api/notifications').set(auth(token));
        const items = (res.body?.items ?? []) as Aviso[];
        achado = items.find((n) => n.type === type && n.data?.contractId === contractId);
        return achado !== undefined;
      },
      { timeout: 5000, interval: 100 },
    )
    .toBe(true);
  return achado!;
}

const MARCOS = [
  { title: 'Layout', amount: 333.33 },
  { title: 'Front-end', amount: 333.33 },
  { title: 'Publicação', amount: 333.34 },
];

type Guarda = { sql: string; params: Record<string, unknown> };

/**
 * A guarda que contractsService.cancel monta com o que leu, copiada de lá de propósito: se o
 * service mudar a guarda, este teste precisa mudar junto.
 */
function guardaDoCancelamento(
  row: ContractRow,
  escrow: { price: number; net: number } | null,
): Guarda {
  const sql = [
    'AND c.deadline_at <=> :gDeadline',
    'AND c.overdue_notified_at <=> :gNotice',
    'AND c.extension_status = :gExtStatus',
    'AND c.extension_requests = :gExtRequests',
  ];
  if (escrow) {
    sql.push(
      `AND NOT ${openDeliveredMilestone('c')}`,
      `AND ROUND(COALESCE((SELECT SUM(mg.amount) FROM contract_milestones mg
             WHERE mg.contract_id = c.id AND mg.status IN ('pending', 'funded', 'delivered')), 0) * 100)
             = :gEscrowCents`,
    );
  }
  return {
    sql: sql.join('\n'),
    params: {
      gDeadline: row.deadline_at ? new Date(row.deadline_at) : null,
      gNotice: row.overdue_notified_at ? new Date(row.overdue_notified_at) : null,
      gExtStatus: row.extension_status,
      gExtRequests: Number(row.extension_requests ?? 0),
      gEscrowCents: escrow ? Math.round(escrow.price * 100) : 0,
    },
  };
}

/** A guarda ainda vale para a linha como ela está agora? */
async function guardaVale(id: number, from: string, guarda: Guarda): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM contracts c WHERE c.id = :id AND c.status = :from ${guarda.sql}`,
    { ...guarda.params, id, from },
  );
  return Number(rows[0]!.n) === 1;
}

/** A gravação do cancelamento em dinheiro como o service faria com a leitura `row`. */
function transicaoDoCancelamento(
  row: ContractRow,
  changedBy: number,
  terms: CancelTerms,
  net: number,
  guard: Guarda,
): Parameters<typeof contractsRepository.transition>[0] {
  const walletEffects: WalletEffect[] = [
    {
      userId: row.freelancer_id,
      pendingDelta: -net,
      balanceDelta: terms.releaseFreelancer,
      reason: terms.releaseFreelancer > 0 ? 'escrow_release' : 'escrow_refund',
    },
  ];
  if (terms.refundClient > 0) {
    walletEffects.push({
      userId: row.client_id,
      pendingDelta: 0,
      balanceDelta: terms.refundClient,
      reason: 'refund',
    });
  }
  return {
    id: row.id,
    changedBy,
    from: row.status,
    to: 'cancelled',
    note: `Reembolso: ${terms.refundPercentage}% (gravação com a leitura antiga)`,
    timestampColumn: 'cancelled_at',
    now: now(),
    closePendingExtension: true,
    guard,
    milestonesTo: { from: ['pending', 'funded', 'delivered'], to: 'cancelled' },
    walletEffects,
  };
}

beforeAll(async () => {
  startDaytimeClock();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('Desistência do freelancer (F4)', () => {
  it('com o prazo vencido e nada entregue: o cliente recebe os R$ 200 e o freelancer fica sem nada', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Logo da padaria',
      deadlineAt: isoFromNow(5 * DAY),
    });
    await definirPrazo(id, fromNow(-30 * HOUR));
    expect(await reais(client.token)).toEqual({ balance: 0, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 0, balancePending: 170 });

    expect(await cotacao(id, freelancer.token)).toMatchObject({
      allowed: true,
      by: 'freelancer',
      stage: 'withdrawal',
      refundPercentage: 100,
      refundClient: 200,
      releaseFreelancer: 0,
      unit: 'BRL',
    });
    const res = await cancelar(id, freelancer.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      status: 'cancelled',
      stage: 'withdrawal',
      by: 'freelancer',
      refundPercentage: 100,
      refundClient: 200,
      releaseFreelancer: 0,
      unit: 'BRL',
    });
    expect(await reais(client.token)).toEqual({ balance: 200, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 0, balancePending: 0 });

    const d = await detalhe(id, client.token);
    expect(d.status).toBe('cancelled');
    expect(d.history.at(-1)).toMatchObject({
      previousStatus: 'accepted',
      status: 'cancelled',
      note: 'Reembolso: 100% (o freelancer desistiu)',
    });
    expect(await avisoDe(client.token, 'contract_cancelled', id)).toMatchObject({
      title: 'O freelancer desistiu: Logo da padaria',
      body: 'R$ 200,00 voltou para a sua carteira.',
    });
  });

  it('antes do prazo: a mesma coisa, tudo volta ao cliente', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Cartão de visita',
      deadlineAt: isoFromNow(5 * DAY),
    });
    const res = await cancelar(id, freelancer.token, { expectedRefund: 200 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      status: 'cancelled',
      stage: 'withdrawal',
      by: 'freelancer',
      refundPercentage: 100,
      refundClient: 200,
      releaseFreelancer: 0,
      unit: 'BRL',
    });
    expect(await reais(client.token)).toEqual({ balance: 200, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 0, balancePending: 0 });
    expect(await avisoDe(client.token, 'contract_cancelled', id)).toMatchObject({
      title: 'O freelancer desistiu: Cartão de visita',
      body: 'R$ 200,00 voltou para a sua carteira.',
    });
  });
});

describe('Prazo vencido sem entrega (F5)', () => {
  it('com o aviso dado pelo job: o cliente cancela e recebe 100%; o freelancer sabe que o prazo tinha vencido', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Tradução do site',
      deadlineAt: isoFromNow(5 * DAY),
    });
    await definirPrazo(id, fromNow(-30 * HOUR));
    const fase1 = await runOverdueContracts(now());
    expect(fase1.notified).toContain(id);

    const d = await detalhe(id, client.token);
    expect(d.overdueNotifiedAt).not.toBeNull();
    expect(d.deadline.state).toBe('grace');
    expect(d.cancellation).toMatchObject({
      allowed: true,
      by: 'client',
      stage: 'overdue',
      refundPercentage: 100,
      refundClient: 200,
      releaseFreelancer: 0,
    });

    const res = await cancelar(id, client.token, { expectedRefund: 200 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      status: 'cancelled',
      stage: 'overdue',
      by: 'client',
      refundPercentage: 100,
      refundClient: 200,
      releaseFreelancer: 0,
      unit: 'BRL',
    });
    expect(await reais(client.token)).toEqual({ balance: 200, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 0, balancePending: 0 });
    expect((await detalhe(id, client.token)).history.at(-1)?.note).toBe(
      'Reembolso: 100% (prazo vencido sem entrega)',
    );

    const aviso = await avisoDe(freelancer.token, 'contract_cancelled', id);
    expect(aviso.title).toBe('Contratação cancelada pelo cliente: Tradução do site');
    expect(aviso.body).toBe('O prazo tinha vencido sem entrega: R$ 200,00 voltou ao cliente.');
  });

  it('entre o prazo e o aviso das 9h no fuso do freelancer: 409 wait_notice e nada se move; a partir do aviso, 100%', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Cardápio da lanchonete',
      deadlineAt: isoFromNow(5 * DAY),
      fusoFreelancer: 'America/Rio_Branco',
    });
    await fuso(client, 'America/Sao_Paulo');
    // Prazo às 23:00 de Brasília (21:00 em Rio Branco): o aviso só sai às 9h de Rio Branco do dia
    // seguinte, 11:00 de Brasília.
    const meioDia = noonBrasilia(now());
    const prazo = new Date(meioDia.getTime() + 11 * HOUR);
    const aviso = new Date(meioDia.getTime() + 23 * HOUR);
    await definirPrazo(id, prazo);
    const antes = await carteiras(client, freelancer);
    expect(antes.map((w) => [w.balance, w.balancePending])).toEqual([
      [0, 0],
      [0, 170],
    ]);

    const retorno = now();
    try {
      // 02:00 de Brasília (00:00 em Rio Branco): o prazo venceu há 3 h, o aviso ainda não saiu.
      setClockForTests(new Date(meioDia.getTime() + 14 * HOUR));
      const mensagem = `O prazo venceu há pouco. ${formatDue(aviso, 'America/Sao_Paulo')} o Escambo avisa o freelancer; a partir daí, cancelar devolve tudo a você.`;
      const d = await detalhe(id, client.token);
      expect(d.deadline).toMatchObject({ state: 'due', noticeAt: aviso.toISOString() });
      expect(d.cancellation).toMatchObject({
        allowed: false,
        by: 'client',
        stage: null,
        refundClient: 0,
        releaseFreelancer: 0,
        code: 'wait_notice',
        message: mensagem,
        availableAt: aviso.toISOString(),
      });
      const cedo = await cancelar(id, client.token);
      expect(cedo.status, JSON.stringify(cedo.body)).toBe(409);
      expect(cedo.body.error).toBe('wait_notice');
      expect(cedo.body.message).toContain('o Escambo avisa o freelancer');
      expect(cedo.body.message).toBe(mensagem);
      expect(await carteiras(client, freelancer)).toEqual(antes);
      expect((await detalhe(id, client.token)).status).toBe('accepted');

      // 09:30 de Brasília ainda é 07:30 em Rio Branco: vale o fuso de quem entrega.
      setClockForTests(new Date(meioDia.getTime() + 21 * HOUR + 30 * 60_000));
      const ainda = await cancelar(id, client.token);
      expect(ainda.status, JSON.stringify(ainda.body)).toBe(409);
      expect(ainda.body.error).toBe('wait_notice');
      expect(await carteiras(client, freelancer)).toEqual(antes);

      // 11:30 de Brasília: a hora do aviso passou (mesmo sem o job ter rodado) e volta tudo.
      setClockForTests(new Date(meioDia.getTime() + 23 * HOUR + 30 * 60_000));
      const depois = await cancelar(id, client.token, { expectedRefund: 200 });
      expect(depois.status, JSON.stringify(depois.body)).toBe(200);
      expect(depois.body).toMatchObject({
        stage: 'overdue',
        refundPercentage: 100,
        refundClient: 200,
        releaseFreelancer: 0,
      });
      expect(await reais(client.token)).toEqual({ balance: 200, balancePending: 0 });
      expect(await reais(freelancer.token)).toEqual({ balance: 0, balancePending: 0 });
    } finally {
      startDaytimeClock(retorno);
    }
  });

  it('com pedido de extensão esperando o cliente e sem aviso: 409 extension_pending_answer; depois da recusa, 100%', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Relatório anual',
      deadlineAt: isoFromNow(5 * DAY),
    });
    await definirPrazo(id, fromNow(-2 * HOUR));
    const pedido = await pedirExtensao(id, freelancer, isoFromNow(5 * DAY));
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(200);
    expect(pedido.body.extension).toMatchObject({ status: 'pending' });

    const mensagem =
      'Há um pedido de extensão esperando a sua resposta: responda antes de cancelar.';
    const d = await detalhe(id, client.token);
    expect(d.overdueNotifiedAt).toBeNull();
    expect(d.cancellation).toMatchObject({
      allowed: false,
      code: 'extension_pending_answer',
      message: mensagem,
      refundClient: 0,
    });
    const antes = await carteiras(client, freelancer);
    const res = await cancelar(id, client.token);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toEqual({ error: 'extension_pending_answer', message: mensagem });
    expect(await carteiras(client, freelancer)).toEqual(antes);
    expect((await detalhe(id, client.token)).status).toBe('accepted');

    // Recusado o pedido, a hora do aviso (a do próprio prazo, de dia) já passou: 100%.
    const recusa = await request(app)
      .post(`/api/contracts/${id}/extension/decline`)
      .set(auth(client.token));
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(200);
    const depois = await cancelar(id, client.token, { expectedRefund: 200 });
    expect(depois.status, JSON.stringify(depois.body)).toBe(200);
    expect(depois.body).toMatchObject({
      stage: 'overdue',
      refundClient: 200,
      releaseFreelancer: 0,
    });
    expect(await reais(client.token)).toEqual({ balance: 200, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 0, balancePending: 0 });
  });

  it('pedido recusado de noite, depois do prazo: o cancelamento integral espera as 9h, a mesma hora que a Sala mostra', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Catálogo de verão',
      deadlineAt: isoFromNow(5 * DAY),
    });
    await fuso(client, 'America/Sao_Paulo');
    await fuso(freelancer, 'America/Sao_Paulo');
    const meioDia = noonBrasilia(now());
    const pedido = await pedirExtensao(id, freelancer, isoFromNow(9 * DAY));
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(200);
    // O prazo venceu às 10:00 com o pedido pendente (a fase 1 ficou segurada).
    await definirPrazo(id, new Date(meioDia.getTime() - 2 * HOUR));
    const retorno = now();
    try {
      // 22:00 de Brasília: a cliente recusa. O aviso só pode sair às 9h de amanhã.
      setClockForTests(new Date(meioDia.getTime() + 10 * HOUR));
      const recusa = await request(app)
        .post(`/api/contracts/${id}/extension/decline`)
        .set(auth(client.token));
      expect(recusa.status, JSON.stringify(recusa.body)).toBe(200);
      const aviso = new Date(meioDia.getTime() + 21 * HOUR); // 09:00 de amanhã
      const d = await detalhe(id, client.token);
      expect(d.deadline).toMatchObject({ state: 'due', noticeAt: aviso.toISOString() });
      expect(d.cancellation).toMatchObject({
        allowed: false,
        code: 'wait_notice',
        availableAt: aviso.toISOString(),
      });
      const antes = await carteiras(client, freelancer);
      const cedo = await cancelar(id, client.token);
      expect(cedo.status, JSON.stringify(cedo.body)).toBe(409);
      expect(cedo.body.error).toBe('wait_notice');
      expect(await carteiras(client, freelancer)).toEqual(antes);

      // 09:05: o job avisa, e a partir daí volta tudo.
      setClockForTests(new Date(aviso.getTime() + 5 * 60_000));
      expect((await runOverdueContracts(now())).notified).toContain(id);
      const depois = await cancelar(id, client.token, { expectedRefund: 200 });
      expect(depois.status, JSON.stringify(depois.body)).toBe(200);
      expect(depois.body).toMatchObject({ stage: 'overdue', refundClient: 200 });
    } finally {
      startDaytimeClock(retorno);
    }
  });
});

describe('Antes do prazo: 50% ou 0% pelo tempo desde o aceite', () => {
  it('menos da metade do tempo (9 de 20 dias): 50%, cliente +100 e freelancer +85', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Identidade visual do café',
      deadlineAt: isoFromNow(5 * DAY),
    });
    await aceiteEPrazo(id, fromNow(-9 * DAY), fromNow(11 * DAY));
    expect(await cotacao(id, client.token)).toMatchObject({
      allowed: true,
      stage: 'early',
      refundPercentage: 50,
      refundClient: 100,
      releaseFreelancer: 85,
      noticeAt: null,
    });
    const res = await cancelar(id, client.token, { expectedRefund: 100 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ stage: 'early', refundPercentage: 50 });
    expect(await reais(client.token)).toEqual({ balance: 100, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 85, balancePending: 0 });
    expect(await avisoDe(freelancer.token, 'contract_cancelled', id)).toMatchObject({
      title: 'Contratação cancelada pelo cliente: Identidade visual do café',
      body: 'R$ 85,00 foi liberado na sua carteira e R$ 100,00 voltou ao cliente (reembolso de 50%).',
    });
  });

  it('mais da metade do tempo (18 de 20 dias): 0%, o freelancer fica com os R$ 170', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Edição do podcast',
      deadlineAt: isoFromNow(5 * DAY),
    });
    const prazo = fromNow(2 * DAY);
    await aceiteEPrazo(id, fromNow(-18 * DAY), prazo);
    // O aviso de atraso previsto (a hora do prazo, que já é de dia) é o que a Sala mostra.
    expect(await cotacao(id, client.token)).toMatchObject({
      allowed: true,
      stage: 'late',
      refundPercentage: 0,
      refundClient: 0,
      releaseFreelancer: 170,
      noticeAt: prazo.toISOString(),
    });
    const res = await cancelar(id, client.token, { expectedRefund: 0 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ stage: 'late', refundPercentage: 0 });
    expect(await reais(client.token)).toEqual({ balance: 0, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 170, balancePending: 0 });
    expect(await avisoDe(freelancer.token, 'contract_cancelled', id)).toMatchObject({
      title: 'Contratação cancelada pelo cliente: Edição do podcast',
      body: 'R$ 170,00 foi liberado na sua carteira: mais da metade do tempo até o prazo já tinha passado.',
    });
  });

  it('a proposta que esperou 36 h pelo aceite: a fração conta do aceite (40%), não do envio', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Planilha de custos',
      deadlineAt: isoFromNow(5 * DAY),
    });
    // Enviada há 60 h, aceita há 24 h, prazo daqui a 36 h: 24/60 = 40% desde o aceite (seria
    // 60/96 = 62,5% desde o envio).
    await pool.query(
      `UPDATE contracts SET created_at = :criada, accepted_at = :aceite, deadline_at = :prazo
        WHERE id = :id`,
      { id, criada: fromNow(-60 * HOUR), aceite: fromNow(-24 * HOUR), prazo: fromNow(36 * HOUR) },
    );
    expect(await cotacao(id, client.token)).toMatchObject({
      stage: 'early',
      refundClient: 100,
      releaseFreelancer: 85,
    });
    const res = await cancelar(id, client.token, { expectedRefund: 100 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ stage: 'early', refundPercentage: 50 });
    expect(await reais(client.token)).toEqual({ balance: 100, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 85, balancePending: 0 });
  });

  it('exatamente na metade do tempo (10 de 20 dias, relógio parado) já é 0%', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Roteiro do vídeo',
      deadlineAt: isoFromNow(5 * DAY),
    });
    const retorno = now();
    const t = now();
    setClockForTests(t, { frozen: true });
    try {
      await aceiteEPrazo(id, new Date(t.getTime() - 10 * DAY), new Date(t.getTime() + 10 * DAY));
      expect(await cotacao(id, client.token)).toMatchObject({
        stage: 'late',
        refundPercentage: 0,
        refundClient: 0,
        releaseFreelancer: 170,
      });
      const res = await cancelar(id, client.token, { expectedRefund: 0 });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ stage: 'late', refundPercentage: 0 });
      expect(await reais(client.token)).toEqual({ balance: 0, balancePending: 0 });
      expect(await reais(freelancer.token)).toEqual({ balance: 170, balancePending: 0 });
    } finally {
      startDaytimeClock(retorno);
    }
  });
});

describe('Por marcos: marco entregue em aberto trava', () => {
  it('marco entregue esperando o cliente, e depois em revisão: 409 milestone_open para os dois, nada se move', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 1000);
    const id = await propor(client, freelancer, {
      title: 'Site da clínica em 3 etapas',
      price: 1000,
      milestones: MARCOS,
    });
    await aceitar(id, freelancer);
    const [m1] = (await detalhe(id, client.token)).milestones;
    await entregarMarco(id, m1!.id, freelancer);
    expect(await reais(client.token)).toEqual({ balance: 0, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 0, balancePending: 850 });
    const antes = await carteiras(client, freelancer);

    const esperandoCliente =
      'Há marco entregue esperando a sua resposta: aprove, peça revisão ou abra uma disputa antes de cancelar.';
    const esperandoFreelancer =
      'Há marco entregue esperando o cliente: aguarde a resposta ou abra uma disputa antes de desistir.';
    expect(await cotacao(id, client.token)).toMatchObject({
      allowed: false,
      code: 'milestone_open',
      message: esperandoCliente,
      refundClient: 0,
    });
    expect(await cotacao(id, freelancer.token)).toMatchObject({
      allowed: false,
      code: 'milestone_open',
      message: esperandoFreelancer,
    });
    const doCliente = await cancelar(id, client.token);
    expect(doCliente.status, JSON.stringify(doCliente.body)).toBe(409);
    expect(doCliente.body).toEqual({ error: 'milestone_open', message: esperandoCliente });
    const doFreelancer = await cancelar(id, freelancer.token);
    expect(doFreelancer.status, JSON.stringify(doFreelancer.body)).toBe(409);
    expect(doFreelancer.body).toEqual({ error: 'milestone_open', message: esperandoFreelancer });
    expect(await carteiras(client, freelancer)).toEqual(antes);

    // O cliente pede revisão: o marco volta a 'funded', mas foi entregue e continua em aberto.
    const rev = await request(app)
      .post(`/api/contracts/${id}/milestones/${m1!.id}/request-revision`)
      .set(auth(client.token))
      .send({ note: 'Faltou a página de contato' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const d = await detalhe(id, client.token);
    expect(d.milestones[0]).toMatchObject({ status: 'funded', deliveredAt: expect.any(String) });

    const revisaoCliente =
      'Há marco em revisão esperando a nova entrega: aguarde ou abra uma disputa antes de cancelar.';
    const revisaoFreelancer =
      'Há marco em revisão esperando você: entregue de novo ou abra uma disputa antes de desistir.';
    expect(d.cancellation).toMatchObject({
      allowed: false,
      code: 'milestone_open',
      message: revisaoCliente,
    });
    const deNovoCliente = await cancelar(id, client.token);
    expect(deNovoCliente.status).toBe(409);
    expect(deNovoCliente.body).toEqual({ error: 'milestone_open', message: revisaoCliente });
    const deNovoFreelancer = await cancelar(id, freelancer.token);
    expect(deNovoFreelancer.status).toBe(409);
    expect(deNovoFreelancer.body).toEqual({ error: 'milestone_open', message: revisaoFreelancer });
    expect(await carteiras(client, freelancer)).toEqual(antes);

    const final = await detalhe(id, client.token);
    expect(final.status).toBe('in_progress');
    expect(final.milestones.map((m) => m.status)).toEqual(['funded', 'funded', 'funded']);
  });
});

describe('Créditos', () => {
  it('cancelar depois do aceite devolve os créditos inteiros, mesmo passada a metade do prazo', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    // Bônus de boas-vindas (100 créditos) no primeiro acesso à carteira.
    expect(await creditos(client.token)).toEqual({ credits: 100, creditsPending: 0 });
    expect(await creditos(freelancer.token)).toEqual({ credits: 100, creditsPending: 0 });
    const id = await propor(client, freelancer, {
      title: 'Aula de violão',
      price: 40,
      paymentMode: 'credits',
      deadlineAt: isoFromNow(5 * DAY),
    });
    await aceitar(id, freelancer);
    expect(await creditos(client.token)).toEqual({ credits: 60, creditsPending: 0 });
    expect(await creditos(freelancer.token)).toEqual({ credits: 100, creditsPending: 40 });

    // Em dinheiro seria 0% (18 de 20 dias); em créditos volta tudo.
    await aceiteEPrazo(id, fromNow(-18 * DAY), fromNow(2 * DAY));
    expect(await cotacao(id, client.token)).toMatchObject({
      allowed: true,
      stage: 'credits',
      refundPercentage: 100,
      refundClient: 40,
      releaseFreelancer: 0,
      unit: 'credits',
    });
    const res = await cancelar(id, client.token, { expectedRefund: 40 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      status: 'cancelled',
      stage: 'credits',
      by: 'client',
      refundPercentage: 100,
      refundClient: 40,
      releaseFreelancer: 0,
      unit: 'credits',
    });
    expect(await creditos(client.token)).toEqual({ credits: 100, creditsPending: 0 });
    expect(await creditos(freelancer.token)).toEqual({ credits: 100, creditsPending: 0 });
    expect(await reais(client.token)).toEqual({ balance: 0, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 0, balancePending: 0 });
    expect(await avisoDe(freelancer.token, 'contract_cancelled', id)).toMatchObject({
      title: 'Contratação cancelada pelo cliente: Aula de violão',
      body: 'Os 40 créditos em garantia voltaram ao cliente.',
    });
  });

  it('a desistência do freelancer em créditos também devolve tudo ao cliente', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await creditos(client.token);
    await creditos(freelancer.token);
    const id = await propor(client, freelancer, {
      title: 'Revisão de currículo',
      price: 30,
      paymentMode: 'credits',
    });
    await aceitar(id, freelancer);
    expect(await creditos(client.token)).toEqual({ credits: 70, creditsPending: 0 });
    expect(await creditos(freelancer.token)).toEqual({ credits: 100, creditsPending: 30 });

    const res = await cancelar(id, freelancer.token, { expectedRefund: 30 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      status: 'cancelled',
      stage: 'withdrawal',
      by: 'freelancer',
      refundPercentage: 100,
      refundClient: 30,
      releaseFreelancer: 0,
      unit: 'credits',
    });
    expect(await creditos(client.token)).toEqual({ credits: 100, creditsPending: 0 });
    expect(await creditos(freelancer.token)).toEqual({ credits: 100, creditsPending: 0 });
    expect(await avisoDe(client.token, 'contract_cancelled', id)).toMatchObject({
      title: 'O freelancer desistiu: Revisão de currículo',
      body: 'Os 30 créditos voltaram para a sua carteira.',
    });
  });
});

describe('O valor visto é o valor liquidado', () => {
  it('expectedRefund diferente do atual: 409 cancel_quote_changed e nada se move; igual: 200', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Fotos do cardápio',
      deadlineAt: isoFromNow(5 * DAY),
    });
    await aceiteEPrazo(id, fromNow(-9 * DAY), fromNow(11 * DAY));
    const tela = await cotacao(id, client.token);
    expect(tela).toMatchObject({ stage: 'early', refundClient: 100 });

    // Com a tela aberta, o tempo passa da metade: o reembolso agora é 0.
    await aceiteEPrazo(id, fromNow(-18 * DAY), fromNow(2 * DAY));
    const antes = await carteiras(client, freelancer);
    const res = await cancelar(id, client.token, { expectedRefund: tela.refundClient });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toEqual({
      error: 'cancel_quote_changed',
      message: 'O valor do cancelamento mudou desde que você abriu: confira de novo.',
    });
    expect(await carteiras(client, freelancer)).toEqual(antes);
    expect((await detalhe(id, client.token)).status).toBe('accepted');

    const nova = await cotacao(id, client.token);
    expect(nova).toMatchObject({ stage: 'late', refundClient: 0, releaseFreelancer: 170 });
    const ok = await cancelar(id, client.token, { expectedRefund: nova.refundClient });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ stage: 'late', refundClient: 0, releaseFreelancer: 170 });
    expect(await reais(client.token)).toEqual({ balance: 0, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 170, balancePending: 0 });
  });

  interface Etapa {
    nome: string;
    quem: 'client' | 'freelancer';
    /** Aceite e prazo em relação ao agora do fluxo (ms); null = sem prazo. */
    tempo: { aceite: number; prazo: number } | null;
    stage: string;
    refundClient: number;
    releaseFreelancer: number;
  }
  const ETAPAS: Etapa[] = [
    {
      nome: 'sem prazo, 50%',
      quem: 'client',
      tempo: null,
      stage: 'no_deadline',
      refundClient: 100,
      releaseFreelancer: 85,
    },
    {
      nome: 'antes da metade, 50%',
      quem: 'client',
      tempo: { aceite: -9 * DAY, prazo: 11 * DAY },
      stage: 'early',
      refundClient: 100,
      releaseFreelancer: 85,
    },
    {
      nome: 'depois da metade, 0%',
      quem: 'client',
      tempo: { aceite: -18 * DAY, prazo: 2 * DAY },
      stage: 'late',
      refundClient: 0,
      releaseFreelancer: 170,
    },
    {
      nome: 'prazo vencido e a hora do aviso passada, 100%',
      quem: 'client',
      tempo: { aceite: -5 * DAY, prazo: -30 * HOUR },
      stage: 'overdue',
      refundClient: 200,
      releaseFreelancer: 0,
    },
    {
      nome: 'desistência do freelancer depois da metade, 100% ao cliente',
      quem: 'freelancer',
      tempo: { aceite: -18 * DAY, prazo: 2 * DAY },
      stage: 'withdrawal',
      refundClient: 200,
      releaseFreelancer: 0,
    },
  ];

  it.each(ETAPAS)('o "cancellation" do GET é o que o POST liquida: $nome', async (e) => {
    const { client, freelancer, id } = await contratado({
      title: `Cotação: ${e.nome}`,
      deadlineAt: e.tempo ? isoFromNow(5 * DAY) : null,
    });
    if (e.tempo) await aceiteEPrazo(id, fromNow(e.tempo.aceite), fromNow(e.tempo.prazo));

    const doCliente = await cotacao(id, client.token);
    const doFreelancer = await cotacao(id, freelancer.token);
    expect(doCliente.by).toBe('client');
    // Quem entrega vê a própria desistência: tudo ao cliente, em qualquer etapa.
    expect(doFreelancer).toMatchObject({
      allowed: true,
      by: 'freelancer',
      stage: 'withdrawal',
      refundPercentage: 100,
      refundClient: 200,
      releaseFreelancer: 0,
      unit: 'BRL',
    });
    const vista = e.quem === 'client' ? doCliente : doFreelancer;
    expect(vista).toMatchObject({
      allowed: true,
      stage: e.stage,
      refundClient: e.refundClient,
      releaseFreelancer: e.releaseFreelancer,
    });

    const quem = e.quem === 'client' ? client : freelancer;
    const res = await cancelar(id, quem.token, { expectedRefund: vista.refundClient });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      status: 'cancelled',
      by: e.quem,
      stage: vista.stage,
      refundPercentage: vista.refundPercentage,
      refundClient: vista.refundClient,
      releaseFreelancer: vista.releaseFreelancer,
      unit: vista.unit,
    });
    expect(await reais(client.token)).toEqual({ balance: vista.refundClient, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({
      balance: vista.releaseFreelancer,
      balancePending: 0,
    });
  });
});

describe('Corrida: a gravação repete a leitura (guarda no repositório)', () => {
  it('por marcos: marco entregue, e depois aprovado, entre a leitura e a gravação barram o cancelamento', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 1400);
    const id = await propor(client, freelancer, {
      title: 'Loja virtual em 3 etapas',
      price: 1000,
      milestones: MARCOS,
    });
    // Outra contratação do mesmo freelancer em garantia (líquido 340): o retido dele cobre o
    // movimento calculado com a leitura antiga, então só a guarda segura a gravação.
    const outra = await propor(client, freelancer, { title: 'Manutenção da loja', price: 400 });
    await aceitar(id, freelancer);
    await aceitar(outra, freelancer);
    const [m1, m2] = (await detalhe(id, client.token)).milestones;
    await entregarMarco(id, m1!.id, freelancer);
    await aprovarMarco(id, m1!.id, client);
    expect(await reais(freelancer.token)).toEqual({ balance: 283.33, balancePending: 906.67 });

    // O que o service lê: em andamento, 666,67 em garantia (líquido 566,67), sem prazo, 50%.
    const lido = (await contractsRepository.findById(id))!;
    expect(lido.status).toBe('in_progress');
    const escrow = await milestonesRepository.escrowRemaining(id);
    expect(escrow).toEqual({ price: 666.67, net: 566.67 });
    const terms = await cotacao(id, client.token);
    expect(terms).toMatchObject({
      stage: 'no_deadline',
      refundClient: 333.34,
      releaseFreelancer: 283.34,
    });
    const guarda = guardaDoCancelamento(lido, escrow);
    const gravar = () =>
      contractsRepository.transition(
        transicaoDoCancelamento(lido, client.id, terms, escrow!.net, guarda),
      );
    expect(await guardaVale(id, lido.status, guarda)).toBe(true);

    // No meio, o freelancer entrega o marco 2 (o status continua in_progress).
    await entregarMarco(id, m2!.id, freelancer);
    expect(await guardaVale(id, lido.status, guarda)).toBe(false);
    const antes1 = await carteiras(client, freelancer);
    expect(await gravar()).toBe(false);
    expect(await carteiras(client, freelancer)).toEqual(antes1);
    expect((await detalhe(id, client.token)).status).toBe('in_progress');

    // E o cliente aprova: nenhum marco em aberto, mas a garantia encolheu para 333,34.
    await aprovarMarco(id, m2!.id, client);
    expect(await reais(freelancer.token)).toEqual({ balance: 566.66, balancePending: 623.34 });
    expect(await guardaVale(id, lido.status, guarda)).toBe(false);
    const antes2 = await carteiras(client, freelancer);
    expect(await gravar()).toBe(false);
    expect(await carteiras(client, freelancer)).toEqual(antes2);
    const meio = await detalhe(id, client.token);
    expect(meio.status).toBe('in_progress');
    expect(meio.milestones.map((m) => m.status)).toEqual(['released', 'released', 'funded']);

    // Lido de novo, o cancelamento passa e liquida só o que sobrou (333,34 a 50%).
    const res = await cancelar(id, client.token, { expectedRefund: 166.67 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      stage: 'no_deadline',
      refundClient: 166.67,
      releaseFreelancer: 141.67,
    });
    expect(await reais(client.token)).toEqual({ balance: 166.67, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 708.33, balancePending: 340 });
  });

  it('extensão aceita entre a leitura e a gravação muda o prazo e barra o cancelamento', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Ensaio fotográfico',
      deadlineAt: isoFromNow(5 * DAY),
    });
    const pedido = await pedirExtensao(id, freelancer, isoFromNow(10 * DAY));
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(200);

    const lido = (await contractsRepository.findById(id))!;
    expect(lido.extension_status).toBe('pending');
    const terms = await cotacao(id, client.token);
    expect(terms).toMatchObject({ stage: 'early', refundClient: 100, releaseFreelancer: 85 });
    const guarda = guardaDoCancelamento(lido, null);
    expect(await guardaVale(id, lido.status, guarda)).toBe(true);

    // No meio (outra aba), o cliente aceita a extensão: o prazo muda, o status não.
    const aceita = await request(app)
      .post(`/api/contracts/${id}/extension/accept`)
      .set(auth(client.token));
    expect(aceita.status, JSON.stringify(aceita.body)).toBe(200);
    const atual = (await contractsRepository.findById(id))!;
    expect(atual.status).toBe(lido.status);
    expect(new Date(atual.deadline_at!).getTime()).toBeGreaterThan(
      new Date(lido.deadline_at!).getTime(),
    );
    expect(await guardaVale(id, lido.status, guarda)).toBe(false);
    // Só o prazo antigo já barra: com o pedido atualizado e o prazo lido antes, a guarda falha.
    const fresca = guardaDoCancelamento(atual, null);
    expect(await guardaVale(id, atual.status, fresca)).toBe(true);
    expect(
      await guardaVale(id, atual.status, {
        sql: fresca.sql,
        params: { ...fresca.params, gDeadline: guarda.params.gDeadline },
      }),
    ).toBe(false);

    const antes = await carteiras(client, freelancer);
    expect(
      await contractsRepository.transition(
        transicaoDoCancelamento(lido, client.id, terms, 170, guarda),
      ),
    ).toBe(false);
    expect(await carteiras(client, freelancer)).toEqual(antes);
    const d = await detalhe(id, client.token);
    expect(d.status).toBe('accepted');
    expect(d.extension?.status).toBe('accepted');

    // O mesmo valor (ainda antes da metade), mas lido de novo: agora passa.
    const res = await cancelar(id, client.token, { expectedRefund: 100 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ stage: 'early', refundClient: 100, releaseFreelancer: 85 });
    expect(await reais(client.token)).toEqual({ balance: 100, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 85, balancePending: 0 });
  });
});

describe('Corrida pelo service: a guarda é a que o cancelamento monta', () => {
  it('marco entregue enquanto o cancelamento calcula o valor: 409 conflict e nada se move', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 1000);
    const id = await propor(client, freelancer, {
      title: 'Site em 3 etapas (corrida)',
      price: 1000,
      milestones: MARCOS,
    });
    await aceitar(id, freelancer);
    // O marco 1 entregue e aprovado deixa a contratação em in_progress: a entrega do marco 2 no meio
    // não muda o status nem o escrow em aberto (entregue ainda está em garantia).
    const [m1, m2] = (await detalhe(id, client.token)).milestones;
    await entregarMarco(id, m1!.id, freelancer);
    await aprovarMarco(id, m1!.id, client);
    expect((await detalhe(id, client.token)).status).toBe('in_progress');
    const antes = await carteiras(client, freelancer);

    // O freelancer entrega o marco 2 exatamente entre a leitura do cancelamento (que viu nenhum
    // marco entregue em aberto) e a gravação: só a guarda do marco em aberto barra.
    const original = milestonesRepository.escrowRemaining.bind(milestonesRepository);
    const spy = vi
      .spyOn(milestonesRepository, 'escrowRemaining')
      .mockImplementationOnce(async (contractId: number) => {
        const r = await original(contractId);
        const ok = await milestonesRepository.deliver({
          contractId: id,
          milestoneId: m2!.id,
          changedBy: freelancer.id,
          message: 'Front-end entregue no meio do cancelamento',
          now: now(),
          approvalDueAt: fromNow(5 * DAY),
        });
        expect(ok).toBe(true);
        return r;
      });
    try {
      const res = await cancelar(id, client.token);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toBe('conflict');
    } finally {
      spy.mockRestore();
    }
    expect(await carteiras(client, freelancer)).toEqual(antes);
    const depois = await detalhe(id, client.token);
    expect(depois.status).toBe('in_progress');
    expect(depois.milestones[1]!.status).toBe('delivered');
    expect(depois.cancellation).toMatchObject({ allowed: false, code: 'milestone_open' });
  });
});

describe('Pedido de extensão pendente', () => {
  it('cancelar antes do prazo encerra o pedido pendente (closed, com a hora)', async () => {
    const { client, freelancer, id } = await contratado({
      title: 'Trilha sonora do vídeo',
      deadlineAt: isoFromNow(5 * DAY),
    });
    const pedido = await pedirExtensao(id, freelancer, isoFromNow(10 * DAY));
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(200);
    const d0 = await detalhe(id, client.token);
    expect(d0.extension).toMatchObject({ status: 'pending', resolvedAt: null, seq: 1 });
    expect(d0.deadline.state).toBe('paused');
    expect(d0.cancellation).toMatchObject({
      allowed: true,
      stage: 'early',
      refundClient: 100,
      releaseFreelancer: 85,
    });

    const antes = now();
    const res = await cancelar(id, client.token, { expectedRefund: 100 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const depois = now();
    expect(res.body).toMatchObject({ stage: 'early', refundClient: 100, releaseFreelancer: 85 });

    const d = await detalhe(id, client.token);
    expect(d.status).toBe('cancelled');
    expect(d.deadline.state).toBe('closed');
    expect(d.extension).toMatchObject({ status: 'closed', seq: 1 });
    // O DATETIME guarda o segundo arredondado: a hora fica entre o antes e o depois, com folga.
    const resolvido = new Date(d.extension!.resolvedAt!).getTime();
    expect(resolvido).toBeGreaterThanOrEqual(antes.getTime() - 2000);
    expect(resolvido).toBeLessThanOrEqual(depois.getTime() + 2000);
    expect(await reais(client.token)).toEqual({ balance: 100, balancePending: 0 });
    expect(await reais(freelancer.token)).toEqual({ balance: 85, balancePending: 0 });
  });
});
