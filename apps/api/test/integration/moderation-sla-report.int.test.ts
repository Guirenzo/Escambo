import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runModerationSlaReport } from '../../src/jobs/moderation-sla-report';
import { dayKey, startOfTodayBrt } from '../../src/modules/reports/moderation.day';
import { parseState, REPORT_STATE_KEY } from '../../src/modules/reports/moderation.sla-state';
import { settingsRepository } from '../../src/modules/settings/settings.repository';
import { fundWallet } from './wallet.helpers';

/**
 * Relatório diário da meta da moderação (ADR 55) contra o MySQL real, com o provedor simulado
 * (a caixa de saída é a entrega). Uma denúncia esperando há três dias estoura a meta de 24 h: o
 * job manda um e-mail por admin que consegue entrar, só com agregados, grava a marca do dia e não
 * repete; a chave desliga; antes da hora não roda; o painel mostra a última conferência. A trava
 * do dia é testada contra o banco de verdade, com duas gravações ao mesmo tempo.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const HOUR = 3_600_000;

interface Actor {
  id: number;
  email: string;
  token: string;
}

let seq = 0;
async function actor(role: 'client' | 'freelancer', domain = 'escambo.test'): Promise<Actor> {
  const email = `int_sla_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, email, token: login.body.accessToken };
}

interface Outbox {
  template: string;
  subject: string;
  text: string;
  status: string;
}
async function outbox(admin: Actor, userId: number): Promise<Outbox[]> {
  const res = await request(app)
    .get(`/api/admin/emails?userId=${userId}&limit=50`)
    .set(auth(admin.token))
    .expect(200);
  return res.body as Outbox[];
}
const reports = async (admin: Actor, userId: number): Promise<Outbox[]> =>
  (await outbox(admin, userId)).filter((m) => m.template === 'moderation_report');

/**
 * Meio-dia de hoje em Brasília (15:00Z do dia de Brasília): já passou de DIGEST_HOUR. É o relógio
 * do teste inteiro — a denúncia é envelhecida a partir dele, não do NOW() do banco, para o teste
 * dar o mesmo resultado a qualquer hora em que rodar.
 */
const noonBrt = (): Date => new Date(startOfTodayBrt(new Date()).getTime() + 12 * HOUR);

const setSetting = (admin: Actor, key: string, value: number | boolean) =>
  request(app).put(`/api/admin/settings/${key}`).set(auth(admin.token)).send({ value }).expect(200);

afterAll(async () => {
  await pool.query(`DELETE FROM platform_settings WHERE key_name = :key`, {
    key: REPORT_STATE_KEY,
  });
  await pool.end();
});

