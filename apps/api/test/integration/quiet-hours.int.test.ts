import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runQuietPushSummary } from '../../src/jobs/quiet-push-summary';
import { notificationsService } from '../../src/modules/notifications/notifications.service';
import { hourIn } from '../../src/utils/timezone';

/**
 * "Não perturbe" (ADR 54) contra o MySQL real, com o provedor simulado: a janela na conta, o
 * CHECK do banco, o push retido dentro da janela, o contador do cartão, o resumo ao fim da janela
 * com a trava, e o desligar que descarta o retido. Junto, a auditoria de ligar o aparelho e o
 * navegador que não é mais gravado (migration 0025).
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const password = 'senha-integracao-123';
let seq = 0;

async function actor(): Promise<{ id: number; token: string }> {
  const email = `int_quiet_${Date.now()}_${seq++}@escambo.test`;
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

const device = (tag: string) => ({
  endpoint: `https://push.escambo.test/${tag}-${Date.now()}-${seq++}`,
  p256dh: 'BExemploDeChavePublicaDoAparelho1234567890',
  auth: 'segredoDoAparelho123',
});

const mod = (n: number): number => ((n % 24) + 24) % 24;

async function row<T>(sql: string, params: Record<string, unknown>): Promise<T | undefined> {
  const [rows] = await pool.query<(T & { length: number })[] & { length: number }>(sql, params);
  return (rows as unknown as T[])[0];
}

afterAll(async () => {
  await pool.end();
});

describe('Não perturbe (ADR 54)', () => {
  it('a janela mora na conta, sai na sessão, e o banco recusa meia janela', async () => {
    const dono = await actor();
    await request(app)
      .put('/api/notifications/preferences')
      .set(auth(dono.token))
      .send({ quietHours: { start: 22, end: 7 } })
      .expect(200)
      .expect((r) => expect(r.body.quietHours).toEqual({ start: 22, end: 7 }));
    const me = await request(app).get('/api/auth/me').set(auth(dono.token)).expect(200);
    expect(me.body.quietHours).toEqual({ start: 22, end: 7 });

    // Início igual ao fim não é janela; meia janela não passa nem por baixo da API.
    await request(app)
      .put('/api/notifications/preferences')
      .set(auth(dono.token))
      .send({ quietHours: { start: 7, end: 7 } })
      .expect(422);
    await expect(
      pool.query('UPDATE users SET push_quiet_start = 22, push_quiet_end = NULL WHERE id = :id', {
        id: dono.id,
      }),
    ).rejects.toThrow();
  });

  it('dentro da janela o push fica retido; ao fim, um resumo só; desligar descarta', async () => {
    const dono = await actor();
    const aparelho = device('noite');
    const subscribed = await request(app)
      .post('/api/notifications/push')
      .set(auth(dono.token))
      .set('user-agent', 'NavegadorDeTeste/1.0')
      .send(aparelho)
      .expect(201);
    expect(subscribed.body.devices).toBe(1);

    // O navegador do aparelho não é mais guardado (minimização); a trilha de ligar fica, só com o host.
    const sub = await row<{ user_agent: string | null }>(
      'SELECT user_agent FROM push_subscriptions WHERE endpoint = :endpoint',
      { endpoint: aparelho.endpoint },
    );
    expect(sub?.user_agent).toBeNull();
    await expect
      .poll(
        async () => {
          const audit = await row<{ new_value: unknown }>(
            `SELECT new_value FROM audit_logs WHERE user_id = :id AND action = 'push_subscribed'`,
            { id: dono.id },
          );
          // A coluna é JSON: o driver pode devolver objeto ou texto; o que importa é o host.
          return audit ? JSON.stringify(audit.new_value) : '';
        },
        { timeout: 5000 },
      )
      .toContain('push.escambo.test');

    // Janela que cobre o agora (h-1 até h+2, no fuso da conta: Brasília, sem escolha).
    const h = hourIn('America/Sao_Paulo', new Date());
    await request(app)
      .put('/api/notifications/preferences')
      .set(auth(dono.token))
      .send({ quietHours: { start: mod(h - 1), end: mod(h + 2) } })
      .expect(200);

    // Um aviso pushado chega: a notificação existe, mas o push não sai — fica retido.
    await notificationsService.notify(dono.id, {
      type: 'contract_proposal',
      title: 'Proposta de contratação',
      body: 'Alguém quer contratar você',
      data: { contractId: 1 },
    });
    await expect
      .poll(async () => {
        const n = await row<{ push_held_at: Date | null }>(
          'SELECT push_held_at FROM notifications WHERE user_id = :id ORDER BY id DESC LIMIT 1',
          { id: dono.id },
        );
        return n?.push_held_at != null;
      })
      .toBe(true);
    const lastSent = await row<{ last_sent_at: Date | null }>(
      'SELECT last_sent_at FROM push_subscriptions WHERE endpoint = :endpoint',
      { endpoint: aparelho.endpoint },
    );
    expect(lastSent?.last_sent_at).toBeNull();
    const status = await request(app).get('/api/notifications/push').set(auth(dono.token));
    expect(status.body.held).toBe(1);

    // Um segundo aviso, e a janela passa a NÃO cobrir o agora: o resumo sai, uma vez só.
    await notificationsService.notify(dono.id, {
      type: 'contract_accepted',
      title: 'Proposta aceita',
      data: { contractId: 2 },
    });
    await expect
      .poll(
        async () =>
          (await request(app).get('/api/notifications/push').set(auth(dono.token))).body.held,
      )
      .toBe(2);
    await request(app)
      .put('/api/notifications/preferences')
      .set(auth(dono.token))
      .send({ quietHours: { start: mod(h + 2), end: mod(h + 3) } })
      .expect(200);

    const first = await runQuietPushSummary(new Date());
    expect(first.sent).toContain(dono.id);
    const afterSummary = await row<{ last_sent_at: Date | null }>(
      'SELECT last_sent_at FROM push_subscriptions WHERE endpoint = :endpoint',
      { endpoint: aparelho.endpoint },
    );
    expect(afterSummary?.last_sent_at).not.toBeNull();
    const marca = await row<{ push_quiet_summary_id: number | null; max_id: number }>(
      `SELECT u.push_quiet_summary_id, (SELECT MAX(id) FROM notifications WHERE user_id = u.id) AS max_id
         FROM users u WHERE u.id = :id`,
      { id: dono.id },
    );
    expect(Number(marca?.push_quiet_summary_id)).toBe(Number(marca?.max_id));
    expect(
      (await request(app).get('/api/notifications/push').set(auth(dono.token))).body.held,
    ).toBe(0);

    // Rodar de novo não repete.
    const second = await runQuietPushSummary(new Date());
    expect(second.sent).not.toContain(dono.id);

    // Retido novo dentro da janela, e depois desligar: a marca avança e nada bate.
    await request(app)
      .put('/api/notifications/preferences')
      .set(auth(dono.token))
      .send({ quietHours: { start: mod(h - 1), end: mod(h + 2) } })
      .expect(200);
    await notificationsService.notify(dono.id, {
      type: 'contract_delivered',
      title: 'Entrega registrada',
      data: { contractId: 3 },
    });
    await expect
      .poll(
        async () =>
          (await request(app).get('/api/notifications/push').set(auth(dono.token))).body.held,
      )
      .toBe(1);
    await request(app)
      .put('/api/notifications/preferences')
      .set(auth(dono.token))
      .send({ quietHours: null })
      .expect(200)
      .expect((r) => expect(r.body.quietHours).toBeNull());
    expect(
      (await request(app).get('/api/notifications/push').set(auth(dono.token))).body.held,
    ).toBe(0);
    expect((await runQuietPushSummary(new Date())).sent).not.toContain(dono.id);
  });
});
