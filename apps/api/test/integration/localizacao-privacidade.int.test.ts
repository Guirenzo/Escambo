import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { confirmEmail } from './mail.helpers';

/**
 * Privacidade da localização (achado de auditoria): o perfil público só mostra latitude e
 * longitude a ~1 km (2 casas) para quem não é o dono, logado ou não, admin inclusive. O dono vê o
 * valor exato (no /me e no próprio perfil público). A busca e o ranking "perto de mim" calculam a
 * distância, o raio e a ordem sobre a mesma coordenada arredondada: mexer no ponto da busca não
 * revela mais que o perfil.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const PASS = 'senha-integracao-123';

interface Actor {
  id: number;
  ulid: string;
  token: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `int_loc_${role}_${Date.now()}_${seq++}@${domain}`;
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password: PASS, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASS });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  await confirmEmail(app, login.body.user.id);
  return { id: login.body.user.id, ulid: login.body.user.ulid, token: login.body.accessToken };
}

type Point = { lat: number; lng: number };

async function freelancerAt(where: Point, name: string, serviceTitle?: string): Promise<Actor> {
  const f = await registerAndLogin('freelancer');
  const put = await request(app)
    .put('/api/profiles/freelancer')
    .set(auth(f.token))
    .send({ fullName: name, city: 'Teste', latitude: where.lat, longitude: where.lng });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  if (serviceTitle) {
    await request(app)
      .post('/api/services')
      .set(auth(f.token))
      .send({
        categoryId: 10,
        title: serviceTitle,
        description: 'Serviço local do teste de privacidade da localização',
        priceType: 'fixed',
        price: 100,
      })
      .expect(201);
  }
  return f;
}

/** Haversine (km), a mesma conta do SQL da busca, para conferir a distância que a API devolve. */
function haversineKm(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const cos =
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng) - rad(a.lng)) +
    Math.sin(rad(a.lat)) * Math.sin(rad(b.lat));
  return 6371 * Math.acos(Math.min(1, cos));
}

const oneDecimal = (n: number): number => Math.round(n * 10) / 10;
const decimals = (n: number): number => (String(n).split('.')[1] ?? '').length;

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Perfil público: localização a ~1 km para quem não é o dono', () => {
  const EXACT = { lat: -26.30449123, lng: -48.84561234 };
  const COARSE = { latitude: -26.3, longitude: -48.85 };

  it('sem sessão, outro freelancer, cliente e admin veem 2 casas; o dono vê o exato', async () => {
    const owner = await freelancerAt(EXACT, 'Freela Localização');
    const otherFreelancer = await registerAndLogin('freelancer');
    const client = await registerAndLogin('client');
    const admin = await registerAndLogin('client', 'admin.escambo.test');

    const path = `/api/profiles/freelancer/${owner.ulid}`;

    // Sem sessão (a rota é pública).
    const anon = await request(app).get(path).expect(200);
    expect(anon.body).toMatchObject(COARSE);
    expect(decimals(anon.body.latitude)).toBeLessThanOrEqual(2);
    expect(decimals(anon.body.longitude)).toBeLessThanOrEqual(2);

    // Logado, mas não é o dono: freelancer, cliente e admin, todos arredondados.
    for (const viewer of [otherFreelancer, client, admin]) {
      const res = await request(app).get(path).set(auth(viewer.token)).expect(200);
      expect(res.body, `viewer ${viewer.id}`).toMatchObject(COARSE);
    }

    // Token que não vale não quebra a rota pública nem revela nada: sai como anônimo.
    const bad = await request(app)
      .get(path)
      .set({ Authorization: 'Bearer nao.e.um-jwt' })
      .expect(200);
    expect(bad.body).toMatchObject(COARSE);

    // O dono, no próprio perfil público: exato.
    const mine = await request(app).get(path).set(auth(owner.token)).expect(200);
    expect(mine.body).toMatchObject({ latitude: EXACT.lat, longitude: EXACT.lng });

    // E no /me, onde edita o perfil: exato (senão salvar de novo gravaria o valor arredondado).
    const me = await request(app).get('/api/profiles/me').set(auth(owner.token)).expect(200);
    expect(me.body.freelancer).toMatchObject({ latitude: EXACT.lat, longitude: EXACT.lng });

    // O banco continua com o valor exato: só a resposta pública perde precisão.
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT latitude, longitude FROM profiles_freelancer WHERE user_id = :id',
      { id: owner.id },
    );
    expect(Number(rows[0]!.latitude)).toBe(EXACT.lat);
    expect(Number(rows[0]!.longitude)).toBe(EXACT.lng);

    // Fora a localização, o perfil é o mesmo para o dono e para os outros.
    const strip = (b: Record<string, unknown>) => ({ ...b, latitude: 0, longitude: 0 });
    expect(strip(anon.body)).toEqual(strip(mine.body));
  });

  it('sem localização, o perfil público continua com null', async () => {
    const f = await registerAndLogin('freelancer');
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.token))
      .send({ fullName: 'Freela Sem Lugar' })
      .expect(200);

    const res = await request(app).get(`/api/profiles/freelancer/${f.ulid}`).expect(200);
    expect(res.body.latitude).toBeNull();
    expect(res.body.longitude).toBeNull();
  });
});

