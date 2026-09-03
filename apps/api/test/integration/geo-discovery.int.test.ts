import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const PASS = 'senha-integracao-123';

let seq = 0;
async function loginNewFreelancer(): Promise<string> {
  const email = `geo_${Date.now()}_${seq++}@escambo.test`;
  await request(app).post('/api/auth/register').send({ email, password: PASS, role: 'freelancer' }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASS }).expect(200);
  return login.body.accessToken;
}

async function freelancerWith(lat: number, lng: number, title: string): Promise<void> {
  const token = await loginNewFreelancer();
  await request(app)
    .put('/api/profiles/freelancer')
    .set(auth(token))
    .send({ fullName: `${title} (dono)`, latitude: lat, longitude: lng })
    .expect(200);
  await request(app)
    .post('/api/services')
    .set(auth(token))
    .send({ categoryId: 10, title, description: 'Serviço local de teste com descrição', priceType: 'fixed', price: 100 })
    .expect(201);
}

const JOINVILLE = { lat: -26.3044, lng: -48.8487 };

afterAll(async () => {
  await pool.end();
});

describe('Descoberta local (geo)', () => {
  it('o perfil do freelancer guarda e devolve lat/lng', async () => {
    const token = await loginNewFreelancer();
    const put = await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(token))
      .send({ fullName: 'Geo Teste', latitude: -26.3, longitude: -48.8 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ latitude: -26.3, longitude: -48.8 });
  });

  it('ranqueia por proximidade e respeita o raio', async () => {
    await freelancerWith(-26.3044, -48.8487, 'Encanador Joinville'); // no ponto pesquisado
    await freelancerWith(-23.5505, -46.6333, 'Encanador Sao Paulo'); // ~430 km

    // Raio de 50 km ao redor de Joinville: só o local aparece.
    const near = await request(app).get(`/api/services?lat=${JOINVILLE.lat}&lng=${JOINVILLE.lng}&radiusKm=50`);
    expect(near.status).toBe(200);
    const titlesNear = (near.body.items as { title: string }[]).map((s) => s.title);
    expect(titlesNear).toContain('Encanador Joinville');
    expect(titlesNear).not.toContain('Encanador Sao Paulo');
    const jv = (near.body.items as { title: string; distanceKm: number }[]).find(
      (s) => s.title === 'Encanador Joinville',
    );
    expect(jv?.distanceKm).toBeLessThan(5);

    // Raio de 500 km (cap do schema): abrange São Paulo, com o mais próximo primeiro.
    const wide = await request(app).get(`/api/services?lat=${JOINVILLE.lat}&lng=${JOINVILLE.lng}&radiusKm=500`);
    expect(wide.status).toBe(200);
    const titlesWide = (wide.body.items as { title: string }[]).map((s) => s.title);
    expect(titlesWide.indexOf('Encanador Joinville')).toBeLessThan(titlesWide.indexOf('Encanador Sao Paulo'));
  });
});
