import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaderboardEntry, Mission } from '@escambo/types';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { missionsService } from '../../src/modules/gamification/gamification.missions';
import { addDaysToDay, dayIn, localInstant, localParts } from '../../src/utils/timezone';
import { DAY, fromNow, HOUR, noonBrasilia, startDaytimeClock, stopClock } from './clock.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * Missões com prazo e ranking por categoria e local (RF-066, RN-054, RF-067, RN-056) contra o MySQL
 * real, pelo fluxo da API: a semanal de contratações concluídas e a diária de presença cumpridas,
 * a resposta rápida a uma proposta, a conquista da primeira troca, o XP creditado uma vez só (evento
 * repetido ou em paralelo) e a virada do dia e da semana no fuso da conta, com o relógio do fluxo.
 * O ranking por categoria (com as subcategorias) e por raio segue a nota, as concluídas e o XP, e
 * deixa de fora conta banida ou suspensa.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const BRT = 'America/Sao_Paulo';

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `int_missoes_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { id: login.body.user.id as number, token: login.body.accessToken as string };
}

async function freelancer(
  fullName = 'Freela das Missões',
  extra: Record<string, unknown> = {},
): Promise<Actor> {
  const actor = await registerAndLogin('freelancer');
  const res = await request(app)
    .put('/api/profiles/freelancer')
    .set(auth(actor.token))
    .send({ fullName, city: 'Joinville', isAvailable: true, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return actor;
}

async function client(balance = 100): Promise<Actor> {
  const actor = await registerAndLogin('client');
  await fundWallet(app, actor.token, balance);
  return actor;
}

async function propose(c: Actor, f: Actor): Promise<number> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(c.token))
    .send({
      freelancerId: f.id,
      title: 'Contratação das missões',
      description: 'Contratação do teste de integração das missões com prazo',
      price: 10,
      deadlineAt: fromNow(5 * DAY).toISOString(),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

async function accept(f: Actor, id: number): Promise<void> {
  const res = await request(app).post(`/api/contracts/${id}/accept`).set(auth(f.token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** Proposta → aceite → entrega → aprovação, no relógio do fluxo. */
async function completeContract(c: Actor, f: Actor): Promise<void> {
  const id = await propose(c, f);
  await accept(f, id);
  await request(app)
    .post(`/api/contracts/${id}/deliver`)
    .set(auth(f.token))
    .send({ message: 'Entrega das missões.' })
    .expect(200);
  const ok = await request(app).post(`/api/contracts/${id}/approve`).set(auth(c.token));
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  expect(ok.body.status).toBe('completed');
}

/** Troca equilibrada proposta por `a`, aceita por `b` e concluída pelos dois lados. */
async function completeBarter(a: Actor, b: Actor): Promise<void> {
  const created = await request(app).post('/api/barters').set(auth(a.token)).send({
    receiverId: b.id,
    offeredDescription: 'Ofereço uma identidade visual',
    requestedDescription: 'Quero uma landing page',
    estimatedValueOffered: 100,
    estimatedValueRequested: 100,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const accepted = await request(app)
    .post(`/api/barters/${created.body.id}/accept`)
    .set(auth(b.token));
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  for (const [contractId, deliverer, receiver] of [
    [accepted.body.contractOfferedId as number, a, b],
    [accepted.body.contractRequestedId as number, b, a],
  ] as const) {
    await request(app)
      .post(`/api/contracts/${contractId}/deliver`)
      .set(auth(deliverer.token))
      .send({ message: 'Entregue.' })
      .expect(200);
    const ok = await request(app)
      .post(`/api/contracts/${contractId}/approve`)
      .set(auth(receiver.token));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  }
}

async function missionsOf(f: Actor): Promise<Mission[]> {
  const res = await request(app).get('/api/gamification/me/missions').set(auth(f.token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Mission[];
}

const byTitle = (missions: Mission[], title: string): Mission => {
  const found = missions.find((m) => m.title === title);
  if (!found) throw new Error(`missão "${title}" não veio`);
  return found;
};

/** Os XP de missão da pessoa, pelo título, na ordem do extrato. */
async function missionXp(userId: number): Promise<Array<[string, number]>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT m.title, x.amount FROM xp_transactions x
       JOIN user_missions um ON um.id = x.reference_id
       JOIN missions m ON m.id = um.mission_id
      WHERE x.user_id = :userId AND x.reason = 'mission_completed'
      ORDER BY x.id`,
    { userId },
  );
  return rows.map((r) => [r.title as string, Number(r.amount)]);
}