describe('Relatório diário da meta da moderação (ADR 55)', () => {
  it('a trava do dia é um compare-and-set de verdade: com a chave ausente, só uma gravação ganha', async () => {
    const key = `int_setif_${Date.now()}`;
    try {
      // Duas instâncias ao mesmo tempo, as duas lendo "não existe": exatamente uma ganha.
      const race = await Promise.all([
        settingsRepository.setIf(key, 'a', null),
        settingsRepository.setIf(key, 'b', null),
      ]);
      expect(race.filter(Boolean)).toHaveLength(1);
      const won = (await settingsRepository.get(key))!;
      expect(['a', 'b']).toContain(won);
      // Chegou depois: perde, e o valor não muda.
      expect(await settingsRepository.setIf(key, 'c', null)).toBe(false);
      expect(await settingsRepository.get(key)).toBe(won);
      // Com a chave existente, só grava quem sabe o valor atual.
      expect(await settingsRepository.setIf(key, 'c', 'errado')).toBe(false);
      expect(await settingsRepository.setIf(key, 'c', won)).toBe(true);
      expect(await settingsRepository.get(key)).toBe('c');
      const [cas1, cas2] = await Promise.all([
        settingsRepository.setIf(key, 'd', 'c'),
        settingsRepository.setIf(key, 'e', 'c'),
      ]);
      expect([cas1, cas2].filter(Boolean)).toHaveLength(1);
    } finally {
      await pool.query(`DELETE FROM platform_settings WHERE key_name = :key`, { key });
    }
  });

  it('meta estourada: um e-mail por admin ativo, só agregados, uma vez por dia; chave e hora respeitadas', async () => {
    const admin = await actor('client', 'admin.escambo.test');
    // Dois admins que não conseguem entrar: suspenso e excluído não recebem.
    const suspended = await actor('client', 'admin.escambo.test');
    const deleted = await actor('client', 'admin.escambo.test');
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = :id`, { id: suspended.id });
    const client = await actor('client');
    const freelancer = await actor('freelancer');
    await fundWallet(app, client.token, 200);
    const contract = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: freelancer.id,
      title: 'Logo da padaria',
      description: 'Contratação do teste do relatório da moderação',
      price: 80,
    });
    expect(contract.status, JSON.stringify(contract.body)).toBe(201);
    const sent = await request(app)
      .post(`/api/messaging/contracts/${contract.body.id}`)
      .set(auth(freelancer.token))
      .send({ content: 'Me paga no pix por fora: (47) 99999-0002' });
    expect([200, 201], JSON.stringify(sent.body)).toContain(sent.status);
    await pool.query(`UPDATE users SET deleted_at = NOW() WHERE id = :id`, { id: deleted.id });

    const now = noonBrt();
    // A sinalização automática espera há três dias no relógio do teste.
    await pool.query(
      `UPDATE content_reports SET created_at = :at WHERE target_type = 'message' AND target_id = :id`,
      { id: sent.body.id, at: new Date(now.getTime() - 72 * HOUR) },
    );
    await pool.query(`DELETE FROM platform_settings WHERE key_name = :key`, {
      key: REPORT_STATE_KEY,
    });
    await setSetting(admin, 'moderation_sla_hours', 24);

    try {
      const first = await runModerationSlaReport(now);
      expect(first.skipped).toBeNull();
      expect(first.breached).toBe(true);
      expect(first.waiting).toBe(true);
      expect(first.recipients).toBeGreaterThanOrEqual(1);
      expect(first.delivered).toBe(first.recipients);
      expect(first.attempts).toBe(1);
      expect(first.provider).toBe('simulated');

      const mails = await reports(admin, admin.id);
      expect(mails).toHaveLength(1);
      const mail = mails[0]!;
      expect(mail.status).toBe('sent');
      expect(mail.subject).toMatch(/^Moderação: .*meta de 24 h/);
      expect(mail.text).toMatch(/pass(ou|aram) da meta/);
      expect(mail.text).toContain('/admin#health-title');
      expect(mail.text).toContain('Parâmetros da plataforma');
      // Só agregados: nem quem denunciou, nem quem foi denunciado, nem o texto da mensagem.
      expect(mail.text).not.toContain(freelancer.email);
      expect(mail.text).not.toContain(client.email);
      expect(mail.text).not.toContain('99999-0002');
      // Quem não consegue entrar como admin não recebe.
      expect(await reports(admin, suspended.id)).toHaveLength(0);
      expect(await reports(admin, deleted.id)).toHaveLength(0);

      // A marca do dia ficou gravada, com as entregas, e o painel a mostra.
      const state = parseState(await settingsRepository.get(REPORT_STATE_KEY));
      expect(state).toMatchObject({
        day: dayKey(now),
        breached: true,
        slaHours: 24,
        recipients: first.recipients,
        delivered: first.recipients,
        attempts: 1,
      });
      const health = (
        await request(app)
          .get('/api/admin/moderation/health?days=7')
          .set(auth(admin.token))
          .expect(200)
      ).body as {
        queue: { overSlaPending: number };
        dailyReport: { enabled: boolean; hour: number; mailProvider: string; last: unknown };
      };
      expect(health.queue.overSlaPending).toBeGreaterThanOrEqual(1);
      expect(health.dailyReport).toMatchObject({
        enabled: true,
        hour: 8,
        mailProvider: 'simulated',
        last: expect.objectContaining({ day: dayKey(now), breached: true }),
      });

      // Mesmo dia, de novo: nada sai.
      const again = await runModerationSlaReport(new Date(now.getTime() + 2 * HOUR));
      expect(again.skipped).toBe('already_today');
      expect(await reports(admin, admin.id)).toHaveLength(1);

      // Dia seguinte: antes da hora não roda; com a chave desligada também não.
      const tomorrow = new Date(now.getTime() + 24 * HOUR);
      const earlyTomorrow = new Date(startOfTodayBrt(tomorrow).getTime() + 30 * 60_000); // 00:30
      expect((await runModerationSlaReport(earlyTomorrow)).skipped).toBe('before_hour');
      await setSetting(admin, 'moderation_sla_report_enabled', false);
      expect((await runModerationSlaReport(tomorrow)).skipped).toBe('disabled');
      await setSetting(admin, 'moderation_sla_report_enabled', true);

      // Meta folgada o bastante para toda denúncia envelhecida da suíte: o dia é conferido, sem
      // e-mail. (Outras suítes deixam denúncias de três dias no relógio real, que amanhã no relógio
      // do teste podem ter até ~110 h.)
      await setSetting(admin, 'moderation_sla_hours', 200);
      const calm = await runModerationSlaReport(tomorrow);
      expect(calm.skipped).toBeNull();
      expect(calm.waiting).toBe(false);
      expect(calm.delivered).toBe(0);
      expect(await reports(admin, admin.id)).toHaveLength(1);
    } finally {
      await setSetting(admin, 'moderation_sla_hours', 24);
      await setSetting(admin, 'moderation_sla_report_enabled', true);
    }
  });
});
