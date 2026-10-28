import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';

/**
 * Login com Google (RF-002) desligado, que é o padrão: sem GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET,
 * /auth/providers diz false e as quatro rotas do Google não existem (o 404 de rota desconhecida),
 * com o app inteiro montado como na produção.
 */

const app = createApp();

describe('login com Google desligado', () => {
  it('GET /auth/providers responde { google: false }, sem login', async () => {
    const res = await request(app).get('/api/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ google: false });
  });

  it('start, callback, exchange e signup respondem 404, sem cookie nem redirecionamento', async () => {
    for (const res of [
      await request(app).get('/api/auth/google/start'),
      await request(app).get('/api/auth/google/callback?code=x&state=y'),
      await request(app)
        .post('/api/auth/google/exchange')
        .send({ code: 'c'.repeat(64) }),
      await request(app)
        .post('/api/auth/google/signup')
        .send({ signupToken: 's'.repeat(64), role: 'client', legalAccepted: true }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found', message: 'Rota não encontrada' });
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers.location).toBeUndefined();
    }
  });
});
