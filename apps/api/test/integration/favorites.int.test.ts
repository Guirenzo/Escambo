import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/** Favoritos contra o MySQL real: só se favorita o que existe, e nunca a si mesmo. */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function register(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `int_fav_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  const actor = { id: login.body.user.id as number, token: login.body.accessToken as string };
  if (role === 'freelancer') {
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(actor.token))
      .send({ fullName: 'Freela Favorito', city: 'Joinville', isAvailable: true })
      .expect(200);
  }
  return actor;
}

async function publish(owner: Actor): Promise<number> {
  const cats = await request(app).get('/api/categories');
  const res = await request(app).post('/api/services').set(auth(owner.token)).send({
    categoryId: cats.body[0].id,
    title: 'Serviço para favoritar',
    description: 'Serviço do teste de favoritos.',
    priceType: 'fixed',
    price: 100,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

const favorite = (
  who: Actor,
  targetType: 'service' | 'freelancer',
  targetId: number,
): request.Test =>
  request(app).post('/api/favorites').set(auth(who.token)).send({ targetType, targetId });

afterAll(async () => {
  await pool.end();
});

describe('Favoritos: o alvo precisa existir', () => {
  it('favorita serviço e freelancer que existem; inexistente, removido ou o próprio é recusado', async () => {
    const owner = await register('freelancer');
    const client = await register('client');
    const service = await publish(owner);
    const removed = await publish(owner);
    await request(app).delete(`/api/services/${removed}`).set(auth(owner.token)).expect(204);

    await favorite(client, 'service', service).expect(201);
    await favorite(client, 'freelancer', owner.id).expect(201);

    const missingService = await favorite(client, 'service', 99999999);
    expect(missingService.status).toBe(404);
    expect(missingService.body.error).toBe('service_not_found');
    expect((await favorite(client, 'service', removed)).body.error).toBe('service_not_found');

    // Conta sem perfil de freelancer (o cliente) e id que não existe não são freelancer.
    expect((await favorite(owner, 'freelancer', client.id)).body.error).toBe(
      'freelancer_not_found',
    );
    const missingUser = await favorite(client, 'freelancer', 99999999);
    expect(missingUser.status).toBe(404);
    expect(missingUser.body.error).toBe('freelancer_not_found');

    const self = await favorite(owner, 'freelancer', owner.id);
    expect(self.status).toBe(422);
    expect(self.body.error).toBe('cannot_favorite_self');
    expect((await favorite(owner, 'service', service)).body.error).toBe('cannot_favorite_self');

    // Só os dois válidos ficaram gravados.
    const mine = await request(app).get('/api/favorites').set(auth(client.token)).expect(200);
    expect(
      (mine.body as { targetType: string; targetId: number }[])
        .map((f) => [f.targetType, f.targetId])
        .sort(),
    ).toEqual([
      ['freelancer', owner.id],
      ['service', service],
    ]);
    const ownerFavorites = await request(app).get('/api/favorites').set(auth(owner.token));
    expect(ownerFavorites.body).toEqual([]);
  });
});
