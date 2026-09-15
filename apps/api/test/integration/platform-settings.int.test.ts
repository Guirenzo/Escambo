import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';

/**
 * Parâmetros da plataforma (ADR 32): o admin lê e muda pelo painel, com limites e auditoria, e
 * a mudança vale na hora — a comissão de uma contratação nova segue o valor novo.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  admin = false,
): Promise<{ id: number; token: string; email: string }> {
  const email = admin
    ? `settings_admin_${Date.now()}_${seq++}@admin.escambo.test`
    : `settings_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app).post('/api/auth/register').send({ email, password, role }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken, email };
}

const put = (token: string, key: string, value: unknown) =>
  request(app).put(`/api/admin/settings/${key}`).set(auth(token)).send({ value });

afterAll(async () => {
  await pool.end();
});

describe('Parâmetros da plataforma', () => {
  it('admin lista os treze parâmetros com padrão, limites e sem autor; não-admin toma 403', async () => {
    const admin = await registerAndLogin('client', true);
    const res = await request(app).get('/api/admin/settings').set(auth(admin.token)).expect(200);
    expect(res.body.map((s: { key: string }) => s.key)).toEqual([
      'platform_fee_percentage',
      'tacit_approval_days',
      'proposal_expiry_hours',
      'deadline_grace_hours',
      'attachment_retention_days',
      'appeal_window_days',
      'strike_window_days',
      'strike_upload_block_days',
      'strike_review_threshold',
      'min_service_price',
      'min_withdrawal_amount',
      'barter_enabled',
      'maintenance_mode',
    ]);
    const fee = res.body.find((s: { key: string }) => s.key === 'platform_fee_percentage');
    expect(fee).toMatchObject({ value: 15, defaultValue: 15, min: 0, max: 50, unit: '%' });

    const someone = await registerAndLogin('client');
    await request(app).get('/api/admin/settings').set(auth(someone.token)).expect(403);
    await put(someone.token, 'tacit_approval_days', 3).expect(403);
  });

  it('valida limites e chave; grava com autor e auditoria; público reflete', async () => {
    const admin = await registerAndLogin('client', true);
    expect((await put(admin.token, 'platform_fee_percentage', 51)).status).toBe(422);
    expect((await put(admin.token, 'attachment_retention_days', 3)).status).toBe(422);
    expect((await put(admin.token, 'tacit_approval_days', 'x')).status).toBe(422);
    expect((await put(admin.token, 'maintenance_mode', 1)).status).toBe(422);

    try {
      const saved = await put(admin.token, 'tacit_approval_days', 3).expect(200);
      expect(saved.body).toMatchObject({
        key: 'tacit_approval_days',
        value: 3,
        updatedBy: admin.email,
      });
      expect(typeof saved.body.updatedAt).toBe('string');

      const pub = await request(app).get('/api/settings/public').expect(200);
      expect(pub.body).toMatchObject({ tacitApprovalDays: 3, platformFeePercentage: 15 });

      const [audit] = await pool.query(
        `SELECT action, new_value FROM audit_logs WHERE user_id = ? AND action = 'setting_updated' ORDER BY id DESC LIMIT 1`,
        [admin.id],
      );
      expect((audit as { action: string }[]).length).toBe(1);
    } finally {
      await put(admin.token, 'tacit_approval_days', 5).expect(200);
    }
  });

  it('comissão nova vale para a contratação seguinte e não mexe na anterior', async () => {
    const admin = await registerAndLogin('client', true);
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 800);
    const body = {
      freelancerId: freelancer.id,
      title: 'Comissão vigente',
      description: 'Contratação criada para conferir a comissão registrada',
      price: 400,
    };
    const before = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send(body)
      .expect(201);
    expect(before.body.platformFee).toBe(60); // 15%

    try {
      await put(admin.token, 'platform_fee_percentage', 10).expect(200);
      const after = await request(app)
        .post('/api/contracts')
        .set(auth(client.token))
        .send(body)
        .expect(201);
      expect(after.body.platformFee).toBe(40); // 10%
      expect(after.body.freelancerNet).toBe(360);
      const still = await request(app)
        .get(`/api/contracts/${before.body.id}`)
        .set(auth(client.token))
        .expect(200);
      expect(still.body.platformFee).toBe(60);
      expect((await request(app).get('/api/settings/public')).body.platformFeePercentage).toBe(10);
    } finally {
      await put(admin.token, 'platform_fee_percentage', 15).expect(200);
    }
  });
});
