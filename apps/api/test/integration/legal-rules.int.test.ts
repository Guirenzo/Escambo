import type { Consent, ContractWithHistory, MyDropouts } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { confirmEmail } from './mail.helpers';

const app = createApp();
const headers = (token: string) => ({ Authorization: `Bearer ${token}` });

async function actor(role: 'client' | 'freelancer') {
  const key = ulid();
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone, email_verified_at)
      VALUES (:key, :email, :role, 'active', 'America/Sao_Paulo', NOW())`,
    { key, email: `legal-rules-${key}@escambo.test`, role },
  );
  const id = created.insertId;
  await walletRepository.ensure(id);
  await pool.query('UPDATE wallets SET balance = 1000 WHERE user_id = :id', { id });
  return {
    id,
    ulid: key,
    token: jwt.sign({ sub: key, uid: id, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

afterAll(async () => {
  await pool.end();
});

describe('ADR 61: versões legais e escolhas preservadas no banco real', () => {
  it('cadastro grava as duas versões 1.6; histórico 1.4 continua válido e versão futura é recusada', async () => {
    const email = `legal-register-${ulid()}@escambo.test`;
    const password = 'senha-integracao-123';
    await request(app)
      .post('/api/auth/register')
      .send({ email, password, role: 'client', legalAccepted: true })
      .expect(201);
    const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
    await confirmEmail(app, login.body.user.id);
    const auth = headers(login.body.accessToken as string);
    const initial = await request(app).get('/api/lgpd/consents').set(auth).expect(200);
    expect(initial.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'terms_of_use', version: '1.6', accepted: true }),
        expect.objectContaining({ type: 'privacy_policy', version: '1.6', accepted: true }),
      ]),
    );
    await request(app)
      .post('/api/lgpd/consents')
      .set(auth)
      .send({ type: 'privacy_policy', version: '1.4', accepted: true })
      .expect(201);
    await request(app)
      .post('/api/lgpd/consents')
      .set(auth)
      .send({ type: 'privacy_policy', version: '1.7', accepted: true })
      .expect(422);
    const final = await request(app).get('/api/lgpd/consents').set(auth).expect(200);
    const privacy = (final.body as Consent[]).filter((c) => c.type === 'privacy_policy');
    expect(privacy.map((c) => c.version)).toEqual(['1.4', '1.6']);
  });

  it('recusar a Política 1.5 não oculta a contagem, não suspende a conta e preserva a contestação privada', async () => {
    const client = await actor('client');
    const freelancer = await actor('freelancer');
    await request(app)
      .put('/api/profiles/freelancer')
      .set(headers(freelancer.token))
      .send({ fullName: 'Freelancer fictício ADR 61', city: 'Joinville' })
      .expect(200);
    for (let n = 1; n <= 3; n++) {
      const created = await request(app)
        .post('/api/contracts')
        .set(headers(client.token))
        .send({
          freelancerId: freelancer.id,
          title: `Desistência fictícia de contrato ${n}`,
          description: 'Fixture de teste para a escolha na nova Política de Privacidade',
          price: 100,
        })
        .expect(201);
      const id = created.body.id as number;
      await request(app)
        .post(`/api/contracts/${id}/accept`)
        .set(headers(freelancer.token))
        .expect(200);
      const detail = await request(app).get(`/api/contracts/${id}`).set(headers(freelancer.token));
      const quote = (detail.body as ContractWithHistory).cancellation!;
      await request(app)
        .post(`/api/contracts/${id}/cancel`)
        .set(headers(freelancer.token))
        .send({
          expectedRefund: quote.refundClient,
          expectedDropoutCount: quote.dropout!.countAfter,
        })
        .expect(200);
    }
    await request(app)
      .post('/api/lgpd/consents')
      .set(headers(freelancer.token))
      .send({ type: 'privacy_policy', version: '1.4', accepted: true })
      .expect(201);
    await request(app)
      .post('/api/lgpd/consents')
      .set(headers(freelancer.token))
      .send({ type: 'privacy_policy', version: '1.5', accepted: false })
      .expect(201);
    const consent = await request(app).get('/api/lgpd/consents').set(headers(freelancer.token));
    expect(consent.body[0]).toMatchObject({
      type: 'privacy_policy',
      version: '1.5',
      accepted: false,
    });
    const publicProfile = () => request(app).get(`/api/profiles/freelancer/${freelancer.ulid}`);
    expect((await publicProfile()).body.dropouts).toEqual({
      count: 3,
      windowDays: 60,
      alert: true,
    });
    const own = await request(app).get('/api/profiles/me/dropouts').set(headers(freelancer.token));
    const items = (own.body as MyDropouts).items;
    expect(items).toHaveLength(3);
    const text = 'Contestação privada fictícia: faltou material para concluir este trabalho.';
    await request(app)
      .post(`/api/profiles/me/dropouts/${items[0]!.id}/appeal`)
      .set(headers(freelancer.token))
      .send({ text })
      .expect(200);
    const afterAppeal = await publicProfile().expect(200);
    expect(afterAppeal.body.dropouts).toEqual({ count: 3, windowDays: 60, alert: true });
    expect(JSON.stringify(afterAppeal.body)).not.toContain(text);
    const [users] = await pool.query<RowDataPacket[]>('SELECT status FROM users WHERE id = :id', {
      id: freelancer.id,
    });
    expect(users[0]!.status).toBe('active');
  });
});