describe('Busca e ranking "perto de mim" calculam sobre a coordenada a ~1 km', () => {
  // Um canto do mapa que nenhum outro teste usa (Mato Grosso), para a busca só achar estes dois.
  const HERE = { lat: -10.00412345, lng: -55.00412345 };
  // ~300 m e ~2 km do ponto pelo exato. Arredondados (-10.01/-55.00 e -9.99/-55.00), ficam a
  // ~0,8 km e ~1,6 km: é essa a distância que a API tem de devolver.
  const NEAR = { lat: -10.00681234, lng: -55.00398765 };
  const FAR = { lat: -9.98612345, lng: -55.00398765 };
  const coarse = (p: Point): Point => ({
    lat: Math.round(p.lat * 100) / 100,
    lng: Math.round(p.lng * 100) / 100,
  });
  const tag = `${Date.now()}`;
  let near: Actor;
  let far: Actor;
  const titlesAt = async (at: Point, radiusKm: number): Promise<string[]> => {
    const res = await request(app).get(
      `/api/services?lat=${at.lat}&lng=${at.lng}&radiusKm=${radiusKm}&sort=distance`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.items as Array<{ title: string }>).map((s) => s.title);
  };

  beforeAll(async () => {
    // O de longe primeiro: id menor, para a ordem por id não acertar por acaso.
    far = await freelancerAt(FAR, 'Freela Longe', `Jardinagem longe ${tag}`);
    near = await freelancerAt(NEAR, 'Freela Perto', `Jardinagem perto ${tag}`);
  });

  it('sort=distance: o mais perto primeiro, com a distância até a coordenada arredondada e sem coordenadas no item', async () => {
    const res = await request(app).get(
      `/api/services?lat=${HERE.lat}&lng=${HERE.lng}&radiusKm=5&sort=distance`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = (res.body.items as Array<{ title: string; distanceKm: number }>).filter((s) =>
      s.title.endsWith(tag),
    );
    expect(items.map((s) => s.title)).toEqual([
      `Jardinagem perto ${tag}`,
      `Jardinagem longe ${tag}`,
    ]);

    const [nearItem, farItem] = items;
    expect(nearItem!.distanceKm).toBe(oneDecimal(haversineKm(HERE, coarse(NEAR))));
    expect(nearItem!.distanceKm).not.toBe(oneDecimal(haversineKm(HERE, NEAR)));
    expect(farItem!.distanceKm).toBe(oneDecimal(haversineKm(HERE, coarse(FAR))));
    // A listagem não carrega a localização de ninguém.
    expect(JSON.stringify(res.body.items)).not.toMatch(/latitude|longitude/);
  });

  it('procurar no ponto exato da casa, com raio pequeno, não acha ninguém; só o ponto da grade de ~1 km acha', async () => {
    // Pelo exato, um raio de 0,5 km em cima da casa acharia a pessoa, e mexer no ponto aos poucos
    // revelaria onde ela mora. Pela coordenada arredondada, a casa está a ~0,56 km do ponto da grade.
    expect(await titlesAt(NEAR, 0.5)).not.toContain(`Jardinagem perto ${tag}`);
    // No ponto da grade, um raio mínimo acha: é tudo o que a busca revela, o mesmo que o perfil.
    expect(await titlesAt(coarse(NEAR), 0.1)).toContain(`Jardinagem perto ${tag}`);
  });

  it('relevância com lat/lng (sem destaque) também põe o mais perto primeiro', async () => {
    const res = await request(app).get(`/api/services?lat=${HERE.lat}&lng=${HERE.lng}&radiusKm=5`);
    expect(res.status).toBe(200);
    const titles = (res.body.items as Array<{ title: string }>)
      .map((s) => s.title)
      .filter((t) => t.endsWith(tag));
    expect(titles).toEqual([`Jardinagem perto ${tag}`, `Jardinagem longe ${tag}`]);
  });

  it('ranking perto de mim: a mesma distância arredondada e nenhuma coordenada na resposta', async () => {
    const viewer = await registerAndLogin('client');
    const res = await request(app)
      .get(`/api/gamification/leaderboard?lat=${HERE.lat}&lng=${HERE.lng}`)
      .set(auth(viewer.token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const entries = res.body as Array<{ userUlid: string; distanceKm?: number }>;
    const nearEntry = entries.find((e) => e.userUlid === near.ulid);
    const farEntry = entries.find((e) => e.userUlid === far.ulid);
    expect(nearEntry?.distanceKm).toBe(oneDecimal(haversineKm(HERE, coarse(NEAR))));
    expect(farEntry?.distanceKm).toBe(oneDecimal(haversineKm(HERE, coarse(FAR))));
    expect(JSON.stringify(entries)).not.toMatch(/latitude|longitude/);
  });

  it('o perfil público de quem aparece na busca segue arredondado para quem busca', async () => {
    const searcher = await registerAndLogin('client');
    const res = await request(app)
      .get(`/api/profiles/freelancer/${near.ulid}`)
      .set(auth(searcher.token))
      .expect(200);
    expect(res.body).toMatchObject({ latitude: -10.01, longitude: -55 });
  });
});
