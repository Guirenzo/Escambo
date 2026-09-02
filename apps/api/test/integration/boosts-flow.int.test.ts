import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const PASS = 'senha-integracao-123';

let seq = 0;
async function freelancer(): Promise<string> {
  const email = `boost_${Date.now()}_${seq++}@escambo.test`;
  await request(app).post('/api/auth/register').send({ email, password: PASS, role: 'freelancer' }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASS }).expect(200);
  return login.body.accessToken;
}

async function createService(token: string, title: string): Promise<number> {
  const res = await request(app)
    .post('/api/services')
    .set(auth(token))
    .send({ categoryId: 10, title, description: 'Serviço de teste para impulsionamento', priceType: 'fixed', price: 100 });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function credits(token: string): Promise<number> {
  const res = await request(app).get('/api/wallet').set(auth(token));
  return res.body.credits;
}

async function planId(token: string, durationDays: number): Promise<number> {
  const res = await request(app).get('/api/boosts/plans').set(auth(token));
  const plan = (res.body as { id: number; durationDays: number }[]).find((p) => p.durationDays === durationDays);
  return plan!.id;
}

afterAll(async () => {
  await pool.end();
});

describe('Impulsionamento (Boosts) pago em créditos', () => {
  it('lista os planos com custo em créditos', async () => {
    const token = await freelancer();
    const res = await request(app).get('/api/boosts/plans').set(auth(token));
    expect(res.status).toBe(200);
    const p7 = (res.body as { durationDays: number; costCredits: number }[]).find((p) => p.durationDays === 7);
    expect(p7?.costCredits).toBe(30); // round(29.90)
  });

  it('compra debita créditos, ativa o boost e coloca o serviço no topo da busca', async () => {
    const a = await freelancer();
    await credits(a); // concede o bônus (100)
    const serviceA = await createService(a, 'BoostRank Alpha');
    const p7 = await planId(a, 7);

    const buy = await request(app).post('/api/boosts').set(auth(a)).send({ serviceId: serviceA, planId: p7 });
    expect(buy.status).toBe(201);
    expect(buy.body).toMatchObject({ serviceId: serviceA, status: 'active' });
    expect(await credits(a)).toBe(70); // 100 - 30

    const mine = await request(app).get('/api/boosts').set(auth(a));
    expect(mine.body).toHaveLength(1);

    // Um segundo serviço, mais novo, SEM boost.
    const b = await freelancer();
    await createService(b, 'BoostRank Beta');

    // Busca isolada: o impulsionado (mais antigo) vem antes do mais novo.
    const search = await request(app).get('/api/services?q=BoostRank');
    expect(search.status).toBe(200);
    const titles = (search.body.items as { title: string; boosted?: boolean }[]).map((s) => s.title);
    expect(titles.indexOf('BoostRank Alpha')).toBeLessThan(titles.indexOf('BoostRank Beta'));
    const alpha = (search.body.items as { title: string; boosted?: boolean }[]).find((s) => s.title === 'BoostRank Alpha');
    expect(alpha?.boosted).toBe(true);
  });

  it('recusa com 409 quando faltam créditos', async () => {
    const f = await freelancer();
    await credits(f); // 100
    const service = await createService(f, 'BoostRank Sem Saldo');
    const p30 = await planId(f, 30); // custa 100 créditos

    await request(app).post('/api/boosts').set(auth(f)).send({ serviceId: service, planId: p30 }).expect(201); // 100 -> 0
    const again = await request(app).post('/api/boosts').set(auth(f)).send({ serviceId: service, planId: p30 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('insufficient_credits');
  });

  it('não deixa impulsionar serviço de outro (403)', async () => {
    const owner = await freelancer();
    await credits(owner);
    const service = await createService(owner, 'BoostRank Alheio');
    const other = await freelancer();
    await credits(other);
    const p7 = await planId(other, 7);
    const res = await request(app).post('/api/boosts').set(auth(other)).send({ serviceId: service, planId: p7 });
    expect(res.status).toBe(403);
  });
});
