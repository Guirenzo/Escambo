import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { settingsService } from '../../src/modules/settings/settings.service';
import { setClockForTests } from '../../src/utils/clock';
import { withLegacyParallelContracts } from './helpers/legacy-parallel-contracts';
import { fundWallet } from './wallet.helpers';
import { confirmEmail } from './mail.helpers';

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
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  await confirmEmail(app, login.body.user.id);
  return { id: login.body.user.id, token: login.body.accessToken, email };
}

const put = (token: string, key: string, value: unknown) =>
  request(app).put(`/api/admin/settings/${key}`).set(auth(token)).send({ value });

afterAll(async () => {
  await pool.end();
});

describe('Parâmetros da plataforma', () => {
  it('admin lista os dezenove parâmetros com padrão, limites e sem autor; não-admin toma 403', async () => {
    const admin = await registerAndLogin('client', true);
    const res = await request(app).get('/api/admin/settings').set(auth(admin.token)).expect(200);
    expect(res.body.map((s: { key: string }) => s.key)).toEqual([
      'platform_fee_percentage',
      'tacit_approval_days',
      'proposal_expiry_hours',
      'counter_offer_response_hours',
      'extension_response_hours',
      'deadline_grace_hours',
      'attachment_retention_days',
      'appeal_window_days',
      'strike_window_days',
      'strike_upload_block_days',
      'strike_review_threshold',
      'moderation_sla_hours',
      'moderation_sla_report_enabled',
      'min_service_price',
      'min_withdrawal_amount',
      'withdrawal_pix_business_days',
      'withdrawal_bank_business_days',
      'barter_enabled',
      'maintenance_mode',
      'maintenance_return_minutes',
    ]);
    const fee = res.body.find((s: { key: string }) => s.key === 'platform_fee_percentage');
    expect(fee).toMatchObject({ value: 15, defaultValue: 15, min: 0, max: 50, unit: '%' });
    for (const key of ['counter_offer_response_hours', 'extension_response_hours']) {
      expect(res.body.find((s: { key: string }) => s.key === key)).toMatchObject({
        value: 48,
        defaultValue: 48,
        min: 24,
        max: 168,
        unit: 'horas',
        type: 'integer',
      });
    }

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
      // Preserva o snapshot da contratação histórica ainda aberta ao criar a comparação.
      const after = await withLegacyParallelContracts(client.id, freelancer.id, async () =>
        request(app).post('/api/contracts').set(auth(client.token)).send(body).expect(201),
      );
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

  it('prazos editáveis valem para novos snapshots; as regras fixas não têm rota de edição', async () => {
    const admin = await registerAndLogin('client', true);
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 1000);
    const base = new Date('2026-10-09T15:00:00Z');
    setClockForTests(base, { frozen: true });
    const deadlineAt = '2026-10-26T02:59:59.000Z';
    // Compara snapshots de duplicidades históricas pré-RN-020 sem encerrar os contratos antigos.
    const create = () =>
      withLegacyParallelContracts(client.id, freelancer.id, async () =>
        request(app)
          .post('/api/contracts')
          .set(auth(client.token))
          .send({
            freelancerId: freelancer.id,
            title: 'Snapshot de prazo do painel',
            description: 'Contrato fictício para preservar o prazo anunciado antes da mudança',
            price: 100,
            deadlineAt,
          })
          .expect(201),
      );
    const detail = (id: number) =>
      request(app).get(`/api/contracts/${id}`).set(auth(client.token)).expect(200);
    const counter = (id: number) =>
      request(app)
        .post(`/api/contracts/${id}/offers`)
        .set(auth(freelancer.token))
        .send({
          seq: 1,
          price: 110,
          deadlineAt,
          message: 'Ajuste de valor para esta entrega',
        })
        .expect(201);
    const extension = (id: number) =>
      request(app)
        .post(`/api/contracts/${id}/extension`)
        .set(auth(freelancer.token))
        .send({
          deadlineAt: '2026-10-31T02:59:59.000Z',
          reason: 'Mais tempo para executar a entrega combinada',
        })
        .expect(200);
    try {
      for (const key of ['counter_offer_response_hours', 'extension_response_hours']) {
        for (const value of [23, 169, 24.5, true]) await put(admin.token, key, value).expect(422);
        await put(admin.token, key, 24).expect(200);
        await put(admin.token, key, 168).expect(200);
      }
      await put(admin.token, 'counter_offer_response_hours', 96).expect(200);
      await put(admin.token, 'extension_response_hours', 72).expect(200);
      const pub = await request(app).get('/api/settings/public').expect(200);
      expect(pub.body).toMatchObject({ counterOfferResponseHours: 96, extensionResponseHours: 72 });
      expect(pub.body.fixedContractRules).toEqual({
        includedRevisions: 2,
        maxOffers: 5,
        disputeWaitHours: 48,
        disputeTacitMarginHours: 24,
        dropoutWindowDays: 60,
        dropoutAlertAt: 3,
        dropoutAgreementDays: 7,
      });
      for (const key of [
        'included_revisions',
        'max_offers',
        'dispute_wait_hours',
        'dropout_window_days',
        'dropout_alert_at',
        'dropout_agree_days',
      ]) {
        await put(admin.token, key, 1).expect(422);
      }

      const first = await create();
      const oldCounter = await counter(first.body.id);
      expect(oldCounter.body.negotiation.respondBy).toBe('2026-10-13T15:00:00.000Z');
      await request(app)
        .post(`/api/contracts/${first.body.id}/offers/2/accept`)
        .set(auth(client.token))
        .expect(200);
      const oldExtension = await extension(first.body.id);
      expect(oldExtension.body.extension.respondBy).toBe('2026-10-12T15:00:00.000Z');

      const pending = await create();
      await counter(pending.body.id);
      await put(admin.token, 'counter_offer_response_hours', 24).expect(200);
      await put(admin.token, 'extension_response_hours', 24).expect(200);
      expect((await detail(pending.body.id)).body.negotiation.respondBy).toBe(
        '2026-10-13T15:00:00.000Z',
      );
      expect((await detail(first.body.id)).body.extension.respondBy).toBe(
        '2026-10-12T15:00:00.000Z',
      );

      const latest = await create();
      const newCounter = await counter(latest.body.id);
      expect(newCounter.body.negotiation.respondBy).toBe('2026-10-10T15:00:00.000Z');
      await request(app)
        .post(`/api/contracts/${latest.body.id}/offers/2/accept`)
        .set(auth(client.token))
        .expect(200);
      expect((await extension(latest.body.id)).body.extension.respondBy).toBe(
        '2026-10-10T15:00:00.000Z',
      );

      // Um valor escrito fora do painel também precisa passar pela mesma política de leitura.
      for (const value of ['abc', '0', '23', '48.5', '169']) {
        await pool.query(
          `UPDATE platform_settings SET value = ?
           WHERE key_name IN ('counter_offer_response_hours', 'extension_response_hours')`,
          [value],
        );
        settingsService.clearCache();
        const safePublic = await request(app).get('/api/settings/public').expect(200);
        expect(safePublic.body).toMatchObject({
          counterOfferResponseHours: 48,
          extensionResponseHours: 48,
        });
        const safeAdmin = await request(app)
          .get('/api/admin/settings')
          .set(auth(admin.token))
          .expect(200);
        for (const key of ['counter_offer_response_hours', 'extension_response_hours']) {
          expect(safeAdmin.body.find((s: { key: string }) => s.key === key).value).toBe(48);
        }
      }
      const fallback = await create();
      expect((await counter(fallback.body.id)).body.negotiation.respondBy).toBe(
        '2026-10-11T15:00:00.000Z',
      );
      await request(app)
        .post(`/api/contracts/${fallback.body.id}/offers/2/accept`)
        .set(auth(client.token))
        .expect(200);
      expect((await extension(fallback.body.id)).body.extension.respondBy).toBe(
        '2026-10-11T15:00:00.000Z',
      );
    } finally {
      setClockForTests(null);
      await put(admin.token, 'counter_offer_response_hours', 48).expect(200);
      await put(admin.token, 'extension_response_hours', 48).expect(200);
    }
  });
});
