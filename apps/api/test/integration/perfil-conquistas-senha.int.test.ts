import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { gamificationService } from '../../src/modules/gamification/gamification.service';

/**
 * Perfil e conta contra o MySQL real: o perfil público traz o XP e as badges (RF-015, RF-068),
 * com as 3 mais recentes em destaque (RN-058) e desempate estável; a troca de senha com login
 * (RF-017) confere a atual, derruba as outras sessões, mantém quem trocou, grava na auditoria e
 * deixa o aviso na caixa de saída de e-mails.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

let seq = 0;
const PASSWORD = 'senha-integracao-123';
const NEW_PASSWORD = 'senha-trocada-456';

async function register(role: 'client' | 'freelancer'): Promise<string> {
  const email = `int_perfil_${Date.now()}_${seq++}@escambo.test`;
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password: PASSWORD, role })
    .expect(201);
  return email;
}

async function login(
  email: string,
  password = PASSWORD,
  userAgent = 'vitest-integracao',
): Promise<{ id: number; ulid: string; accessToken: string; refreshToken: string }> {
  const res = await request(app)
    .post('/api/auth/login')
    .set('User-Agent', userAgent)
    .send({ email, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    id: res.body.user.id,
    ulid: res.body.user.ulid,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
  };
}

async function badgeId(slug: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM badges WHERE slug = :slug', {
    slug,
  });
  return Number(rows[0]!.id);
}

async function openSessions(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = :userId AND revoked_at IS NULL',
    { userId },
  );
  return Number(rows[0]!.n);
}

async function passwordHashOf(userId: number): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT password_hash FROM users WHERE id = :userId',
    { userId },
  );
  return String(rows[0]!.password_hash);
}

/** A auditoria é gravada em segundo plano (melhor esforço): espera a linha aparecer. */
async function auditRows(userId: number, action: string): Promise<RowDataPacket[]> {
  for (let i = 0; i < 30; i++) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT entity_type, entity_id, new_value, ip_address, user_agent
         FROM audit_logs WHERE user_id = :userId AND action = :action`,
      { userId, action },
    );
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

afterAll(async () => {
  await pool.end();
});

describe('perfil público: XP e badges (RF-015, RF-068, RN-058)', () => {
  it('traz o XP e todas as badges, da mais recente para a mais antiga; empate no mesmo segundo sai pela ordem de concessão', async () => {
    const email = await register('freelancer');
    const f = await login(email);
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.accessToken))
      .send({ fullName: 'Freela Conquistas', city: 'Joinville' })
      .expect(200);
    await gamificationService.awardXp(f.id, 350, 'contract_completed', 1);

    // Quatro badges: duas no mesmo segundo (a segunda concedida depois tem id maior).
    const grants: [string, string][] = [
      ['first-deal', '2026-09-01 12:00:00'],
      ['fast-delivery', '2026-09-20 12:00:00'],
      ['top-rated', '2026-10-02 12:00:00'],
      ['client-favorite', '2026-10-02 12:00:00'],
    ];
    for (const [slug, at] of grants) {
      await pool.query(
        'INSERT INTO user_badges (user_id, badge_id, awarded_at) VALUES (:userId, :badgeId, :at)',
        { userId: f.id, badgeId: await badgeId(slug), at },
      );
    }

    // Perfil público: sem login.
    const res = await request(app).get(`/api/profiles/freelancer/${f.ulid}`).expect(200);

    expect(res.body.totalXp).toBe(350);
    expect(res.body.level).toBe(2);
    expect(res.body.levelName).toBe('Aprendiz');
    expect(res.body.badges.map((b: { slug: string }) => b.slug)).toEqual([
      'client-favorite',
      'top-rated',
      'fast-delivery',
      'first-deal',
    ]);
    expect(res.body.badges[0]).toEqual({
      slug: 'client-favorite',
      name: 'Client Favorite',
      awardedAt: expect.stringMatching(/^2026-10-02T\d{2}:00:00\.000Z$/),
    });
    expect(res.body.featuredBadges.map((b: { slug: string }) => b.slug)).toEqual([
      'client-favorite',
      'top-rated',
      'fast-delivery',
    ]);
  });

  it('freelancer sem XP nem badges: XP 0, nível 1 e listas vazias (nada é criado na leitura)', async () => {
    const email = await register('freelancer');
    const f = await login(email);
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.accessToken))
      .send({ fullName: 'Freela Novato' })
      .expect(200);

    const res = await request(app).get(`/api/profiles/freelancer/${f.ulid}`).expect(200);

    expect(res.body).toMatchObject({
      totalXp: 0,
      level: 1,
      levelName: 'Iniciante',
      badges: [],
      featuredBadges: [],
    });
    const [xp] = await pool.query<RowDataPacket[]>('SELECT id FROM user_xp WHERE user_id = :id', {
      id: f.id,
    });
    expect(xp).toHaveLength(0);
  });
});

describe('troca de senha com login (RF-017)', () => {
  it('senha atual errada: 400 e nada muda (senha e sessões)', async () => {
    const email = await register('client');
    const a = await login(email);
    const before = await passwordHashOf(a.id);

    const res = await request(app)
      .post('/api/auth/change-password')
      .set(auth(a.accessToken))
      .send({ currentPassword: 'nao-e-a-senha', newPassword: NEW_PASSWORD })
      .expect(400);

    expect(res.body).toEqual({ error: 'wrong_password', message: 'Senha atual incorreta' });
    expect(await passwordHashOf(a.id)).toBe(before);
    expect(await openSessions(a.id)).toBe(1);
  });

  it('troca, derruba as outras sessões, mantém quem trocou, audita e avisa por e-mail', async () => {
    const email = await register('client');
    const a = await login(email, PASSWORD, 'navegador-do-notebook');
    const b = await login(email, PASSWORD, 'navegador-do-celular');
    expect(await openSessions(a.id)).toBe(2);

    const res = await request(app)
      .post('/api/auth/change-password')
      .set(auth(a.accessToken))
      .set('User-Agent', 'navegador-do-notebook')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'refreshToken']);

    // Uma sessão aberta só: a nova, de quem trocou. As duas de antes caíram.
    expect(await openSessions(a.id)).toBe(1);
    for (const old of [a.refreshToken, b.refreshToken]) {
      await request(app).post('/api/auth/refresh').send({ refreshToken: old }).expect(401);
    }
    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: res.body.refreshToken })
      .expect(200);
    await request(app).get('/api/auth/me').set(auth(res.body.accessToken)).expect(200);

    // A senha antiga não entra mais; a nova entra.
    await request(app).post('/api/auth/login').send({ email, password: PASSWORD }).expect(401);
    await login(email, NEW_PASSWORD);

    // Auditoria: quem, o quê, quantas sessões caíram e de onde; sem senha nenhuma.
    const audit = await auditRows(a.id, 'password_changed');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity_type: 'user',
      entity_id: a.id,
      new_value: { sessionsRevoked: 2 },
      user_agent: 'navegador-do-notebook',
    });
    expect(audit[0]!.ip_address).toMatch(/127\.0\.0\.1$/);
    expect(JSON.stringify(audit[0])).not.toContain(NEW_PASSWORD);

    // Aviso por e-mail na caixa de saída (provedor simulado).
    const [mails] = await pool.query<RowDataPacket[]>(
      `SELECT to_email, subject, text_body, status FROM email_outbox
        WHERE user_id = :userId AND template = 'notification'`,
      { userId: a.id },
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      to_email: email,
      subject: 'Sua senha foi alterada',
      status: 'sent',
    });
    expect(mails[0]!.text_body).toContain('http://app.escambo.test/esqueci-senha');
    expect(mails[0]!.text_body).not.toContain(NEW_PASSWORD);
  });
});
