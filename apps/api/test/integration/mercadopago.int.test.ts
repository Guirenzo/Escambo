import { createHmac } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { setMercadoPagoFetchForTests } from '../../src/modules/payments/mercadopago';
import { confirmEmail } from './mail.helpers';

/**
 * Depósito pelo Mercado Pago (ADR 73) contra o MySQL real, com um Mercado Pago falso no lugar da
 * rede (o fetch do cliente é trocável): a cobrança vira a página do Checkout Pro, a simulação não a
 * paga, e o webhook assinado só credita depois de "consultar" o pagamento, aprovado, do nosso
 * depósito e no mesmo valor. Credita uma vez, grava a forma do pagamento e o histórico (RF-050).
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const SECRET = 'assinatura-secreta-do-mercadopago-de-integracao';
const TS = '1763200000000';
const saved = {
  gateway: env.PAYMENT_GATEWAY,
  token: env.MERCADOPAGO_ACCESS_TOKEN,
  secret: env.MERCADOPAGO_WEBHOOK_SECRET,
};

/** Os pagamentos que o Mercado Pago falso "conhece", pelo id. */
const payments = new Map<string, Record<string, unknown>>();
const preferences: Array<Record<string, unknown>> = [];

const fakeMercadoPago = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  expect(new Headers(init?.headers).get('authorization')).toBe(
    `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
  );
  if (init?.method === 'POST' && url.pathname === '/checkout/preferences') {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    preferences.push(body);
    const id = `pref-${preferences.length}`;
    return Response.json({
      id,
      init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${id}`,
      sandbox_init_point: `https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=${id}`,
    });
  }
  const m = /^\/v1\/payments\/(.+)$/.exec(url.pathname);
  if (init?.method === 'GET' && m) {
    const payment = payments.get(decodeURIComponent(m[1]!));
    return payment
      ? Response.json(payment)
      : Response.json({ message: 'Payment not found', status: 404 }, { status: 404 });
  }
  return Response.json({ message: 'rota desconhecida' }, { status: 400 });
}) as typeof fetch;

let seq = 0;
async function cliente(): Promise<string> {
  const email = `int_mp_${Date.now()}_${seq++}@escambo.test`;
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

const saldo = async (token: string): Promise<number> =>
  (await request(app).get('/api/wallet').set(auth(token))).body.balance as number;

/** O aviso como o Mercado Pago manda: id na query e no corpo, assinado com a chave secreta. */
function aviso(paymentId: string, secret = SECRET) {
  const v1 = createHmac('sha256', secret)
    .update(`id:${paymentId};request-id:req-${paymentId};ts:${TS};`)
    .digest('hex');
  return request(app)
    .post(`/api/payments/webhook/mercadopago?data.id=${paymentId}&type=payment`)
    .set('x-signature', `ts=${TS},v1=${v1}`)
    .set('x-request-id', `req-${paymentId}`)
    .send({ action: 'payment.updated', type: 'payment', data: { id: paymentId } });
}

async function deposito(token: string, amount: number) {
  const res = await request(app).post('/api/wallet/deposits').set(auth(token)).send({ amount });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; reference: string; checkoutUrl: string; method: string | null };
}

const linha = async (id: number) =>
  (
    await pool.query<RowDataPacket[]>(
      'SELECT status, method, gateway, gateway_payment_id FROM payments WHERE id = :id',
      { id },
    )
  )[0][0]!;

const historico = async (id: number) =>
  (
    await pool.query<RowDataPacket[]>(
      'SELECT source, status, outcome, payload FROM payment_events WHERE payment_id = :id ORDER BY id',
      { id },
    )
  )[0];

beforeAll(async () => {
  expect((await request(app).get('/api/health')).status).toBe(200);
});

beforeEach(() => {
  env.PAYMENT_GATEWAY = 'mercadopago';
  env.MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-token-de-teste-da-integracao';
  env.MERCADOPAGO_WEBHOOK_SECRET = SECRET;
  setMercadoPagoFetchForTests(fakeMercadoPago);
});

afterEach(() => {
  env.PAYMENT_GATEWAY = saved.gateway;
  env.MERCADOPAGO_ACCESS_TOKEN = saved.token;
  env.MERCADOPAGO_WEBHOOK_SECRET = saved.secret;
  setMercadoPagoFetchForTests(null);
});

afterAll(async () => {
  await pool.end();
});

