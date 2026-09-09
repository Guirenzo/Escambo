import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/**
 * Disputa e mediação: uma das partes abre a disputa numa contratação em andamento/entregue,
 * o contrato fica "disputed", a outra parte é notificada, e um admin (ADMIN_EMAILS) resolve
 * decidindo o escrow — aqui, divisão 50/50 — numa única transação. Ambos são notificados.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
  ulid: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `disp_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken, ulid: login.body.user.ulid };
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Disputas e mediação (admin)', () => {
  it('parte abre disputa → contrato em disputa → admin divide o escrow → partes notificadas', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const admin = await registerAndLogin('client', 'admin.escambo.test'); // ADMIN_EMAILS: @admin.escambo.test
    const stranger = await registerAndLogin('client');

    // Admin nasce admin (não é 403 no painel); quem não é admin toma 403.
    const metricsAsStranger = await request(app)
      .get('/api/admin/metrics')
      .set(auth(stranger.token));
    expect(metricsAsStranger.status).toBe(403);
    const metrics = await request(app).get('/api/admin/metrics').set(auth(admin.token));
    expect(metrics.status, JSON.stringify(metrics.body)).toBe(200);
    expect(metrics.body.users).toBeGreaterThan(0);

    // Contratação aceita e entregue: 200 → net 170 em escrow.
    const created = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: freelancer.id,
      title: 'Entrega contestada',
      description: 'Contratação do teste de disputa e mediação',
      price: 200,
    });
    expect(created.status).toBe(201);
    const contractId = created.body.id as number;
    expect(
      (await request(app).post(`/api/contracts/${contractId}/accept`).set(auth(freelancer.token)))
        .status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/api/contracts/${contractId}/deliver`)
          .set(auth(freelancer.token))
          .send({ message: 'Entregue.' })
      ).status,
    ).toBe(200);

    // Quem não participa não abre disputa; o cliente abre.
    const foreign = await request(app)
      .post('/api/disputes')
      .set(auth(stranger.token))
      .send({ contractId, reason: 'quality', description: 'Não sou parte disso.' });
    expect(foreign.status).toBe(403);
    const opened = await request(app)
      .post('/api/disputes')
      .set(auth(client.token))
      .send({
        contractId,
        reason: 'quality',
        description: 'A entrega não corresponde ao combinado.',
      });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body).toMatchObject({ contractId, reason: 'quality', status: 'open' });
    const disputeId = opened.body.id as number;

    // Contrato em disputa; segunda disputa não é permitida; a outra parte foi notificada.
    const detail = await request(app)
      .get(`/api/contracts/${contractId}`)
      .set(auth(freelancer.token));
    expect(detail.body.status).toBe('disputed');
    const again = await request(app)
      .post('/api/disputes')
      .set(auth(freelancer.token))
      .send({ contractId, reason: 'payment', description: 'Tentando abrir de novo.' });
    expect(again.status).toBe(409);
    const notif = await request(app).get('/api/notifications').set(auth(freelancer.token));
    expect(notif.body.items.some((n: { type: string }) => n.type === 'dispute_opened')).toBe(true);

    // Painel do admin lista a disputa aberta; resolve com divisão 50/50.
    const open = await request(app).get('/api/admin/disputes').set(auth(admin.token));
    expect(open.status).toBe(200);
    expect(open.body.some((d: { id: number }) => d.id === disputeId)).toBe(true);
    const resolved = await request(app)
      .post(`/api/admin/disputes/${disputeId}/resolve`)
      .set(auth(admin.token))
      .send({ resolution: 'partial_split', refundPercentage: 50, note: 'Meio a meio.' });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body).toMatchObject({
      status: 'resolved',
      resolution: 'partial_split',
      refundPercentage: 50,
    });

    // Escrow dividido: freelancer recebe 85 (50% de 170); contrato concluído; notificações.
    const wallet = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(wallet.body).toMatchObject({ balance: 85, balancePending: 0 });
    const after = await request(app).get(`/api/contracts/${contractId}`).set(auth(client.token));
    expect(after.body.status).toBe('completed');
    for (const actor of [client, freelancer]) {
      const list = await request(app).get('/api/notifications').set(auth(actor.token));
      expect(list.body.items.some((n: { type: string }) => n.type === 'dispute_resolved')).toBe(
        true,
      );
    }

    // Resolver de novo → 409; sumiu da lista de abertas.
    const twice = await request(app)
      .post(`/api/admin/disputes/${disputeId}/resolve`)
      .set(auth(admin.token))
      .send({ resolution: 'refund_client' });
    expect(twice.status).toBe(409);
    const openAfter = await request(app).get('/api/admin/disputes').set(auth(admin.token));
    expect(openAfter.body.some((d: { id: number }) => d.id === disputeId)).toBe(false);

    // Moderação: suspender e reativar um usuário pelo ulid.
    const susp = await request(app)
      .post(`/api/admin/users/${stranger.ulid}/suspend`)
      .set(auth(admin.token));
    expect(susp.status).toBeLessThan(300);
    const react = await request(app)
      .post(`/api/admin/users/${stranger.ulid}/reactivate`)
      .set(auth(admin.token));
    expect(react.status).toBeLessThan(300);
  });
});
