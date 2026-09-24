import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/** Busca de serviços com filtros e ordenação contra o MySQL real. */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerFreelancer(profile: {
  fullName: string;
  latitude?: number;
  longitude?: number;
}): Promise<Actor> {
  const email = `int_search_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role: 'freelancer' })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  const actor = { id: login.body.user.id as number, token: login.body.accessToken as string };
  await request(app)
    .put('/api/profiles/freelancer')
    .set(auth(actor.token))
    .send({ city: 'Joinville', isAvailable: true, ...profile })
    .expect(200);
  return actor;
}

const TAG = `busca${Date.now()}`;

async function publish(
  owner: Actor,
  title: string,
  price: number | null,
  deliveryDays: number | null,
): Promise<number> {
  const cats = await request(app).get('/api/categories');
  const res = await request(app)
    .post('/api/services')
    .set(auth(owner.token))
    .send({
      categoryId: cats.body[0].id,
      title: `${TAG} ${title}`,
      description: 'Serviço do teste de busca com filtros e ordenação.',
      priceType: price === null ? 'negotiable' : 'fixed',
      price,
      deliveryDays,
      isRemote: true,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

const titles = async (qs: string): Promise<string[]> => {
  const res = await request(app).get(`/api/services?q=${TAG}&${qs}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.items as { title: string }[]).map((s) => s.title.replace(`${TAG} `, ''));
};

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Busca de serviços: filtros e ordenação', () => {
  it('preço, prazo, nota mínima e as ordenações; distância só com geolocalização', async () => {
    // Três prestadores: um bem avaliado, um sem avaliação, um longe (Curitiba).
    const top = await registerFreelancer({
      fullName: 'Top Avaliado',
      latitude: -26.3045,
      longitude: -48.8487,
    });
    const novo = await registerFreelancer({
      fullName: 'Novato',
      latitude: -26.31,
      longitude: -48.85,
    });
    const longe = await registerFreelancer({
      fullName: 'Distante',
      latitude: -25.4284,
      longitude: -49.2733,
    });
    await pool.query(
      `UPDATE profiles_freelancer SET avg_rating = 4.8, total_reviews = 12 WHERE user_id = :id`,
      { id: top.id },
    );

    await publish(top, 'Caro e rápido', 900, 2);
    await publish(novo, 'Barato e lento', 120, 20);
    await publish(longe, 'Médio', 400, 7);
    await publish(novo, 'A combinar', null, null);

    // Relevância (padrão): mais recente primeiro; serviço sem preço aparece.
    expect(await titles('sort=relevance')).toEqual([
      'A combinar',
      'Médio',
      'Barato e lento',
      'Caro e rápido',
    ]);

    // Faixa de preço: sem preço fica de fora quando há filtro.
    expect(await titles('minPrice=200&maxPrice=500')).toEqual(['Médio']);
    expect(await titles('maxPrice=150')).toEqual(['Barato e lento']);

    // Prazo máximo e nota mínima do prestador.
    expect(await titles('maxDeliveryDays=7&sort=price_asc')).toEqual(['Médio', 'Caro e rápido']);
    expect(await titles('minRating=4')).toEqual(['Caro e rápido']);

    // Ordenações.
    expect(await titles('sort=price_asc')).toEqual([
      'Barato e lento',
      'Médio',
      'Caro e rápido',
      'A combinar',
    ]);
    expect(await titles('sort=price_desc')).toEqual([
      'Caro e rápido',
      'Médio',
      'Barato e lento',
      'A combinar',
    ]);
    expect((await titles('sort=rating'))[0]).toBe('Caro e rápido');
    expect((await titles('sort=newest'))[0]).toBe('A combinar');

    // Perto de Joinville, 30 km: o de Curitiba fica de fora; por distância, o mais perto primeiro.
    const near = 'lat=-26.3045&lng=-48.8487&radiusKm=30';
    expect(await titles(`${near}&sort=distance`)).toEqual([
      'Caro e rápido',
      'Barato e lento',
      'A combinar',
    ]);
    expect(await titles(`${near}&sort=price_asc`)).toEqual([
      'Barato e lento',
      'Caro e rápido',
      'A combinar',
    ]);
    expect(await titles(`lat=-26.3045&lng=-48.8487&radiusKm=200&sort=distance`)).toHaveLength(4);

    // Parâmetro inválido é recusado.
    await request(app).get(`/api/services?q=${TAG}&sort=cheapest`).expect(422);
    await request(app).get(`/api/services?q=${TAG}&minRating=6`).expect(422);
  });
});
