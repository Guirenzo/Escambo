import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { currentSlot } from '../../src/modules/profiles/availability';

/**
 * Horário de atendimento (ADR 34) contra o MySQL real: períodos por dia no perfil, busca por
 * dia + período (dia sem períodos vale o dia todo) e "atende agora" no horário de Brasília.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Freela {
  id: number;
  token: string;
  ulid: string;
  profile: Record<string, unknown>;
}

let seq = 0;
async function freelancer(profile: Record<string, unknown>): Promise<Freela> {
  const email = `int_periodo_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ email, password, role: 'freelancer' })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  const token = login.body.accessToken as string;
  const saved = await request(app)
    .put('/api/profiles/freelancer')
    .set(auth(token))
    .send({ fullName: `Período ${seq}`, city: 'Joinville', isAvailable: true, ...profile });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return { id: login.body.user.id, token, ulid: login.body.user.ulid, profile: saved.body };
}

const TAG = `periodo${Date.now()}`;

async function publish(owner: Freela, title: string): Promise<void> {
  const cats = await request(app).get('/api/categories').expect(200);
  const list = (Array.isArray(cats.body) ? cats.body : cats.body.items) as { id: number }[];
  await request(app)
    .post('/api/services')
    .set(auth(owner.token))
    .send({
      categoryId: list[0]!.id,
      title: `${TAG} ${title}`,
      description: 'Serviço usado para testar horário de atendimento',
      priceType: 'fixed',
      price: 100,
    })
    .expect(201);
}

interface Item {
  title: string;
  ownerAvailablePeriods: Record<string, string[]> | null;
  ownerAvailableNow: boolean;
}
const search = (query: string) => request(app).get(`/api/services?q=${TAG}&limit=50${query}`);
const titles = (res: request.Response): string[] =>
  (res.body.items as Item[]).map((i) => i.title.replace(`${TAG} `, '')).sort();
const on = (days: number[], periods: string[]) =>
  Object.fromEntries(days.map((d) => [String(d), periods]));

afterAll(async () => {
  await pool.end();
});

describe('Horário de atendimento (ADR 34)', () => {
  it('perfil: períodos normalizados pelos dias marcados, validação e perfil público', async () => {
    const f = await freelancer({
      availableDays: [5, 1, 3],
      availablePeriods: {
        '1': ['afternoon', 'morning', 'morning'],
        '3': ['morning', 'afternoon', 'evening'], // os três = o dia todo
        '2': ['evening'], // dia não marcado
      },
    });
    expect(f.profile.availablePeriods).toEqual({ '1': ['morning', 'afternoon'] });
    expect(typeof f.profile.availableNow).toBe('boolean');

    const bad = (availablePeriods: unknown) =>
      request(app)
        .put('/api/profiles/freelancer')
        .set(auth(f.token))
        .send({ fullName: 'Período', availableDays: [1], availablePeriods });
    expect((await bad({ '1': ['madrugada'] })).status).toBe(422);
    expect((await bad({ '7': ['morning'] })).status).toBe(422);

    const pub = await request(app).get(`/api/profiles/freelancer/${f.ulid}`).expect(200);
    expect(pub.body.availablePeriods).toEqual({ '1': ['morning', 'afternoon'] });

    // Sem dias, períodos não têm onde ficar.
    const cleared = await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.token))
      .send({ fullName: 'Período', availableDays: null, availablePeriods: { '1': ['morning'] } })
      .expect(200);
    expect(cleared.body.availablePeriods).toBeNull();
    expect(cleared.body.availableNow).toBe(false);
  });

  it('busca: período só junto com o dia; dia sem períodos vale o dia todo', async () => {
    const weekdays = [1, 2, 3, 4, 5];
    const morning = await freelancer({
      availableDays: weekdays,
      availablePeriods: on(weekdays, ['morning']),
    });
    const allDay = await freelancer({ availableDays: weekdays, availablePeriods: null });
    const saturdayNight = await freelancer({
      availableDays: [6],
      availablePeriods: on([6], ['evening']),
    });
    await publish(morning, 'manhã');
    await publish(allDay, 'dia todo');
    await publish(saturdayNight, 'sábado noite');

    expect(titles(await search('&day=1&period=morning').expect(200))).toEqual([
      'dia todo',
      'manhã',
    ]);
    expect(titles(await search('&day=1&period=evening').expect(200))).toEqual(['dia todo']);
    expect(titles(await search('&day=6&period=evening').expect(200))).toEqual(['sábado noite']);
    expect(titles(await search('&day=6&period=morning').expect(200))).toEqual([]);

    const noDay = await search('&period=morning');
    expect(noDay.status).toBe(422);
    expect(noDay.body.error).toBe('period_requires_day');
    await search('&day=1&period=madrugada').expect(422);

    const all = (await search('').expect(200)).body.items as Item[];
    const card = all.find((i) => i.title.endsWith('manhã'))!;
    expect(card.ownerAvailablePeriods).toEqual(on(weekdays, ['morning']));
  });

  it('atende agora: só quem aceita pedidos, no dia e no período de agora (Brasília)', async () => {
    const slot = currentSlot();
    const nowPeriod = slot.period ?? 'morning';
    const otherPeriod = nowPeriod === 'evening' ? 'morning' : 'evening';
    const tomorrow = (slot.day + 1) % 7;

    const now = await freelancer({
      availableDays: [slot.day],
      availablePeriods: on([slot.day], [nowPeriod]),
    });
    const paused = await freelancer({
      isAvailable: false,
      availableDays: [slot.day],
      availablePeriods: null,
    });
    const otherDay = await freelancer({ availableDays: [tomorrow], availablePeriods: null });
    const otherTime = await freelancer({
      availableDays: [slot.day],
      availablePeriods: on([slot.day], [otherPeriod]),
    });
    await publish(now, 'agora');
    await publish(paused, 'pausado');
    await publish(otherDay, 'amanhã');
    await publish(otherTime, 'outro período');

    const res = await search('&now=true').expect(200);
    const all = (await search('').expect(200)).body.items as Item[];
    const pub = await request(app).get(`/api/profiles/freelancer/${now.ulid}`).expect(200);
    const pubPaused = await request(app).get(`/api/profiles/freelancer/${paused.ulid}`).expect(200);

    // Virou o período (ou o dia) no meio do teste: as leituras acima não são comparáveis.
    const after = currentSlot();
    if (after.day !== slot.day || after.period !== slot.period) return;

    const expectNow = slot.period !== null; // de madrugada ninguém atende agora
    expect(titles(res)).toEqual(expectNow ? ['agora'] : []);
    expect(all.find((i) => i.title.endsWith('agora'))!.ownerAvailableNow).toBe(expectNow);
    expect(all.find((i) => i.title.endsWith('pausado'))!.ownerAvailableNow).toBe(false);
    expect(pub.body.availableNow).toBe(expectNow);
    expect(pubPaused.body.availableNow).toBe(false);
  });
});
