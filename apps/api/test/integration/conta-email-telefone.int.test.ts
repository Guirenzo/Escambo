import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { hashToken } from '../../src/utils/tokens';

/**
 * Contato da conta contra o MySQL real (RF-017): a troca de e-mail pede a senha, só vale pelo link
 * enviado ao endereço novo (uso único, com validade), avisa o endereço antigo, derruba as outras
 * sessões, fica na auditoria e não revela se o endereço tem conta; admin não troca e ninguém vira
 * admin pela troca. O telefone é guardado em E.164, só o titular o vê e ele entra na cópia LGPD.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const PASSWORD = 'senha-integracao-123';
const RUN = Date.now();
let seq = 0;
const fresh = (domain = 'escambo.test'): string => `int_conta_${RUN}_${seq++}@${domain}`;

interface Session {
  id: number;
  ulid: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

async function register(
  email = fresh(),
  role: 'client' | 'freelancer' = 'client',
): Promise<string> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password: PASSWORD, role });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return email;
}

async function login(email: string, userAgent = 'vitest-integracao'): Promise<Session> {
  const res = await request(app)
    .post('/api/auth/login')
    .set('User-Agent', userAgent)
    .send({ email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    id: res.body.user.id,
    ulid: res.body.user.ulid,
    email,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
  };
}

/** O pedido de troca como a tela manda (o supertest, para encadear o .expect). */
function requestChange(s: Session, newEmail: string, currentPassword = PASSWORD): request.Test {
  return request(app)
    .post('/api/auth/change-email')
    .set(auth(s.accessToken))
    .set('User-Agent', 'navegador-do-notebook')
    .send({ currentPassword, newEmail });
}

interface OutboxRow extends RowDataPacket {
  to_email: string;
  subject: string;
  template: string;
  text_body: string;
  status: string;
}

/** E-mails da conta na caixa de saída (provedor simulado). O envio é em segundo plano: espera a entrega. */
async function outbox(userId: number, expected: number): Promise<OutboxRow[]> {
  let rows: OutboxRow[] = [];
  for (let i = 0; i < 40; i++) {
    [rows] = await pool.query<OutboxRow[]>(
      `SELECT to_email, subject, template, text_body, status FROM email_outbox
        WHERE user_id = :userId AND template IN ('email_change', 'notification') ORDER BY id`,
      { userId },
    );
    // Gravado como queued e marcado sent logo depois da entrega simulada.
    if (rows.length >= expected && rows.every((r) => r.status !== 'queued')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return rows;
}

const linkToken = (text: string): string =>
  /confirmar-novo-email\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';

/** O token do link que foi ao endereço novo. */
async function tokenSentTo(userId: number, newEmail: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const [rows] = await pool.query<OutboxRow[]>(
      `SELECT to_email, text_body FROM email_outbox
        WHERE user_id = :userId AND template = 'email_change' AND to_email = :newEmail
        ORDER BY id DESC LIMIT 1`,
      { userId, newEmail },
    );
    if (rows[0]) return linkToken(rows[0].text_body);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`link de troca para ${newEmail} não chegou à caixa de saída`);
}

async function userRow(id: number): Promise<RowDataPacket> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT email, email_verified_at, status, role, phone FROM users WHERE id = :id',
    { id },
  );
  return rows[0]!;
}

async function openSessions(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = :userId AND revoked_at IS NULL',
    { userId },
  );
  return Number(rows[0]!.n);
}

async function requests(userId: number): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, new_email, token, used_at, outcome FROM email_change_requests WHERE user_id = :userId ORDER BY id',
    { userId },
  );
  return rows;
}