/** As linhas de progresso da pessoa numa missão, por período. */
async function rowsOf(
  userId: number,
  title: string,
): Promise<Array<{ period_key: string; progress: number; is_completed: number }>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT um.period_key, um.progress, um.is_completed FROM user_missions um
       JOIN missions m ON m.id = um.mission_id
      WHERE um.user_id = :userId AND m.title = :title ORDER BY um.id`,
    { userId, title },
  );
  return rows.map((r) => ({
    period_key: r.period_key as string,
    progress: Number(r.progress),
    is_completed: Number(r.is_completed),
  }));
}

async function noticesOf(userId: number): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT title FROM notifications WHERE user_id = :userId AND type = 'mission_completed'
      ORDER BY id`,
    { userId },
  );
  return rows.map((r) => r.title as string);
}

const setZone = (userId: number, zone: string): Promise<unknown> =>
  pool.query('UPDATE users SET timezone = :zone WHERE id = :id', { zone, id: userId });

/** O instante em que o relógio de Brasília marca esse dia e essa hora. */
function brt(day: string, hour: number, minute = 0, second = 0): Date {
  const [y, m, d] = day.split('-').map(Number);
  return localInstant(BRT, y!, m!, d!, hour, minute, second);
}

/** Hoje, em Brasília, e a segunda e o domingo desta semana. */
function thisWeek(): { today: string; monday: string; sunday: string } {
  const noon = noonBrasilia();
  const today = dayIn(BRT, noon);
  const monday = addDaysToDay(today, -((localParts(BRT, noon).weekday + 6) % 7));
  return { today, monday, sunday: addDaysToDay(monday, 6) };
}

