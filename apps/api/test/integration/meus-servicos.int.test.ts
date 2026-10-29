import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { confirmEmail } from './mail.helpers';

/**
 * "Meus serviços" (RF-030) contra o MySQL real: o dono vê os pausados, que somem da busca mas
 * continuam abrindo pelo link (RN-013); a edição grava tipo de preço, prazo e modalidade
 * (RF-022 e RF-023).
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerFreelancer(fullName: string): Promise<Actor> {
  const email = `int_meus_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role: 'freelancer' })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  await confirmEmail(app, login.body.user.id);
  const actor = { id: login.body.user.id as number, token: login.body.accessToken as string };
  await request(app)
    .put('/api/profiles/freelancer')
    .set(auth(actor.token))
    .send({ fullName, city: 'Joinville', isAvailable: true })
    .expect(200);
  return actor;
}

let categoryId = 0;
async function publish(owner: Actor, body: Record<string, unknown>): Promise<number> {
  const res = await request(app)
    .post('/api/services')
    .set(auth(owner.token))
    .send({
      categoryId,
      description: 'Serviço do teste de meus serviços.',
      ...body,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

interface Item {
  id: number;
  title: string;
  isActive: boolean;
  priceType: string;
  price: number | null;
  deliveryDays: number | null;
  isRemote: boolean;
  boosted?: boolean;
}

async function mine(owner: Actor): Promise<Item[]> {
  const res = await request(app).get('/api/services/mine').set(auth(owner.token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Item[];
}

async function publicIds(owner: Actor): Promise<number[]> {
  const res = await request(app).get(`/api/services?ownerId=${owner.id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.items as Item[]).map((s) => s.id);
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
  const cats = await request(app).get('/api/categories');
  categoryId = cats.body[0].id as number;
});

afterAll(async () => {
  await pool.end();
});

describe('Meus serviços (RF-030)', () => {
  it('o dono vê os pausados; a busca não; o link continua abrindo; excluído some', async () => {
    const dono = await registerFreelancer('Dona dos Serviços');
    const outro = await registerFreelancer('Outro Freelancer');

    const logo = await publish(dono, {
      title: 'Logo fixo',
      priceType: 'fixed',
      price: 120,
      deliveryDays: 5,
      isRemote: true,
    });
    const aula = await publish(dono, {
      title: 'Aula por hora',
      priceType: 'hourly',
      price: 80,
      deliveryDays: 1,
      isRemote: false,
    });
    await publish(outro, { title: 'Serviço do outro', priceType: 'negotiable', price: null });

    // Pausa o logo pela mesma rota que a tela usa.
    const paused = await request(app)
      .patch(`/api/services/${logo}`)
      .set(auth(dono.token))
      .send({ isActive: false });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body.isActive).toBe(false);

    // Do mais novo ao mais antigo, com o pausado marcado e tipo, prazo e modalidade gravados.
    expect(await mine(dono)).toEqual([
      expect.objectContaining({
        id: aula,
        title: 'Aula por hora',
        isActive: true,
        priceType: 'hourly',
        price: 80,
        deliveryDays: 1,
        isRemote: false,
        boosted: false,
      }),
      expect.objectContaining({
        id: logo,
        title: 'Logo fixo',
        isActive: false,
        priceType: 'fixed',
        price: 120,
        deliveryDays: 5,
        isRemote: true,
      }),
    ]);
    // Cada um vê só os seus.
    expect((await mine(outro)).map((s) => s.title)).toEqual(['Serviço do outro']);

    // RN-013: fora da busca, mas o link abre.
    expect(await publicIds(dono)).toEqual([aula]);
    const link = await request(app).get(`/api/services/${logo}`);
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ id: logo, isActive: false });

    // Reativado, volta para a busca.
    await request(app)
      .patch(`/api/services/${logo}`)
      .set(auth(dono.token))
      .send({ isActive: true })
      .expect(200);
    expect((await publicIds(dono)).sort()).toEqual([aula, logo].sort());

    // Excluído não volta nem em "meus serviços".
    await request(app).delete(`/api/services/${aula}`).set(auth(dono.token)).expect(204);
    expect((await mine(dono)).map((s) => s.id)).toEqual([logo]);
  });

  it('a edição troca tipo de preço, prazo e modalidade, e só o dono pausa', async () => {
    const dono = await registerFreelancer('Quem Edita');
    const intruso = await registerFreelancer('Quem Tenta');
    const id = await publish(dono, {
      title: 'Fotos de produto',
      priceType: 'fixed',
      price: 200,
      deliveryDays: 7,
      isRemote: true,
    });

    const edited = await request(app)
      .patch(`/api/services/${id}`)
      .set(auth(dono.token))
      .send({ priceType: 'negotiable', price: null, deliveryDays: null, isRemote: false });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((await mine(dono))[0]).toMatchObject({
      id,
      priceType: 'negotiable',
      price: null,
      deliveryDays: null,
      isRemote: false,
      isActive: true,
    });

    // Voltar para preço fixo sem preço é recusado (RN-016 no estado final).
    const noPrice = await request(app)
      .patch(`/api/services/${id}`)
      .set(auth(dono.token))
      .send({ priceType: 'fixed' });
    expect(noPrice.status).toBe(422);
    expect(noPrice.body.error).toBe('price_required');

    const forbidden = await request(app)
      .patch(`/api/services/${id}`)
      .set(auth(intruso.token))
      .send({ isActive: false });
    expect(forbidden.status).toBe(403);
    expect((await mine(dono))[0]).toMatchObject({ id, isActive: true });
  });

  it('sem login, "meus serviços" é 401', async () => {
    const res = await request(app).get('/api/services/mine');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_token');
  });
});