/** A auditoria é gravada em segundo plano (melhor esforço): espera a linha aparecer. */
async function auditRows(userId: number, action: string, min = 1): Promise<RowDataPacket[]> {
  for (let i = 0; i < 40; i++) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT entity_type, entity_id, old_value, new_value, ip_address, user_agent
         FROM audit_logs WHERE user_id = :userId AND action = :action ORDER BY id`,
      { userId, action },
    );
    if (rows.length >= min) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

const contact = async (s: Session) =>
  (await request(app).get('/api/auth/contact').set(auth(s.accessToken)).expect(200)).body;

afterAll(async () => {
  await pool.end();
});

describe('troca de e-mail (RF-017)', () => {
  it('senha atual errada: 400 e nada é registrado nem enviado', async () => {
    const a = await login(await register());

    const res = await requestChange(a, fresh(), 'nao-e-a-senha').expect(400);

    expect(res.body).toEqual({ error: 'wrong_password', message: 'Senha atual incorreta' });
    expect(await requests(a.id)).toHaveLength(0);
    expect((await contact(a)).pendingEmail).toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(await outbox(a.id, 0)).toHaveLength(0);
  });

  it('pedido, aviso ao endereço antigo, confirmação pelo link: troca o e-mail, derruba as outras sessões e audita', async () => {
    const oldEmail = await register();
    const a = await login(oldEmail, 'navegador-do-notebook');
    const b = await login(oldEmail, 'navegador-do-celular');
    const newEmail = fresh();

    const res = await requestChange(a, newEmail).expect(202);
    expect(res.body).toEqual({ email: newEmail, expiresAt: expect.any(String) });
    // Validade de 24 horas (EMAIL_VERIFY_TTL_HOURS), e o GET devolve exatamente a mesma hora.
    const ttl = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(23.9 * 3_600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3_600_000);
    const pending = await contact(a);
    expect(pending).toEqual({
      email: oldEmail,
      emailVerified: false,
      phone: null,
      pendingEmail: { email: newEmail, expiresAt: res.body.expiresAt },
      // Como a conta entra (RF-002, 1.54.0): com senha e sem Google.
      hasPassword: true,
      googleLinked: false,
    });
    // Até a confirmação, nada muda: o login segue pelo endereço antigo.
    expect((await userRow(a.id)).email).toBe(oldEmail);

    // O link foi ao endereço novo; o banco só tem o hash do token.
    const token = await tokenSentTo(a.id, newEmail);
    expect(token).not.toBe('');
    const [saved] = await requests(a.id);
    expect(saved!.token).toBe(hashToken(token));
    expect(saved!.token).not.toContain(token);

    // O endereço antigo recebeu o aviso, com o endereço novo mascarado e o que fazer.
    const mails = await outbox(a.id, 2);
    const notice = mails.find((m) => m.template === 'notification' && m.to_email === oldEmail);
    expect(notice).toMatchObject({
      subject: 'Pedido para trocar o e-mail da sua conta',
      status: 'sent',
    });
    expect(notice!.text_body).toContain('Se não foi você');
    expect(notice!.text_body).toContain('http://app.escambo.test/esqueci-senha');
    expect(notice!.text_body).not.toContain(newEmail);
    const link = mails.find((m) => m.template === 'email_change');
    expect(link).toMatchObject({
      to_email: newEmail,
      subject: 'Confirme seu novo e-mail no Escambo',
    });
    expect(link!.text_body).toContain(
      `http://app.escambo.test/confirmar-novo-email?token=${token}`,
    );

    // Confirma na aba A (logada): ela ganha uma sessão nova; A e B antigas caem.
    expect(await openSessions(a.id)).toBe(2);
    const confirmed = await request(app)
      .post('/api/auth/confirm-email-change')
      .set(auth(a.accessToken))
      .set('User-Agent', 'navegador-do-notebook')
      .send({ token })
      .expect(200);
    expect(confirmed.body).toEqual({
      email: newEmail,
      session: { accessToken: expect.any(String), refreshToken: expect.any(String) },
    });
    expect(await openSessions(a.id)).toBe(1);
    for (const old of [a.refreshToken, b.refreshToken]) {
      await request(app).post('/api/auth/refresh').send({ refreshToken: old }).expect(401);
    }
    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: confirmed.body.session.refreshToken })
      .expect(200);

    // O e-mail novo entra confirmado (o link provou o endereço) e a conta sai do "pendente".
    const row = await userRow(a.id);
    expect(row.email).toBe(newEmail);
    expect(row.email_verified_at).not.toBeNull();
    expect(row.status).toBe('active');
    // Login só pelo endereço novo.
    await request(app)
      .post('/api/auth/login')
      .send({ email: oldEmail, password: PASSWORD })
      .expect(401);
    const again = await login(newEmail);
    expect(again.id).toBe(a.id);
    expect(await contact(again)).toMatchObject({
      email: newEmail,
      emailVerified: true,
      pendingEmail: null,
    });

    // Link de uso único: a segunda vez não vale.
    const reused = await request(app)
      .post('/api/auth/confirm-email-change')
      .send({ token })
      .expect(400);
    expect(reused.body.error).toBe('invalid_token');
    expect((await requests(a.id))[0]).toMatchObject({ outcome: 'confirmed' });

    // Auditoria: pedido e troca, com os endereços mascarados, de onde veio e quantas sessões caíram.
    const [asked] = await auditRows(a.id, 'email_change_requested');
    expect(asked).toMatchObject({
      entity_type: 'user',
      entity_id: a.id,
      user_agent: 'navegador-do-notebook',
      new_value: { requestId: saved!.id, blocked: null },
    });
    const [changed] = await auditRows(a.id, 'email_changed');
    expect(changed).toMatchObject({
      entity_type: 'user',
      entity_id: a.id,
      user_agent: 'navegador-do-notebook',
      new_value: { requestId: saved!.id, sessionsRevoked: 2 },
    });
    expect(changed!.ip_address).toMatch(/127\.0\.0\.1$/);
    expect(JSON.stringify([asked, changed])).not.toContain(newEmail);
    expect(JSON.stringify([asked, changed])).not.toContain(oldEmail);
    expect(JSON.stringify([asked, changed])).not.toContain(token);

    // O endereço antigo também é avisado de que a troca aconteceu.
    const after = await outbox(a.id, 3);
    expect(
      after.find(
        (m) => m.to_email === oldEmail && m.subject === 'O e-mail da sua conta foi trocado',
      ),
    ).toBeDefined();
  });

  it('confirmação sem login (outro aparelho): troca e derruba todas as sessões, sem sessão nova', async () => {
    const a = await login(await register());
    const newEmail = fresh();
    await requestChange(a, newEmail).expect(202);
    const token = await tokenSentTo(a.id, newEmail);

    const res = await request(app)
      .post('/api/auth/confirm-email-change')
      .send({ token })
      .expect(200);

    expect(res.body).toEqual({ email: newEmail, session: null });
    expect(await openSessions(a.id)).toBe(0);
    await request(app).post('/api/auth/refresh').send({ refreshToken: a.refreshToken }).expect(401);
  });

  it('link vencido: 400 e o e-mail não muda', async () => {
    const a = await login(await register());
    const newEmail = fresh();
    await requestChange(a, newEmail).expect(202);
    const token = await tokenSentTo(a.id, newEmail);
    await pool.query(
      'UPDATE email_change_requests SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE user_id = :id',
      { id: a.id },
    );

    const res = await request(app)
      .post('/api/auth/confirm-email-change')
      .send({ token })
      .expect(400);

    expect(res.body).toEqual({ error: 'invalid_token', message: 'Link inválido ou vencido' });
    expect((await userRow(a.id)).email).toBe(a.email);
    expect((await contact(a)).pendingEmail).toBeNull();
    expect(await openSessions(a.id)).toBe(1);
  });

  it('e-mail de outra conta: a resposta é igual à de um endereço livre, mas o link não sai', async () => {
    const taken = await register();
    const a = await login(await register());

    const res = await requestChange(a, taken.toUpperCase()).expect(202);

    // Mesmo formato e status de um pedido normal: quem pede não descobre que o endereço tem conta.
    expect(Object.keys(res.body).sort()).toEqual(['email', 'expiresAt']);
    expect(res.body.email).toBe(taken);
    expect((await contact(a)).pendingEmail).toEqual({
      email: taken,
      expiresAt: res.body.expiresAt,
    });
    // Só o aviso ao endereço atual; nada vai ao endereço pedido nem à outra conta.
    const mails = await outbox(a.id, 1);
    await new Promise((r) => setTimeout(r, 300));
    expect((await outbox(a.id, 1)).map((m) => m.template)).toEqual(['notification']);
    expect(mails[0]!.to_email).toBe(a.email);
    const [toTaken] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM email_outbox WHERE to_email = :taken AND template <> 'verify_email'`,
      { taken },
    );
    expect(Number(toTaken[0]!.n)).toBe(0);
    const [asked] = await auditRows(a.id, 'email_change_requested');
    expect(asked!.new_value).toMatchObject({ blocked: 'email_taken' });
  });

  it('endereço que outra conta pegou depois do pedido: 409 na confirmação e nada muda', async () => {
    const a = await login(await register());
    const newEmail = fresh();
    await requestChange(a, newEmail).expect(202);
    const token = await tokenSentTo(a.id, newEmail);
    await register(newEmail);

    const res = await request(app)
      .post('/api/auth/confirm-email-change')
      .send({ token })
      .expect(409);

    expect(res.body.error).toBe('email_unavailable');
    expect((await userRow(a.id)).email).toBe(a.email);
    expect(await openSessions(a.id)).toBe(1);
  });

  it('admin não troca o e-mail pelo perfil; conta comum não pega endereço da lista de admins', async () => {
    const admin = await login(await register(fresh('admin.escambo.test')));
    expect((await userRow(admin.id)).role).toBe('admin');
    const denied = await requestChange(admin, fresh()).expect(403);
    expect(denied.body.error).toBe('admin_email_locked');
    expect(await requests(admin.id)).toHaveLength(0);

    // Conta comum pedindo um endereço do domínio de admin: resposta normal, mas o link não sai, e
    // o papel não muda.
    const a = await login(await register());
    const reserved = fresh('admin.escambo.test');
    await requestChange(a, reserved).expect(202);
    await new Promise((r) => setTimeout(r, 300));
    expect((await outbox(a.id, 1)).map((m) => m.to_email)).toEqual([a.email]);
    const [asked] = await auditRows(a.id, 'email_change_requested');
    expect(asked!.new_value).toMatchObject({ blocked: 'admin_reserved' });
    expect((await userRow(a.id)).role).toBe('client');
  });

  it('desistir: o pedido sai do perfil e o link deixa de valer; trocar a senha também cancela', async () => {
    const a = await login(await register());
    const first = fresh();
    await requestChange(a, first).expect(202);
    const token = await tokenSentTo(a.id, first);

    await request(app).delete('/api/auth/change-email').set(auth(a.accessToken)).expect(204);
    expect((await contact(a)).pendingEmail).toBeNull();
    await request(app).post('/api/auth/confirm-email-change').send({ token }).expect(400);
    expect((await requests(a.id))[0]).toMatchObject({ outcome: 'cancelled' });

    // Pedido novo substitui o anterior; trocar a senha derruba o pendente.
    const second = fresh();
    await requestChange(a, second).expect(202);
    const third = fresh();
    await requestChange(a, third).expect(202);
    expect((await requests(a.id)).map((r) => r.outcome)).toEqual(['cancelled', 'replaced', null]);
    const tokens = await request(app)
      .post('/api/auth/change-password')
      .set(auth(a.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: 'senha-trocada-456' })
      .expect(200);
    expect(
      (await request(app).get('/api/auth/contact').set(auth(tokens.body.accessToken)).expect(200))
        .body.pendingEmail,
    ).toBeNull();
    expect((await requests(a.id)).at(-1)).toMatchObject({ outcome: 'cancelled' });
    expect(await auditRows(a.id, 'email_change_cancelled', 2)).toHaveLength(2);
  });
});

describe('telefone da conta (RF-017)', () => {
  it('guarda em E.164, recusa número inválido, não aparece no perfil público e entra na cópia LGPD', async () => {
    const f = await login(await register(fresh(), 'freelancer'), 'navegador-do-celular');
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.accessToken))
      .send({ fullName: 'Freela Telefone', city: 'Joinville' })
      .expect(200);

    const saved = await request(app)
      .put('/api/auth/phone')
      .set(auth(f.accessToken))
      .send({ phone: '(47) 99999-1234' })
      .expect(200);
    expect(saved.body).toMatchObject({ phone: '+5547999991234' });
    expect((await userRow(f.id)).phone).toBe('+5547999991234');

    const invalid = await request(app)
      .put('/api/auth/phone')
      .set(auth(f.accessToken))
      .send({ phone: '+1 415 555 0100' })
      .expect(422);
    expect(invalid.body.details.phone).toEqual([
      'Telefone inválido: use um número do Brasil com DDD, como (47) 99999-1234',
    ]);
    expect((await userRow(f.id)).phone).toBe('+5547999991234');

    // O perfil público (sem login) não traz telefone nem e-mail.
    const pub = await request(app).get(`/api/profiles/freelancer/${f.ulid}`).expect(200);
    expect(pub.body.fullName).toBe('Freela Telefone');
    expect(JSON.stringify(pub.body)).not.toContain('99999');
    expect(JSON.stringify(pub.body)).not.toContain(f.email);
    // Só o titular lê o próprio contato.
    await request(app).get('/api/auth/contact').expect(401);

    // Cópia LGPD: o telefone nos dados do titular e o pedido de troca de e-mail.
    const pedido = fresh();
    await requestChange(f, pedido).expect(202);
    const created = await request(app)
      .post('/api/lgpd/export-requests')
      .set(auth(f.accessToken))
      .expect(201);
    let text = '';
    for (let i = 0; i < 40 && !text; i++) {
      const dl = await request(app)
        .get(`/api/lgpd/export-requests/${created.body.id}/download`)
        .set(auth(f.accessToken));
      if (dl.status === 200) text = dl.text;
      else await new Promise((r) => setTimeout(r, 100));
    }
    const data = JSON.parse(text) as {
      titular: { phone: string };
      pedidosDeTrocaDeEmail: Record<string, unknown>[];
    };
    expect(data.titular.phone).toBe('+5547999991234');
    expect(data.pedidosDeTrocaDeEmail).toHaveLength(1);
    expect(data.pedidosDeTrocaDeEmail[0]).toMatchObject({ new_email: pedido, outcome: null });
    expect(data.pedidosDeTrocaDeEmail[0]).not.toHaveProperty('token');

    // Apagar: null (ou vazio) limpa o número.
    const cleared = await request(app)
      .put('/api/auth/phone')
      .set(auth(f.accessToken))
      .send({ phone: '' })
      .expect(200);
    expect(cleared.body.phone).toBeNull();
    expect((await userRow(f.id)).phone).toBeNull();
    const audits = await auditRows(f.id, 'phone_changed', 2);
    expect(audits.map((r) => r.new_value)).toEqual([{ informed: true }, { informed: false }]);
    expect(JSON.stringify(audits)).not.toContain('99999');
  });
});
