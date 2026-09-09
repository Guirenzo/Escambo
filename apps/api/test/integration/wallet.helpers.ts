import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';

/**
 * Carteira pré-paga: um cliente só consegue enviar proposta em dinheiro com saldo.
 * Deposita via cobrança PIX simulada (gateway simulado + PAYMENTS_SIMULATE).
 */
export async function fundWallet(app: Express, token: string, amount: number): Promise<void> {
  const auth = { Authorization: `Bearer ${token}` };
  const created = await request(app).post('/api/wallet/deposits').set(auth).send({ amount });
  expect(created.status, `depósito: ${JSON.stringify(created.body)}`).toBe(201);
  const paid = await request(app)
    .post(`/api/wallet/deposits/${created.body.id}/simulate`)
    .set(auth);
  expect(paid.status, `simular pagamento: ${JSON.stringify(paid.body)}`).toBe(200);
  expect(paid.body.status).toBe('paid');
}
