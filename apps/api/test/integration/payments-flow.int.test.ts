import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runExpireDeposits } from '../../src/jobs/expire-deposits';
import { fundWallet } from './wallet.helpers';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const WEBHOOK_SECRET = 'segredo-do-webhook-de-integracao'; // vitest.integration.config.ts

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `int_pay_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

const wallet = async (token: string) =>
  (await request(app).get('/api/wallet').set(auth(token))).body as {
    balance: number;
    balancePending: number;
  };

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Pagamentos: depósito PIX, carteira pré-paga, reembolso e saques', () => {
  it('depósito: cobrança PIX pendente → simulação paga → saldo, extrato e notificação', async () => {
    const client = await registerAndLogin('client');

    const created = await request(app)
      .post('/api/wallet/deposits')
      .set(auth(client.token))
      .send({ amount: 250 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      amount: 250,
      status: 'pending',
      method: 'pix',
      gateway: 'simulado',
      canSimulate: true,
    });
    expect(created.body.pixCode).toMatch(/^000201.*5406250\.00.*6304[0-9A-F]{4}$/);
    expect(new Date(created.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const depositId = created.body.id as number;

    // Ainda nada na carteira; a cobrança aparece na lista.
    expect(await wallet(client.token)).toMatchObject({ balance: 0, balancePending: 0 });
    const list = await request(app).get('/api/wallet/deposits').set(auth(client.token));
    expect(list.body.items.map((d: { id: number }) => d.id)).toContain(depositId);

    // Outro usuário não enxerga nem paga o depósito alheio.
    const other = await registerAndLogin('client');
    await request(app).get(`/api/wallet/deposits/${depositId}`).set(auth(other.token)).expect(403);

    // Pagamento simulado (demo): saldo entra, extrato registra, cliente é notificado.
    const paid = await request(app)
      .post(`/api/wallet/deposits/${depositId}/simulate`)
      .set(auth(client.token));
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body).toMatchObject({ status: 'paid', pixCode: null, canSimulate: false });
    expect(paid.body.paidAt).not.toBeNull();
    expect(await wallet(client.token)).toMatchObject({ balance: 250, balancePending: 0 });

    const ledger = await request(app).get('/api/wallet/transactions').set(auth(client.token));
    expect(ledger.status).toBe(200);
    expect(ledger.body.items[0]).toMatchObject({
      reason: 'deposit',
      amount: 250,
      pendingDelta: 0,
      balanceAfter: 250,
      pendingAfter: 0,
      paymentId: depositId,
    });
    const notif = await request(app).get('/api/notifications').set(auth(client.token));
    expect(notif.body.items.some((n: { type: string }) => n.type === 'deposit_confirmed')).toBe(
      true,
    );

    // Pagar de novo não duplica saldo (idempotente).
    await request(app)
      .post(`/api/wallet/deposits/${depositId}/simulate`)
      .set(auth(client.token))
      .expect(409);
    expect(await wallet(client.token)).toMatchObject({ balance: 250 });

    // Validação: valor abaixo do mínimo.
    await request(app)
      .post('/api/wallet/deposits')
      .set(auth(client.token))
      .send({ amount: 5 })
      .expect(422);
  });

  it('webhook do gateway: exige o segredo, aplica uma vez e ignora a repetição', async () => {
    const client = await registerAndLogin('client');
    const created = await request(app)
      .post('/api/wallet/deposits')
      .set(auth(client.token))
      .send({ amount: 90 });
    const reference = created.body.reference as string;
    expect(reference.startsWith('sim_')).toBe(true);

    // Sem/errado o segredo → 401; cobrança desconhecida → 404.
    await request(app)
      .post('/api/payments/webhook')
      .send({ gatewayPaymentId: reference, status: 'paid' })
      .expect(401);
    await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', 'errado')
      .send({ gatewayPaymentId: reference, status: 'paid' })
      .expect(401);
    await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send({ gatewayPaymentId: 'sim_inexistente', status: 'paid' })
      .expect(404);

    // Evento válido credita; o mesmo evento repetido não credita de novo.
    const first = await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send({ event: 'payment.updated', gatewayPaymentId: reference, status: 'paid' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ ok: true, applied: true, status: 'paid' });
    const again = await request(app)
      .post('/api/payments/webhook')
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send({ gatewayPaymentId: reference, status: 'paid' });
    expect(again.body).toMatchObject({ ok: true, applied: false });
    expect(await wallet(client.token)).toMatchObject({ balance: 90 });
  });

  it('proposta em dinheiro exige saldo (402); a reserva volta se o freelancer recusar', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const body = {
      freelancerId: freelancer.id,
      title: 'Proposta sem saldo',
      description: 'Contratação do teste de carteira pré-paga',
      price: 100,
    };

    const broke = await request(app).post('/api/contracts').set(auth(client.token)).send(body);
    expect(broke.status).toBe(402);
    expect(broke.body.error).toBe('insufficient_balance');

    await fundWallet(app, client.token, 120);
    const created = await request(app).post('/api/contracts').set(auth(client.token)).send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await wallet(client.token)).toMatchObject({ balance: 20, balancePending: 100 });

    // Recusa: reserva devolvida integralmente; freelancer nunca viu o dinheiro.
    await request(app)
      .post(`/api/contracts/${created.body.id}/reject`)
      .set(auth(freelancer.token))
      .expect(200);
    expect(await wallet(client.token)).toMatchObject({ balance: 120, balancePending: 0 });
    expect(await wallet(freelancer.token)).toMatchObject({ balance: 0, balancePending: 0 });
    const ledger = await request(app).get('/api/wallet/transactions').set(auth(client.token));
    expect(ledger.body.items.map((t: { reason: string }) => t.reason)).toEqual([
      'refund',
      'hold',
      'deposit',
    ]);
    expect(ledger.body.items[1]).toMatchObject({
      amount: -100,
      pendingDelta: 100,
      contractId: created.body.id,
    });
  });

  it('saques: fila do admin, processar/concluir, falhar (estorno) e cancelar pelo titular', async () => {
    const freelancer = await registerAndLogin('freelancer');
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    await fundWallet(app, freelancer.token, 300);

    const ask = async (amount: number) => {
      const res = await request(app)
        .post('/api/withdrawals')
        .set(auth(freelancer.token))
        .send({ amount, method: 'pix', pixKey: `chave-${amount}@escambo.test` });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as number;
    };
    const w1 = await ask(100);
    const w2 = await ask(50);
    const w3 = await ask(80);
    expect(await wallet(freelancer.token)).toMatchObject({ balance: 70 });

    // Fila do admin mostra destino completo e titular; quem não é admin toma 403.
    await request(app).get('/api/admin/withdrawals').set(auth(freelancer.token)).expect(403);
    const queue = await request(app).get('/api/admin/withdrawals').set(auth(admin.token));
    expect(queue.status).toBe(200);
    const mine = queue.body.filter((w: { userId: number }) => w.userId === freelancer.id);
    expect(mine.map((w: { id: number }) => w.id)).toEqual([w1, w2, w3]); // mais antigos primeiro
    expect(mine[0]).toMatchObject({ status: 'requested', destination: 'chave-100@escambo.test' });
    const metrics = await request(app).get('/api/admin/metrics').set(auth(admin.token));
    expect(metrics.body.pendingWithdrawals).toBeGreaterThanOrEqual(3);
    expect(metrics.body.depositsTotal).toBeGreaterThanOrEqual(300);

    // w1: processar → concluir (com referência do banco); titular notificado.
    const proc = await request(app)
      .post(`/api/admin/withdrawals/${w1}/process`)
      .set(auth(admin.token));
    expect(proc.status, JSON.stringify(proc.body)).toBe(200);
    expect(proc.body.status).toBe('processing');
    await request(app)
      .post(`/api/admin/withdrawals/${w1}/process`)
      .set(auth(admin.token))
      .expect(409);
    const done = await request(app)
      .post(`/api/admin/withdrawals/${w1}/complete`)
      .set(auth(admin.token))
      .send({ gatewayRef: 'E2E0001' });
    expect(done.body).toMatchObject({ status: 'completed' });
    expect(done.body.processedAt).not.toBeNull();
    await request(app).post(`/api/admin/withdrawals/${w1}/fail`).set(auth(admin.token)).expect(409);

    // w2: falhou → valor volta para a carteira, com linha de estorno no extrato.
    const failed = await request(app)
      .post(`/api/admin/withdrawals/${w2}/fail`)
      .set(auth(admin.token))
      .send({ reason: 'Chave PIX inválida' });
    expect(failed.body).toMatchObject({ status: 'failed' });
    expect(await wallet(freelancer.token)).toMatchObject({ balance: 120 });

    // w3: o próprio titular cancela antes do processamento.
    await request(app).post(`/api/withdrawals/${w3}/cancel`).set(auth(admin.token)).expect(403);
    const cancelled = await request(app)
      .post(`/api/withdrawals/${w3}/cancel`)
      .set(auth(freelancer.token));
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    await request(app)
      .post(`/api/withdrawals/${w1}/cancel`)
      .set(auth(freelancer.token))
      .expect(409);
    expect(await wallet(freelancer.token)).toMatchObject({ balance: 200, balancePending: 0 });

    const ledger = await request(app).get('/api/wallet/transactions').set(auth(freelancer.token));
    expect(ledger.body.items.map((t: { reason: string }) => t.reason)).toEqual([
      'withdrawal_refund',
      'withdrawal_refund',
      'withdrawal',
      'withdrawal',
      'withdrawal',
      'deposit',
    ]);
    const notif = await request(app).get('/api/notifications').set(auth(freelancer.token));
    const types = notif.body.items.map((n: { type: string }) => n.type);
    expect(types).toContain('withdrawal_completed');
    expect(types).toContain('withdrawal_failed');

    // Lista do titular reflete os estados; visão completa só no admin.
    const listing = await request(app).get('/api/withdrawals').set(auth(freelancer.token));
    const byId = Object.fromEntries(
      listing.body.items.map((w: { id: number; status: string }) => [w.id, w.status]),
    );
    expect(byId).toMatchObject({ [w1]: 'completed', [w2]: 'failed', [w3]: 'cancelled' });
    const all = await request(app).get('/api/admin/withdrawals?status=all').set(auth(admin.token));
    expect(all.body.some((w: { id: number }) => w.id === w1)).toBe(true);
  });

  it('job: cobrança PIX vencida é cancelada e não pode mais ser paga', async () => {
    const client = await registerAndLogin('client');
    const created = await request(app)
      .post('/api/wallet/deposits')
      .set(auth(client.token))
      .send({ amount: 40 });
    const id = created.body.id as number;
    await pool.query(
      `UPDATE payments SET expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = :id`,
      { id },
    );

    const result = await runExpireDeposits();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const after = await request(app).get(`/api/wallet/deposits/${id}`).set(auth(client.token));
    expect(after.body).toMatchObject({ status: 'cancelled', canSimulate: false });
    await request(app)
      .post(`/api/wallet/deposits/${id}/simulate`)
      .set(auth(client.token))
      .expect(409);
    expect(await wallet(client.token)).toMatchObject({ balance: 0 });
  });
});
