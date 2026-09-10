import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
  refreshToken: string;
  email: string;
  password: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `int_mail_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  const reg = await request(app).post('/api/auth/register').send({ email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return {
    id: login.body.user.id,
    token: login.body.accessToken,
    refreshToken: login.body.refreshToken,
    email,
    password,
  };
}

interface Outbox {
  template: string;
  subject: string;
  text: string;
  status: string;
  provider: string;
}

/** Caixa de saída do usuário, lida por um admin (com espera curta: o envio é assíncrono). */
async function outbox(admin: Actor, userId: number, template: string): Promise<Outbox> {
  for (let i = 0; i < 30; i++) {
    const res = await request(app)
      .get(`/api/admin/emails?userId=${userId}&limit=20`)
      .set(auth(admin.token));
    expect(res.status).toBe(200);
    const found = (res.body as Outbox[]).find((e) => e.template === template);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`e-mail ${template} não chegou à caixa de saída`);
}

const tokenIn = (text: string): string => /token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('E-mail transacional, confirmação de e-mail e recuperação de senha', () => {
  it('cadastro gera o e-mail de confirmação; o link confirma; reenviar depois disso é 409', async () => {
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    const user = await registerAndLogin('client');

    const me0 = await request(app).get('/api/auth/me').set(auth(user.token));
    expect(me0.body.emailVerified).toBe(false);

    // Quem não é admin não lê a caixa de saída.
    await request(app).get('/api/admin/emails').set(auth(user.token)).expect(403);

    const mail = await outbox(admin, user.id, 'verify_email');
    expect(mail).toMatchObject({
      subject: 'Confirme seu e-mail no Escambo',
      status: 'sent',
      provider: 'simulated',
    });
    expect(mail.text).toContain('http://app.escambo.test/verificar-email?token=');
    const token = tokenIn(mail.text);
    expect(token.length).toBeGreaterThan(20);

    // Token errado → 400; certo → confirma (e o mesmo token não vale duas vezes).
    await request(app)
      .post('/api/auth/verify-email')
      .send({ token: 'x'.repeat(30) })
      .expect(400);
    const ok = await request(app).post('/api/auth/verify-email').send({ token });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ id: user.id, emailVerified: true });
    await request(app).post('/api/auth/verify-email').send({ token }).expect(400);

    const me1 = await request(app).get('/api/auth/me').set(auth(user.token));
    expect(me1.body.emailVerified).toBe(true);
    const [rows] = await pool.query<{ status: string }[] & unknown[]>(
      `SELECT status FROM users WHERE id = :id`,
      { id: user.id },
    );
    expect((rows as { status: string }[])[0]?.status).toBe('active');
    await request(app).post('/api/auth/resend-verification').set(auth(user.token)).expect(409);
  });

  it('esqueci minha senha: resposta igual para e-mail desconhecido; link de uso único troca a senha e derruba sessões', async () => {
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    const user = await registerAndLogin('freelancer');

    // E-mail desconhecido: 202 igual, e nada na caixa de saída.
    const unknown = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'ninguem@escambo.test' });
    expect(unknown.status).toBe(202);
    const before = (await request(app).get('/api/admin/emails?limit=200').set(auth(admin.token)))
      .body as { to: string; template: string }[];
    expect(before.some((e) => e.to === 'ninguem@escambo.test')).toBe(false);

    const asked = await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    expect(asked.status).toBe(202);
    const mail = await outbox(admin, user.id, 'password_reset');
    expect(mail.text).toContain('http://app.escambo.test/redefinir-senha?token=');
    const token = tokenIn(mail.text);

    // Senha fraca → 422; válida → 204; token não vale de novo.
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: '123' })
      .expect(422);
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'nova-senha-forte-456' })
      .expect(204);
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'outra-senha-789' })
      .expect(400);

    // Sessões antigas encerradas (refresh cai), senha antiga não entra, nova entra e o e-mail
    // ficou confirmado (quem redefine provou controlar o endereço).
    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: user.refreshToken })
      .expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'nova-senha-forte-456' });
    expect(login.status).toBe(200);
    expect(login.body.user.emailVerified).toBe(true);
  });

  it('notificação relevante também vai por e-mail com link para a tela; chat não', async () => {
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 100);
    const created = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: freelancer.id,
      title: 'Proposta com e-mail',
      description: 'Contratação do teste de e-mail transacional',
      price: 80,
    });
    expect(created.status).toBe(201);

    const mail = await outbox(admin, freelancer.id, 'notification');
    expect(mail.subject).toBe('Nova proposta de contratação');
    expect(mail.text).toContain(`http://app.escambo.test/contratos/${created.body.id}`);

    // Mensagem de chat gera notificação in-app, mas não e-mail.
    await request(app)
      .post(`/api/contracts/${created.body.id}/accept`)
      .set(auth(freelancer.token))
      .expect(200);
    await request(app)
      .post(`/api/messaging/contracts/${created.body.id}`)
      .set(auth(client.token))
      .send({ content: 'Oi!' })
      .expect(201);
    await new Promise((r) => setTimeout(r, 300));
    const all = (
      await request(app)
        .get(`/api/admin/emails?userId=${freelancer.id}&limit=50`)
        .set(auth(admin.token))
    ).body as { subject: string }[];
    expect(all.some((e) => /mensagem/i.test(e.subject))).toBe(false);
  });
});
