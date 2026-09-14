import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/**
 * Busca por dia de atendimento (ADR 30): `day=0..6` filtra pelos dias que o prestador marcou no
 * perfil (JSON), quem não informou fica de fora, e o card recebe ownerAvailableDays.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerFreelancer(availableDays: number[] | null): Promise<Actor> {
  const email = `int_day_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ email, password, role: 'freelancer' })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  const actor = { id: login.body.user.id as number, token: login.body.accessToken as string };
  await request(app)
    .put('/api/profiles/freelancer')
    .set(auth(actor.token))
    .send({ fullName: `Dia ${seq}`, city: 'Joinville', isAvailable: true, availableDays })
    .expect(200);
  return actor;
}

const TAG = `atende${Date.now()}`;

async function publish(owner: Actor, title: string): Promise<number> {
  const cats = await request(app).get('/api/categories').expect(200);
  const list = (Array.isArray(cats.body) ? cats.body : cats.body.items) as { id: number }[];
  const categoryId = list[0]!.id;
  const res = await request(app)
    .post('/api/services')
    .set(auth(owner.token))
    .send({
      categoryId,
      title: `${TAG} ${title}`,
      description: 'Serviço usado para testar o filtro por dia de atendimento',
      priceType: 'fixed',
      price: 100,
    })
    .expect(201);
  return res.body.id as number;
}

const search = (query: string) => request(app).get(`/api/services?q=${TAG}&limit=50${query}`);
const titles = (res: request.Response): string[] =>
  (res.body.items as { title: string }[]).map((i) => i.title.replace(`${TAG} `, '')).sort();

beforeAll(async () => {
  const weekdays = await registerFreelancer([1, 2, 3, 4, 5]);
  const weekend = await registerFreelancer([6, 0]); // fora de ordem de propósito
  const silent = await registerFreelancer(null); // não informou
  await publish(weekdays, 'semana');
  await publish(weekend, 'fim de semana');
  await publish(silent, 'sem dias');
});

afterAll(async () => {
  await pool.end();
});

describe('Busca por dia de atendimento', () => {
  it('sem filtro vêm todos, com os dias do prestador no card (null para quem não informou)', async () => {
    const res = await search('').expect(200);
    expect(titles(res)).toEqual(['fim de semana', 'sem dias', 'semana']);
    const byTitle = Object.fromEntries(
      (res.body.items as { title: string; ownerAvailableDays: number[] | null }[]).map((i) => [
        i.title.replace(`${TAG} `, ''),
        i.ownerAvailableDays,
      ]),
    );
    expect(byTitle['semana']).toEqual([1, 2, 3, 4, 5]);
    expect(byTitle['fim de semana']).toEqual([0, 6]); // normalizado no perfil
    expect(byTitle['sem dias']).toBeNull();
  });

  it('day=6 (sábado) só traz quem marcou sábado; day=1 só quem atende na semana', async () => {
    expect(titles(await search('&day=6').expect(200))).toEqual(['fim de semana']);
    expect(titles(await search('&day=0').expect(200))).toEqual(['fim de semana']);
    expect(titles(await search('&day=1').expect(200))).toEqual(['semana']);
    expect(titles(await search('&day=3').expect(200))).toEqual(['semana']);
  });

  it('combina com os outros filtros e ordenações; dia inválido é 422', async () => {
    expect(titles(await search('&day=6&maxPrice=150&sort=price_asc').expect(200))).toEqual([
      'fim de semana',
    ]);
    expect(titles(await search('&day=6&maxPrice=50').expect(200))).toEqual([]);
    await search('&day=7').expect(422);
    await search('&day=-1').expect(422);
    await search('&day=abc').expect(422);
  });
});
