import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { confirmEmail } from './mail.helpers';

/**
 * Resposta do gateway guardada para auditoria (RF-050) contra o MySQL real: a criação da cobrança
 * grava a resposta completa (em payments.gateway_response e na primeira linha do histórico), e cada
 * webhook recebido com o segredo certo ganha a sua linha, sem dado pessoal: o que liquida, o
 * repetido (o efeito continua idempotente), o atrasado, o de cobrança desconhecida e o de corpo
 * fora do formato. Webhook sem o segredo não é do gateway e não entra.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const WEBHOOK_SECRET = 'segredo-do-webhook-de-integracao'; // vitest.integration.config.ts

let seq = 0;
async function cliente(): Promise<string> {
  const email = `int_gw_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role: 'client' });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  await confirmEmail(app, login.body.user.id);
  return login.body.accessToken as string;
}

interface Evento {
  payment_id: number | null;
  gateway: string;
  gateway_payment_id: string | null;
  source: string;
  event: string | null;
  status: string | null;
  outcome: string;
  payload: unknown;
}

async function historico(where: string, params: Record<string, unknown>): Promise<Evento[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT payment_id, gateway, gateway_payment_id, source, event, status, outcome, payload
       FROM payment_events WHERE ${where} ORDER BY id`,
    params,
  );
  return rows as Evento[];
}

const webhook = (body: unknown, secret: string | null = WEBHOOK_SECRET) => {
  const req = request(app).post('/api/payments/webhook');
  return (secret === null ? req : req.set('x-webhook-secret', secret)).send(body as object);
};

const saldo = async (token: string): Promise<number> =>
  (await request(app).get('/api/wallet').set(auth(token))).body.balance as number;

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('histórico do gateway (RF-050)', () => {
  it('criação, webhook que liquida, repetido, atrasado, inválido e sem segredo', async () => {
    const token = await cliente();
    const created = await request(app)
      .post('/api/wallet/deposits')
      .set(auth(token))
      .send({ amount: 90 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as number;
    const ref = created.body.reference as string;

    // A resposta completa da criação fica na cobrança e abre o histórico.
    const [pay] = await pool.query<RowDataPacket[]>(
      'SELECT gateway_response FROM payments WHERE id = :id',
      { id },
    );
    const resposta = pay[0]!.gateway_response as Record<string, string>;
    expect(resposta).toEqual({
      externalId: ref,
      pixCode: created.body.pixCode,
      expiresAt: expect.any(String),
    });
    // A validade como o gateway respondeu (com milissegundos); a coluna da cobrança guarda o segundo.
    expect(
      Math.abs(Date.parse(resposta.expiresAt!) - Date.parse(created.body.expiresAt)),
    ).toBeLessThan(1000);
    expect(await historico('payment_id = :id', { id })).toEqual([
      {
        payment_id: id,
        gateway: 'simulado',
        gateway_payment_id: ref,
        source: 'charge',
        event: null,
        status: 'pending',
        outcome: 'created',
        payload: resposta,
      },
    ]);

    // O webhook que liquida, com dados de quem pagou que o gateway mandaria: entram omitidos.
    const corpo = {
      event: 'payment.updated',
      gatewayPaymentId: ref,
      status: 'paid',
      paidAmount: 90,
      payer: { name: 'Maria da Silva', document: '123.456.789-00' },
      endToEndId: 'E00000000202610191500ABCDEF12345',
    };
    const first = await webhook(corpo).expect(200);
    expect(first.body).toMatchObject({ applied: true, status: 'paid' });
    // Repetido: não credita de novo, mas fica registrado.
    const again = await webhook(corpo).expect(200);
    expect(again.body).toMatchObject({ applied: false, status: 'paid' });
    // Aviso de falha atrasado: ignorado, registrado com o status que o gateway mandou.
    await webhook({ gatewayPaymentId: ref, status: 'failed' }).expect(200);
    // Corpo fora do formato com o segredo certo: 422, e o corpo fica, ligado à cobrança.
    await webhook({
      gatewayPaymentId: ref,
      status: 'estornado',
      customer: { email: 'm@x.test' },
    }).expect(422);
    // Sem o segredo (ou com o errado) não é o gateway: 401 e nada entra.
    await webhook(corpo, null).expect(401);
    await webhook(corpo, 'errado').expect(401);

    expect(await saldo(token)).toBe(90);
    const semDados = { ...corpo, payer: '[omitido]' };
    expect(await historico('payment_id = :id', { id })).toEqual([
      expect.objectContaining({ source: 'charge', outcome: 'created' }),
      {
        payment_id: id,
        gateway: 'simulado',
        gateway_payment_id: ref,
        source: 'webhook',
        event: 'payment.updated',
        status: 'paid',
        outcome: 'applied',
        payload: semDados,
      },
      expect.objectContaining({ status: 'paid', outcome: 'ignored', payload: semDados }),
      expect.objectContaining({
        event: null,
        status: 'failed',
        outcome: 'ignored',
        payload: { gatewayPaymentId: ref, status: 'failed' },
      }),
      expect.objectContaining({
        status: 'estornado',
        outcome: 'invalid',
        payload: { gatewayPaymentId: ref, status: 'estornado', customer: '[omitido]' },
      }),
    ]);
    // Nada sobrescreve a resposta da criação.
    const [depois] = await pool.query<RowDataPacket[]>(
      'SELECT gateway_response FROM payments WHERE id = :id',
      { id },
    );
    expect(depois[0]!.gateway_response).toEqual(resposta);
  });

  it('webhook de cobrança desconhecida: 404, e a linha fica sem cobrança, pelo id do gateway', async () => {
    const ref = `sim_desconhecida_${Date.now()}`;

    const res = await webhook({ gatewayPaymentId: ref, status: 'paid' }).expect(404);
    expect(res.body.error).toBe('payment_not_found');

    expect(await historico('gateway_payment_id = :ref', { ref })).toEqual([
      {
        payment_id: null,
        gateway: 'simulado',
        gateway_payment_id: ref,
        source: 'webhook',
        event: null,
        status: 'paid',
        outcome: 'not_found',
        payload: { gatewayPaymentId: ref, status: 'paid' },
      },
    ]);
  });

  it('a simulação da demo liquida no papel do gateway e também fica no histórico', async () => {
    const token = await cliente();
    const created = await request(app)
      .post('/api/wallet/deposits')
      .set(auth(token))
      .send({ amount: 40 });
    const id = created.body.id as number;

    await request(app).post(`/api/wallet/deposits/${id}/simulate`).set(auth(token)).expect(200);
    // A segunda simulação é recusada (409) e não é do gateway: não entra.
    await request(app).post(`/api/wallet/deposits/${id}/simulate`).set(auth(token)).expect(409);

    expect(
      (await historico('payment_id = :id', { id })).map((e) => [e.source, e.status, e.outcome]),
    ).toEqual([
      ['charge', 'pending', 'created'],
      ['simulation', 'paid', 'applied'],
    ]);
    expect(await saldo(token)).toBe(40);
  });
});