beforeAll(async () => {
  startDaytimeClock();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

beforeEach(() => {
  startDaytimeClock();
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('Missões com prazo pelo fluxo (RF-066, RN-054)', () => {
  it('semanal: três contratações concluídas na semana cumprem a Maratona, com 200 XP uma vez só', async () => {
    const f = await freelancer();
    const c = await client();
    const { sunday } = thisWeek();

    for (let i = 0; i < 2; i += 1) await completeContract(c, f);
    let marathon = byTitle(await missionsOf(f), 'Maratona da semana');
    expect(marathon).toMatchObject({ progress: 2, target: 3, completed: false, type: 'weekly' });
    // A semana termina domingo 23:59:59 no fuso da conta (Brasília, por padrão).
    expect(marathon.expiresAt).toBe(brt(sunday, 23, 59, 59).toISOString());

    await completeContract(c, f);
    marathon = byTitle(await missionsOf(f), 'Maratona da semana');
    expect(marathon).toMatchObject({ progress: 3, completed: true });

    // O mesmo evento de novo, em sequência e em paralelo: a recontagem dá 3 e nada é creditado.
    await missionsService.evaluate(f.id, { actions: ['complete_contracts'] });
    await Promise.all(
      [1, 2, 3].map(() => missionsService.evaluate(f.id, { actions: ['complete_contracts'] })),
    );
    await missionsOf(f);

    // O primeiro aceite saiu na hora: a resposta rápida também foi cumprida, uma vez.
    expect(await missionXp(f.id)).toEqual([
      ['Resposta rápida', 100],
      ['Presença diária', 10],
      ['Maratona da semana', 200],
    ]);
    await vi.waitFor(async () =>
      expect(await noticesOf(f.id)).toEqual([
        'Missão cumprida: Resposta rápida',
        'Missão cumprida: Presença diária',
        'Missão cumprida: Maratona da semana',
      ]),
    );
  });

  it('diária: abrir as missões cumpre a presença; a meia-noite é a do fuso de cada conta', async () => {
    const sp = await freelancer('Freela de Brasília');
    const manaus = await freelancer('Freela de Manaus');
    await setZone(manaus.id, 'America/Manaus');
    const { today } = thisWeek();
    const tomorrow = addDaysToDay(today, 1);

    const first = byTitle(await missionsOf(sp), 'Presença diária');
    expect(first).toMatchObject({ progress: 1, target: 1, completed: true, type: 'daily' });
    expect(first.expiresAt).toBe(brt(today, 23, 59, 59).toISOString());
    const inManaus = byTitle(await missionsOf(manaus), 'Presença diária');
    // 23:59:59 de Manaus é 00:59:59 de Brasília do dia seguinte.
    expect(inManaus.expiresAt).toBe(brt(tomorrow, 0, 59, 59).toISOString());

    // Abrir de novo no mesmo dia não credita outra vez.
    await missionsOf(sp);
    startDaytimeClock(brt(today, 23, 59, 58));
    expect(byTitle(await missionsOf(sp), 'Presença diária').completed).toBe(true);
    expect(await missionXp(sp.id)).toEqual([['Presença diária', 10]]);

    // 00:30 de Brasília: dia novo em Brasília, ainda 23:30 de ontem em Manaus.
    startDaytimeClock(brt(tomorrow, 0, 30));
    const spNext = byTitle(await missionsOf(sp), 'Presença diária');
    expect(spNext.expiresAt).toBe(brt(tomorrow, 23, 59, 59).toISOString());
    expect(await missionXp(sp.id)).toEqual([
      ['Presença diária', 10],
      ['Presença diária', 10],
    ]);
    await missionsOf(manaus);
    expect(await missionXp(manaus.id)).toEqual([['Presença diária', 10]]);

    // 01:00:01 de Brasília é 00:00:01 em Manaus: lá o dia virou agora.
    startDaytimeClock(brt(tomorrow, 1, 0, 1));
    await missionsOf(manaus);
    expect(await missionXp(manaus.id)).toEqual([
      ['Presença diária', 10],
      ['Presença diária', 10],
    ]);
    expect((await rowsOf(sp.id, 'Presença diária')).map((r) => r.period_key)).toEqual([
      `d:${today}`,
      `d:${tomorrow}`,
    ]);
  });

  it('a semana vira no domingo 23:59:59 do fuso da conta e o progresso incompleto se perde', async () => {
    const f = await freelancer();
    const c = await client();
    const { monday, sunday } = thisWeek();
    const nextMonday = addDaysToDay(monday, 7);

    // Duas concluídas no domingo ao meio-dia: 2 de 3.
    startDaytimeClock(brt(sunday, 12));
    for (let i = 0; i < 2; i += 1) await completeContract(c, f);
    // A conta é de Manaus (uma hora atrás de Brasília).
    await setZone(f.id, 'America/Manaus');

    // 00:30 de segunda em Brasília ainda é domingo 23:30 em Manaus: a mesma semana.
    startDaytimeClock(brt(nextMonday, 0, 30));
    let marathon = byTitle(await missionsOf(f), 'Maratona da semana');
    expect(marathon).toMatchObject({ progress: 2, completed: false });
    expect(marathon.expiresAt).toBe(brt(nextMonday, 0, 59, 59).toISOString());

    // 01:00:01 de Brasília é segunda 00:00:01 em Manaus: semana nova, do zero.
    startDaytimeClock(brt(nextMonday, 1, 0, 1));
    marathon = byTitle(await missionsOf(f), 'Maratona da semana');
    expect(marathon).toMatchObject({ progress: 0, completed: false });
    expect(marathon.expiresAt).toBe(brt(addDaysToDay(nextMonday, 7), 0, 59, 59).toISOString());

    // A linha da semana passada fica como estava, incompleta, e não é mais lida.
    expect(await rowsOf(f.id, 'Maratona da semana')).toEqual([
      { period_key: `w:${monday}`, progress: 2, is_completed: 0 },
    ]);

    // Uma concluída na semana nova conta 1, e não 3.
    startDaytimeClock(brt(nextMonday, 12));
    await completeContract(c, f);
    marathon = byTitle(await missionsOf(f), 'Maratona da semana');
    expect(marathon).toMatchObject({ progress: 1, completed: false });
    expect((await missionXp(f.id)).filter(([t]) => t === 'Maratona da semana')).toEqual([]);
  });

  it('resposta rápida: aceitar ou recusar em menos de 2 horas cumpre; depois disso, não', async () => {
    const quick = await freelancer('Freela Ligeira');
    const slow = await freelancer('Freela Lenta');
    const c1 = await client();
    const c2 = await client();
    const c3 = await client();

    await accept(quick, await propose(c1, quick));
    expect(byTitle(await missionsOf(quick), 'Resposta rápida')).toMatchObject({
      progress: 1,
      target: 1,
      completed: true,
    });

    // A proposta chega agora e o aceite sai três horas depois: não conta.
    const late = await propose(c2, slow);
    startDaytimeClock(new Date(noonBrasilia().getTime() + 3 * HOUR));
    await accept(slow, late);
    expect(byTitle(await missionsOf(slow), 'Resposta rápida')).toMatchObject({
      progress: 0,
      completed: false,
    });

    // A recusa logo que a proposta chega também é resposta.
    const declined = await propose(c3, slow);
    await request(app).post(`/api/contracts/${declined}/reject`).set(auth(slow.token)).expect(200);
    expect(byTitle(await missionsOf(slow), 'Resposta rápida')).toMatchObject({
      progress: 1,
      completed: true,
    });
    expect((await missionXp(slow.id)).filter(([t]) => t === 'Resposta rápida')).toEqual([
      ['Resposta rápida', 100],
    ]);
  });

  it('conquista: a primeira troca concluída dá 150 XP às duas partes, e a segunda não dá de novo', async () => {
    const a = await freelancer('Troca A');
    const b = await freelancer('Troca B');

    await completeBarter(a, b);
    for (const who of [a, b]) {
      expect(await missionXp(who.id)).toContainEqual(['Primeira troca', 150]);
      const first = byTitle(await missionsOf(who), 'Primeira troca');
      expect(first).toMatchObject({ type: 'achievement', completed: true, expiresAt: null });
    }

    await completeBarter(a, b);
    for (const who of [a, b]) {
      expect((await missionXp(who.id)).filter(([t]) => t === 'Primeira troca')).toHaveLength(1);
    }
  });

  it('acessos simultâneos creditam a presença uma vez só', async () => {
    const f = await freelancer();
    await Promise.all([1, 2, 3, 4].map(() => missionsOf(f)));
    expect(await missionXp(f.id)).toEqual([['Presença diária', 10]]);
    expect(await rowsOf(f.id, 'Presença diária')).toHaveLength(1);
  });

  it('cliente sem perfil de freelancer e conta suspensa não têm missões nem ganham XP', async () => {
    const c = await client();
    expect(await missionsOf(c)).toEqual([]);

    const f = await freelancer();
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = :id`, { id: f.id });
    expect(await missionsOf(f)).toEqual([]);
    expect(await missionXp(f.id)).toEqual([]);
    expect(await rowsOf(f.id, 'Presença diária')).toEqual([]);
  });

  it('a 0045 roda de novo sem erro e deixa a chave única por período', async () => {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      multipleStatements: true,
    });
    try {
      await conn.query(
        readFileSync(join(__dirname, '../../db/migrations/0045_missoes_periodo.sql'), 'utf8'),
      );
      const [indexes] = await conn.query<RowDataPacket[]>(
        `SELECT index_name AS name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
           FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'user_missions' AND non_unique = 0
          GROUP BY index_name ORDER BY index_name`,
      );
      expect(indexes.map((r) => [r.name, r.cols])).toEqual([
        ['PRIMARY', 'id'],
        ['uq_user_mission_period', 'user_id,mission_id,period_key'],
      ]);
    } finally {
      await conn.end();
    }
  });
});

describe('Ranking por categoria e local (RF-067, RN-056)', () => {
  /** Um ponto longe de todo teste: só quem este arquivo põe aqui fica a 50 km dele. */
  const HERE = { lat: -12.5, lng: -55.7 };

  async function category(): Promise<{ root: number; child: number }> {
    const tag = `${Date.now()}-${seq++}`;
    const [root] = await pool.query<ResultSetHeader>(
      `INSERT INTO service_categories (parent_id, name, slug) VALUES (NULL, 'Ranking', :slug)`,
      { slug: `ranking-${tag}` },
    );
    const [child] = await pool.query<ResultSetHeader>(
      `INSERT INTO service_categories (parent_id, name, slug) VALUES (:parent, 'Sub', :slug)`,
      { parent: root.insertId, slug: `ranking-sub-${tag}` },
    );
    return { root: root.insertId, child: child.insertId };
  }

  async function ranked(
    name: string,
    stats: { rating: number; done: number; xp?: number },
    where: { lat: number; lng: number },
    categoryId?: number,
  ): Promise<Actor & { ulid: string }> {
    const f = await freelancer(name, { latitude: where.lat, longitude: where.lng });
    if (categoryId !== undefined) {
      const res = await request(app)
        .post('/api/services')
        .set(auth(f.token))
        .send({
          categoryId,
          title: `Serviço de ${name}`,
          description: 'Serviço do teste do ranking por categoria',
          priceType: 'fixed',
          price: 100,
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    await pool.query(
      'UPDATE profiles_freelancer SET avg_rating = :rating, total_contracts = :done WHERE user_id = :id',
      { rating: stats.rating, done: stats.done, id: f.id },
    );
    if (stats.xp !== undefined) {
      await pool.query(
        `INSERT INTO user_xp (user_id, total_xp) VALUES (:id, :xp)
         ON DUPLICATE KEY UPDATE total_xp = :xp`,
        { id: f.id, xp: stats.xp },
      );
    }
    const [rows] = await pool.query<RowDataPacket[]>('SELECT ulid FROM users WHERE id = :id', {
      id: f.id,
    });
    return { ...f, ulid: rows[0]!.ulid as string };
  }

  async function board(viewer: Actor, qs: string): Promise<LeaderboardEntry[]> {
    const res = await request(app)
      .get(`/api/gamification/leaderboard${qs}`)
      .set(auth(viewer.token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as LeaderboardEntry[];
  }

  it('por categoria (com as subcategorias) e por raio: nota, depois concluídas, depois XP; sem banidos nem suspensos', async () => {
    const cat = await category();
    // ~0,5 km do ponto; o "longe" fica a uns 330 km.
    const near = { lat: HERE.lat + 0.005, lng: HERE.lng };
    const far = { lat: HERE.lat - 3, lng: HERE.lng };

    const nota5 = await ranked('Nota Cinco', { rating: 5, done: 1 }, near, cat.child);
    const maisXp = await ranked('Mais XP', { rating: 4.9, done: 8, xp: 300 }, near, cat.root);
    const maisFeitos = await ranked(
      'Mais Feitos',
      { rating: 4.9, done: 8, xp: 50 },
      near,
      cat.child,
    );
    const menosFeitos = await ranked(
      'Menos Feitos',
      { rating: 4.9, done: 5, xp: 900 },
      near,
      cat.child,
    );
    const longe = await ranked('Longe', { rating: 4.8, done: 1 }, far, cat.child);
    const semServico = await ranked('Sem Serviço', { rating: 4.95, done: 2 }, near);
    const banida = await ranked('Banida', { rating: 5, done: 50, xp: 9000 }, near, cat.child);
    const suspensa = await ranked('Suspensa', { rating: 5, done: 40, xp: 8000 }, near, cat.child);
    await pool.query(`UPDATE users SET status = 'banned' WHERE id = :id`, { id: banida.id });
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = :id`, { id: suspensa.id });
    const viewer = await freelancer('Quem Olha');

    // Categoria raiz: entra quem tem serviço nela ou na subcategoria, perto ou longe.
    const byCategory = await board(viewer, `?categoryId=${cat.root}`);
    expect(byCategory.map((e) => e.userUlid)).toEqual([
      nota5.ulid,
      maisXp.ulid,
      maisFeitos.ulid,
      menosFeitos.ulid,
      longe.ulid,
    ]);
    expect(byCategory[0]).toMatchObject({
      rank: 1,
      name: 'Nota Cinco',
      avgRating: 5,
      completedContracts: 1,
      totalXp: 0,
      level: 1,
      levelName: 'Iniciante',
    });
    expect(byCategory[0]).not.toHaveProperty('distanceKm');
    // A subcategoria sozinha não tem o serviço que está na raiz.
    expect((await board(viewer, `?categoryId=${cat.child}`)).map((e) => e.userUlid)).not.toContain(
      maisXp.ulid,
    );

    // Perto de mim (raio de 50 km do seed): sai quem está longe; quem não tem serviço entra.
    const local = await board(viewer, `?lat=${HERE.lat}&lng=${HERE.lng}`);
    expect(local.map((e) => e.userUlid)).toEqual([
      nota5.ulid,
      semServico.ulid,
      maisXp.ulid,
      maisFeitos.ulid,
      menosFeitos.ulid,
    ]);
    expect(local[0]!.distanceKm).toBeLessThan(1);

    // Os dois juntos: a categoria dentro do raio.
    const both = await board(viewer, `?categoryId=${cat.root}&lat=${HERE.lat}&lng=${HERE.lng}`);
    expect(both.map((e) => e.userUlid)).toEqual([
      nota5.ulid,
      maisXp.ulid,
      maisFeitos.ulid,
      menosFeitos.ulid,
    ]);

    // O raio é o parâmetro da plataforma: com 400 km, quem está longe volta.
    await pool.query(
      `UPDATE platform_settings SET value = '400' WHERE key_name = 'ranking_radius_km'`,
    );
    try {
      const wide = await board(viewer, `?categoryId=${cat.root}&lat=${HERE.lat}&lng=${HERE.lng}`);
      expect(wide.map((e) => e.userUlid)).toContain(longe.ulid);
    } finally {
      await pool.query(
        `UPDATE platform_settings SET value = '50' WHERE key_name = 'ranking_radius_km'`,
      );
    }

    // Lat sem lng é recusado.
    const bad = await request(app)
      .get(`/api/gamification/leaderboard?lat=${HERE.lat}`)
      .set(auth(viewer.token));
    expect(bad.status).toBe(422);
  });

  it('sem filtro, o ranking geral continua por XP e com a nota e as concluídas de cada um', async () => {
    const viewer = await freelancer('Quem Olha o Geral');
    const top = await ranked('Topo do Geral', { rating: 3, done: 2, xp: 5_000_000 }, HERE);
    const general = await board(viewer, '');
    expect(general[0]).toMatchObject({
      userUlid: top.ulid,
      totalXp: 5_000_000,
      avgRating: 3,
      completedContracts: 2,
    });
    expect(general.length).toBeLessThanOrEqual(10);
    // Devolve o total ao normal: no topo, esta conta tiraria o primeiro lugar de outros testes.
    await pool.query('UPDATE user_xp SET total_xp = 0 WHERE user_id = :id', { id: top.id });
  });
});
