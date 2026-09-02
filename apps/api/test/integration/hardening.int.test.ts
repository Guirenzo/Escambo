import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

const app = createApp();

afterAll(async () => {
  await pool.end();
});

describe('Hardening HTTP', () => {
  it('liveness responde sem depender do banco', async () => {
    const res = await request(app).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('devolve X-Request-Id em toda resposta', async () => {
    const res = await request(app).get('/api/health/live');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('preserva o X-Request-Id enviado pelo cliente (correlação)', async () => {
    const res = await request(app).get('/api/health/live').set('X-Request-Id', 'corr-123');
    expect(res.headers['x-request-id']).toBe('corr-123');
  });

  it('JSON malformado retorna 400 (não 500)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "a@b.com", '); // JSON truncado
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });

  it('não expõe o header X-Powered-By', async () => {
    const res = await request(app).get('/api/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rota desconhecida retorna 404 padronizado', async () => {
    const res = await request(app).get('/api/rota-que-nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
