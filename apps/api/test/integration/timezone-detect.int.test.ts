import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/**
 * Fuso detectado pelo navegador (ADR 51) contra o MySQL real: o cadastro aceita o fuso do
 * aparelho e a conta já nasce com ele escolhido; sem fuso, a conta fica em Brasília e marcada como
 * não escolhida, que é o que faz o app sugerir uma vez. Qualquer escolha pela preferência marca
 * como escolhida; voltar a null desfaz.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const password = 'senha-integracao-123';
let seq = 0;
const email = (): string => `int_fuso_cadastro_${Date.now()}_${seq++}@escambo.test`;

interface Me {
  timezone: string;
  timezoneChosen: boolean;
}

async function login(address: string): Promise<{ token: string; user: Me }> {
  const res = await request(app).post('/api/auth/login').send({ email: address, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { token: res.body.accessToken, user: res.body.user };
}

afterAll(async () => {
  await pool.end();
});

describe('Fuso detectado no cadastro (ADR 51)', () => {
  it('cadastro com o fuso do aparelho já nasce escolhido; sem fuso, fica em Brasília e não escolhido', async () => {
    const manaus = email();
    const created = await request(app).post('/api/auth/register').send({
      legalAccepted: true,
      email: manaus,
      password,
      role: 'freelancer',
      timezone: 'America/Manaus',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ timezone: 'America/Manaus', timezoneChosen: true });
    const a = await login(manaus);
    expect(a.user).toMatchObject({ timezone: 'America/Manaus', timezoneChosen: true });
    const me = await request(app).get('/api/auth/me').set(auth(a.token)).expect(200);
    expect(me.body).toMatchObject({ timezone: 'America/Manaus', timezoneChosen: true });

    const semFuso = email();
    const plain = await request(app)
      .post('/api/auth/register')
      .send({ legalAccepted: true, email: semFuso, password, role: 'client' })
      .expect(201);
    expect(plain.body).toMatchObject({ timezone: 'America/Sao_Paulo', timezoneChosen: false });
    const b = await login(semFuso);
    expect(b.user).toMatchObject({ timezone: 'America/Sao_Paulo', timezoneChosen: false });

    // Fuso de fora da lista do Brasil é recusado, como na preferência.
    await request(app)
      .post('/api/auth/register')
      .send({ legalAccepted: true, email: email(), password, timezone: 'Europe/Lisbon' })
      .expect(422);
  });

  it('manter Brasília pela preferência marca como escolhido; null volta a não escolhido', async () => {
    const address = email();
    await request(app)
      .post('/api/auth/register')
      .send({ legalAccepted: true, email: address, password })
      .expect(201);
    const { token } = await login(address);
    const put = (timezone: string | null) =>
      request(app)
        .put('/api/notifications/preferences')
        .set(auth(token))
        .send({ timezone })
        .expect(200);

    await put('America/Sao_Paulo');
    let me = await request(app).get('/api/auth/me').set(auth(token)).expect(200);
    expect(me.body).toMatchObject({ timezone: 'America/Sao_Paulo', timezoneChosen: true });

    await put(null);
    me = await request(app).get('/api/auth/me').set(auth(token)).expect(200);
    expect(me.body).toMatchObject({ timezone: 'America/Sao_Paulo', timezoneChosen: false });
  });
});
