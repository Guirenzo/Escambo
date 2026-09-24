import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/**
 * O consentimento nasce no cadastro, gravado pelo servidor na versão vigente, com IP e navegador
 * (ADR 54): toda conta tem a trilha, e a API recusa versão que não existe.
 */
const app = createApp();
const password = 'senha-integracao-123';

afterAll(async () => {
  await pool.end();
});

describe('consentimento no cadastro (ADR 54)', () => {
  it('sem o aceite não há conta; com ele, os dois documentos ficam registrados na versão vigente', async () => {
    const email = `int_consent_${Date.now()}@escambo.test`;
    await request(app).post('/api/auth/register').send({ email, password }).expect(422);
    await request(app)
      .post('/api/auth/register')
      .set('user-agent', 'NavegadorDoCadastro/2.0')
      .send({ email, password, legalAccepted: true })
      .expect(201);
    const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
    const token = login.body.accessToken as string;

    const consents = await request(app)
      .get('/api/lgpd/consents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const byType = Object.fromEntries(
      (consents.body as { type: string; version: string; accepted: boolean }[]).map((c) => [
        c.type,
        c,
      ]),
    );
    expect(byType.terms_of_use).toMatchObject({ version: '1.2', accepted: true });
    expect(byType.privacy_policy).toMatchObject({ version: '1.3', accepted: true });

    const [rows] = await pool.query<({ user_agent: string | null } & { length: number })[]>(
      `SELECT c.user_agent FROM lgpd_consents c JOIN users u ON u.id = c.user_id
        WHERE u.email = :email AND c.type = 'privacy_policy'`,
      { email },
    );
    expect((rows as unknown as { user_agent: string | null }[])[0]?.user_agent).toBe(
      'NavegadorDoCadastro/2.0',
    );

    // Versão que não existe não entra na trilha.
    await request(app)
      .post('/api/lgpd/consents')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'privacy_policy', version: '9.9', accepted: true })
      .expect(422);
    // Responder à versão vigente (aceitar ou recusar) é o que a faixa faz.
    await request(app)
      .post('/api/lgpd/consents')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'privacy_policy', version: '1.3', accepted: false })
      .expect(201);
  });
});
