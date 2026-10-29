import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';
import { confirmEmail } from './mail.helpers';

/**
 * Chaves restantes de platform_settings ligadas (ADR 33): modo de manutenção, trocas on/off e
 * mínimos de saque e de serviço — cada uma com efeito imediato e restaurada ao fim.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  admin = false,
): Promise<{ id: number; token: string }> {
  const email = admin
    ? `toggles_admin_${Date.now()}_${seq++}@admin.escambo.test`
    : `toggles_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  await confirmEmail(app, login.body.user.id);
  return { id: login.body.user.id, token: login.body.accessToken };
}
const put = (token: string, key: string, value: unknown) =>
  request(app).put(`/api/admin/settings/${key}`).set(auth(token)).send({ value });

async function firstCategoryId(): Promise<number> {
  const cats = await request(app).get('/api/categories').expect(200);
  const list = (Array.isArray(cats.body) ? cats.body : cats.body.items) as { id: number }[];
  return list[0]!.id;
}

afterAll(async () => {
  await pool.end();
});

describe('Chaves restantes de platform_settings', () => {
  it('modo de manutenção: 503 para quem não é admin; health, login, públicos e painel seguem; admin passa', async () => {
    const admin = await registerAndLogin('client', true);
    const client = await registerAndLogin('client');
    try {
      await put(admin.token, 'maintenance_mode', true).expect(200);

      const blocked = await request(app).get('/api/services').set(auth(client.token));
      expect(blocked.status).toBe(503);
      expect(blocked.body.error).toBe('maintenance');
      expect(blocked.headers['retry-after']).toBe('120');
      expect((await request(app).get('/api/services')).status).toBe(503);

      await request(app).get('/api/health').expect(200);
      expect((await request(app).get('/api/settings/public')).body.maintenanceMode).toBe(true);
      await request(app).get('/api/admin/settings').set(auth(admin.token)).expect(200);
      await request(app).get('/api/services').set(auth(admin.token)).expect(200);
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'ninguem@escambo.test', password: 'x' })
        .expect(401); // rota aberta: responde o próprio 401, não 503
    } finally {
      await put(admin.token, 'maintenance_mode', false).expect(200);
    }
    await request(app).get('/api/services').set(auth(client.token)).expect(200);
    expect((await request(app).get('/api/settings/public')).body.maintenanceMode).toBe(false);
  });

  it('previsão de volta (RNF-010): a hora vai nos parâmetros públicos, no Retry-After e na mensagem', async () => {
    const admin = await registerAndLogin('client', true);
    try {
      await put(admin.token, 'maintenance_return_minutes', 45).expect(200);
      // Desligado, a previsão não aparece: ela é da manutenção.
      expect((await request(app).get('/api/settings/public')).body.maintenanceReturnAt).toBeNull();

      const before = Date.now();
      await put(admin.token, 'maintenance_mode', true).expect(200);
      const pub = (await request(app).get('/api/settings/public')).body;
      const at = Date.parse(pub.maintenanceReturnAt);
      // Contada da última mudança (o modo, agora), com a precisão de segundo do DATETIME.
      expect(at).toBeGreaterThanOrEqual(before - 1000 + 45 * 60_000);
      expect(at).toBeLessThanOrEqual(Date.now() + 45 * 60_000);

      const blocked = await request(app).get('/api/services').expect(503);
      expect(blocked.body.returnAt).toBe(pub.maintenanceReturnAt);
      const retry = Number(blocked.headers['retry-after']);
      expect(retry).toBeGreaterThan(44 * 60);
      expect(retry).toBeLessThanOrEqual(45 * 60);
      expect(blocked.body.message).toMatch(
        /^Estamos em manutenção\. Previsão de volta: \d{2}:\d{2}/,
      );

      await put(admin.token, 'maintenance_return_minutes', 0).expect(200);
      expect((await request(app).get('/api/settings/public')).body.maintenanceReturnAt).toBeNull();
      expect((await request(app).get('/api/services').expect(503)).headers['retry-after']).toBe(
        '120',
      );
    } finally {
      await put(admin.token, 'maintenance_mode', false).expect(200);
      await put(admin.token, 'maintenance_return_minutes', 0).expect(200);
    }
  });

  it('trocas desligadas: propor dá 403 barter_disabled; ligadas de novo, passa', async () => {
    const admin = await registerAndLogin('client', true);
    const a = await registerAndLogin('freelancer');
    const b = await registerAndLogin('freelancer');
    const categoryId = await firstCategoryId();
    const svc = async (who: { token: string }, title: string) =>
      (
        await request(app)
          .post('/api/services')
          .set(auth(who.token))
          .send({
            categoryId,
            title,
            description: 'Serviço para testar trocas on/off',
            priceType: 'fixed',
            price: 100,
          })
          .expect(201)
      ).body.id as number;
    const offered = await svc(a, 'Oferecido');
    const requested = await svc(b, 'Pedido');
    const body = {
      receiverId: b.id,
      offeredServiceId: offered,
      requestedServiceId: requested,
      estimatedValueOffered: 100,
      estimatedValueRequested: 100,
    };
    try {
      await put(admin.token, 'barter_enabled', false).expect(200);
      const denied = await request(app).post('/api/barters').set(auth(a.token)).send(body);
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe('barter_disabled');
      expect((await request(app).get('/api/settings/public')).body.barterEnabled).toBe(false);
    } finally {
      await put(admin.token, 'barter_enabled', true).expect(200);
    }
    await request(app).post('/api/barters').set(auth(a.token)).send(body).expect(201);
  });

  it('saque mínimo e preço mínimo de serviço vêm das settings (422 abaixo, com o valor vigente)', async () => {
    const admin = await registerAndLogin('client', true);
    const freelancer = await registerAndLogin('freelancer');
    const categoryId = await firstCategoryId();
    const create = (price: number) =>
      request(app).post('/api/services').set(auth(freelancer.token)).send({
        categoryId,
        title: 'Preço mínimo',
        description: 'Serviço para testar o preço mínimo',
        priceType: 'fixed',
        price,
      });
    try {
      await put(admin.token, 'min_service_price', 25).expect(200);
      const low = await create(15);
      expect(low.status).toBe(422);
      expect(low.body.error).toBe('price_below_minimum');
      expect(low.body.message).toContain('25,00');
      await create(25).expect(201);
      await create(500).expect(201);
    } finally {
      await put(admin.token, 'min_service_price', 10).expect(200);
    }

    await fundWallet(app, freelancer.token, 100);
    try {
      await put(admin.token, 'min_withdrawal_amount', 50).expect(200);
      const low = await request(app)
        .post('/api/withdrawals')
        .set(auth(freelancer.token))
        .send({ amount: 30, method: 'pix', pixKey: 'chave@pix' });
      expect(low.status).toBe(422);
      expect(low.body.error).toBe('below_minimum');
      expect(low.body.message).toContain('50,00');
      expect((await request(app).get('/api/settings/public')).body.minWithdrawalAmount).toBe(50);
    } finally {
      await put(admin.token, 'min_withdrawal_amount', 20).expect(200);
    }
  });
});