describe('depósito pelo Mercado Pago (ADR 73)', () => {
  it('cobrança no Checkout Pro, aviso aprovado credita uma vez com a forma do pagamento', async () => {
    const token = await cliente();
    const dep = await deposito(token, 90);

    // Sempre o init_point, mesmo em sandbox (o sandbox_init_point quebra com o vendedor de teste).
    expect(dep.checkoutUrl).toMatch(/^https:\/\/www\.mercadopago\.com\.br\//);
    expect(dep.method).toBeNull();
    const pref = preferences.at(-1)!;
    expect(pref).toMatchObject({
      external_reference: dep.reference,
      notification_url:
        'http://app.escambo.test/api/payments/webhook/mercadopago?source_news=webhooks',
    });
    expect(await linha(dep.id)).toMatchObject({
      status: 'pending',
      gateway: 'mercadopago',
      gateway_payment_id: dep.reference,
    });

    // A simulação nunca paga a cobrança do Mercado Pago, mesmo com PAYMENTS_SIMULATE ligado.
    const sim = await request(app).post(`/api/wallet/deposits/${dep.id}/simulate`).set(auth(token));
    expect(sim.status).toBe(409);
    expect(sim.body.error).toBe('deposit_not_simulated');
    // Nem o webhook do gateway simulado, que procura pela mesma referência.
    await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', 'segredo-do-webhook-de-integracao')
      .send({ gatewayPaymentId: dep.reference, status: 'paid' })
      .expect(404);

    // Aviso sem a assinatura certa não chega a consultar nada.
    payments.set('5001', {
      id: 5001,
      status: 'approved',
      external_reference: dep.reference,
      transaction_amount: 90,
      currency_id: 'BRL',
      payment_type_id: 'credit_card',
      payer: { email: 'comprador@teste.test' },
    });
    await aviso('5001', 'outra-chave').expect(401);
    expect(await saldo(token)).toBe(0);

    const ok = await aviso('5001').expect(200);
    expect(ok.body).toEqual({ ok: true, outcome: 'applied' });
    expect(await saldo(token)).toBe(90);
    expect(await linha(dep.id)).toMatchObject({ status: 'paid', method: 'credit_card' });

    // Repetido (o Mercado Pago reenvia): 200, sem crédito de novo.
    expect((await aviso('5001').expect(200)).body.outcome).toBe('ignored');
    expect(await saldo(token)).toBe(90);

    const got = await request(app).get(`/api/wallet/deposits/${dep.id}`).set(auth(token));
    expect(got.body).toMatchObject({ status: 'paid', method: 'credit_card', checkoutUrl: null });

    const eventos = await historico(dep.id);
    expect(eventos.map((e) => [e.source, e.outcome])).toEqual([
      ['charge', 'created'],
      ['webhook', 'applied'],
      ['webhook', 'ignored'],
    ]);
    // O comprador não fica no histórico.
    expect(JSON.stringify(eventos)).not.toContain('comprador@teste.test');
  });

  it('recusado e valor diferente não creditam; pagamento desconhecido responde 200', async () => {
    const token = await cliente();
    const dep = await deposito(token, 40);
    const base = {
      external_reference: dep.reference,
      transaction_amount: 40,
      currency_id: 'BRL',
      payment_type_id: 'credit_card',
    };
    payments.set('6001', { ...base, id: 6001, status: 'rejected' });
    payments.set('6002', { ...base, id: 6002, status: 'approved', transaction_amount: 4 });

    expect((await aviso('6001').expect(200)).body.outcome).toBe('ignored');
    expect((await aviso('6002').expect(200)).body.outcome).toBe('mismatch');
    expect((await aviso('6999').expect(200)).body.outcome).toBe('not_found');
    expect(await saldo(token)).toBe(0);
    expect(await linha(dep.id)).toMatchObject({ status: 'pending' });

    // A pessoa tenta de novo na mesma página e o boleto é aprovado: aí credita.
    payments.set('6003', { ...base, id: 6003, status: 'approved', payment_type_id: 'ticket' });
    expect((await aviso('6003').expect(200)).body.outcome).toBe('applied');
    expect(await saldo(token)).toBe(40);
    expect(await linha(dep.id)).toMatchObject({ status: 'paid', method: 'boleto' });
  });

  it('boleto compensado depois de o job cancelar o depósito vencido ainda credita', async () => {
    const token = await cliente();
    const dep = await deposito(token, 25);
    await pool.query('UPDATE payments SET expires_at = NOW() - INTERVAL 1 HOUR WHERE id = :id', {
      id: dep.id,
    });
    // O job de vencimento (paymentsRepository.expirePending) já passou: a cobrança está cancelada.
    await pool.query(
      `UPDATE payments SET status = 'cancelled'
        WHERE id = :id AND status = 'pending' AND expires_at < NOW()`,
      { id: dep.id },
    );
    expect(await linha(dep.id)).toMatchObject({ status: 'cancelled' });

    payments.set('7001', {
      id: 7001,
      status: 'approved',
      external_reference: dep.reference,
      transaction_amount: 25,
      currency_id: 'BRL',
      payment_type_id: 'ticket',
    });
    expect((await aviso('7001').expect(200)).body.outcome).toBe('applied');
    expect(await saldo(token)).toBe(25);
    expect(await linha(dep.id)).toMatchObject({ status: 'paid', method: 'boleto' });
  });

  it('com o Mercado Pago fora do ar, a cobrança não é criada (502) e nada fica gravado', async () => {
    const token = await cliente();
    setMercadoPagoFetchForTests((async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    const res = await request(app)
      .post('/api/wallet/deposits')
      .set(auth(token))
      .send({ amount: 10 });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('gateway_unavailable');
    const list = await request(app).get('/api/wallet/deposits').set(auth(token));
    expect(list.body.items).toEqual([]);
  });
});
