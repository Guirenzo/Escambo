import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runDailyDigest } from '../../src/jobs/daily-digest';
import { fundWallet } from './wallet.helpers';

/**
 * Preferência de e-mail e resumo diário contra o MySQL real (provedor simulado: a caixa de
 * saída é a entrega). O job recebe um "agora" ao meio-dia de Brasília para passar da hora.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `int_digest_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  await request(app).post('/api/auth/register').send({ email, password, role }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  return { id: login.body.user.id, token: login.body.accessToken };
}

interface Outbox {
  template: string;
  subject: string;
  text: string;
}
async function outbox(admin: Actor, userId: number): Promise<Outbox[]> {
  const res = await request(app)
    .get(`/api/admin/emails?userId=${userId}&limit=50`)
    .set(auth(admin.token));
  expect(res.status).toBe(200);
  return res.body as Outbox[];
}
const templates = (list: Outbox[]): string[] => list.map((m) => m.template);

/** Meio-dia de hoje em Brasília (15:00Z): já passou de DIGEST_HOUR. */
const noonBrt = (): Date => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0, 0));
};

async function propose(client: Actor, freelancer: Actor, title: string): Promise<void> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title,
      description: 'Contratação do teste de resumo diário',
      price: 50,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Preferência de e-mail e resumo diário (ADR 27)', () => {
  it('instant manda por evento; daily junta num resumo (um por dia); off não manda nada', async () => {
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    const client = await registerAndLogin('client');
    const daily = await registerAndLogin('freelancer');
    const off = await registerAndLogin('freelancer');
    const instant = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 300);

    // Preferência: padrão instant; validação; persistência.
    const def = await request(app).get('/api/notifications/preferences').set(auth(daily.token));
    expect(def.body).toEqual({ emailFrequency: 'instant' });
    await request(app)
      .put('/api/notifications/preferences')
      .set(auth(daily.token))
      .send({ emailFrequency: 'weekly' })
      .expect(422);
    await request(app)
      .put('/api/notifications/preferences')
      .set(auth(daily.token))
      .send({ emailFrequency: 'daily' })
      .expect(200);
    await request(app)
      .put('/api/notifications/preferences')
      .set(auth(off.token))
      .send({ emailFrequency: 'off' })
      .expect(200);
    const me = await request(app).get('/api/auth/me').set(auth(daily.token));
    expect(me.body.emailFrequency).toBe('daily');

    // Três propostas (contract_proposal é um tipo que vai por e-mail).
    await propose(client, daily, 'Proposta A');
    await propose(client, daily, 'Proposta B');
    await propose(client, off, 'Proposta C');
    await propose(client, instant, 'Proposta D');
    await new Promise((r) => setTimeout(r, 300)); // o e-mail por evento é assíncrono

    const beforeInstant = templates(await outbox(admin, instant.id));
    expect(beforeInstant.filter((t) => t === 'notification')).toHaveLength(1);
    expect(templates(await outbox(admin, daily.id))).not.toContain('notification');
    expect(templates(await outbox(admin, off.id))).not.toContain('notification');

    // Job: antes da hora não faz nada; ao meio-dia manda um resumo só para quem é daily.
    const dawn = new Date(noonBrt().getTime() - 10 * 3_600_000); // 02:00 em Brasília
    expect((await runDailyDigest(dawn)).skipped).toBe('before_hour');
    const first = await runDailyDigest(noonBrt());
    expect(first.sent).toContain(daily.id);
    expect(first.sent).not.toContain(off.id);
    expect(first.sent).not.toContain(instant.id);
    const digests = (await outbox(admin, daily.id)).filter((m) => m.template === 'digest');
    expect(digests).toHaveLength(1);
    expect(digests[0]!.subject).toBe('Seu resumo do dia: 2 novidades no Escambo');
    expect(digests[0]!.text).toContain('Proposta A');
    expect(digests[0]!.text).toContain('Proposta B');
    expect(templates(await outbox(admin, off.id))).not.toContain('digest');

    // Um por dia: rodar de novo não repete; nova notificação fica para o próximo resumo.
    await propose(client, daily, 'Proposta E');
    const again = await runDailyDigest(noonBrt());
    expect(again.sent).not.toContain(daily.id);
    expect((await outbox(admin, daily.id)).filter((m) => m.template === 'digest')).toHaveLength(1);
  });
});
