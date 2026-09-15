import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { lastDailyAlertAt, runSavedSearchAlerts } from '../../src/jobs/saved-search-alerts';

/**
 * Buscas salvas com alerta (ADR 35 e 37) contra o MySQL real: validação e limite, PATCH, dono,
 * frequência (na hora, de hora em hora, uma vez por dia) e o job
 * avisando uma vez só com os serviços novos que casam — sem os do próprio dono — com o cursor
 * avançando. O job roda com "agora" no futuro para a hora do alerta já ter vencido.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const HOUR = 3_600_000;
const inHours = (h: number): Date => new Date(Date.now() + h * HOUR);

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function actor(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `int_alerta_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app).post('/api/auth/register').send({ email, password, role }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  const a = { id: login.body.user.id as number, token: login.body.accessToken as string };
  if (role === 'freelancer') {
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(a.token))
      .send({ fullName: `Alerta ${seq}`, city: 'Joinville' })
      .expect(200);
  }
  return a;
}

async function publish(owner: Actor, title: string, price: number): Promise<void> {
  const cats = await request(app).get('/api/categories').expect(200);
  const list = (Array.isArray(cats.body) ? cats.body : cats.body.items) as { id: number }[];
  await request(app)
    .post('/api/services')
    .set(auth(owner.token))
    .send({
      categoryId: list[0]!.id,
      title,
      description: 'Serviço usado para testar alertas de busca salva',
      priceType: 'fixed',
      price,
    })
    .expect(201);
}

interface Note {
  type: string;
  title: string;
  body: string | null;
  data: { savedSearchId?: number; serviceIds?: number[] } | null;
}
async function alertsFor(token: string, savedSearchId: number): Promise<Note[]> {
  const res = await request(app).get('/api/notifications').set(auth(token)).expect(200);
  return (res.body.items as Note[]).filter(
    (n) => n.type === 'saved_search_match' && n.data?.savedSearchId === savedSearchId,
  );
}

const save = (token: string, body: Record<string, unknown>) =>
  request(app).post('/api/saved-searches').set(auth(token)).send(body);

afterAll(async () => {
  await pool.end();
});

describe('Buscas salvas com alerta (ADR 35)', () => {
  it('CRUD: filtros validados, 20 por conta, PATCH liga/desliga e renomeia, só o dono mexe', async () => {
    const u = await actor('client');
    const other = await actor('client');

    expect((await save(u.token, { query: '   ', filters: {} })).status).toBe(422);
    expect((await save(u.token, { query: 'x', filters: { foo: 1 } })).status).toBe(422);
    expect((await save(u.token, { filters: { period: 'morning' } })).status).toBe(422);

    const created = await save(u.token, {
      name: 'Logo barato',
      query: 'logo',
      filters: { maxPrice: 500, day: 1, period: 'morning' },
      alertEnabled: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Logo barato',
      query: 'logo',
      filters: { maxPrice: 500, day: 1, period: 'morning' },
      alertEnabled: true,
      alertFrequency: 'hourly',
    });
    expect(typeof created.body.lastAlertAt).toBe('string');
    const id = created.body.id as number;
    expect((await save(u.token, { query: 'x', alertFrequency: 'weekly' })).status).toBe(422);

    const patch = (token: string, body: Record<string, unknown>) =>
      request(app).patch(`/api/saved-searches/${id}`).set(auth(token)).send(body);
    expect((await patch(other.token, { alertEnabled: false })).status).toBe(404);
    expect((await patch(u.token, {})).status).toBe(422);
    expect((await patch(u.token, { alertEnabled: false }).expect(200)).body.alertEnabled).toBe(
      false,
    );
    expect((await patch(u.token, { name: 'Logo até 500' }).expect(200)).body.name).toBe(
      'Logo até 500',
    );

    // Frequência (ADR 37): trocar não mexe no cursor; nome null volta a mostrar o texto.
    const before = (await patch(u.token, { alertEnabled: true }).expect(200)).body.lastAlertAt;
    expect((await patch(u.token, { alertFrequency: 'daily' }).expect(200)).body).toMatchObject({
      alertEnabled: true,
      alertFrequency: 'daily',
      lastAlertAt: before,
    });
    expect((await patch(u.token, { alertFrequency: 'weekly' })).status).toBe(422);
    expect((await patch(u.token, { name: null }).expect(200)).body).toMatchObject({
      name: null,
      query: 'logo',
      alertFrequency: 'daily',
    });

    for (let i = 1; i < 20; i++) await save(u.token, { query: `busca ${i}` }).expect(201);
    const full = await save(u.token, { query: 'a vigésima primeira' });
    expect(full.status).toBe(409);
    expect(full.body.error).toBe('saved_search_limit');
    const list = await request(app).get('/api/saved-searches').set(auth(u.token)).expect(200);
    expect(list.body).toHaveLength(20);

    await request(app).delete(`/api/saved-searches/${id}`).set(auth(other.token)).expect(404);
    await request(app).delete(`/api/saved-searches/${id}`).set(auth(u.token)).expect(204);
  });

  it('job: um aviso com os serviços novos que casam (sem os do dono); cursor avança e não repete', async () => {
    const searcher = await actor('freelancer');
    const freela = await actor('freelancer');
    const TAG = `alerta${Date.now()}`;

    const withAlert = (
      await save(searcher.token, { query: TAG, filters: { maxPrice: 500 }, alertEnabled: true })
    ).body as { id: number };
    const noAlert = (await save(searcher.token, { name: 'sem alerta', query: TAG })).body as {
      id: number;
    };
    await publish(freela, `${TAG} barato`, 200);
    await publish(freela, `${TAG} caro`, 900); // fora do preço
    await publish(searcher, `${TAG} meu`, 100); // do próprio dono

    const first = await runSavedSearchAlerts(inHours(1.1));
    expect(first.alerted).toContain(withAlert.id);
    expect(first.alerted).not.toContain(noAlert.id);
    const notes = await alertsFor(searcher.token, withAlert.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: `Serviço novo para “${TAG}”`, body: `${TAG} barato` });
    expect(notes[0]!.data!.serviceIds).toHaveLength(1);

    // Logo depois ainda não venceu a hora; mais tarde, a janela nova não tem serviço novo.
    expect((await runSavedSearchAlerts(inHours(1.2))).alerted).not.toContain(withAlert.id);
    expect((await runSavedSearchAlerts(inHours(2.3))).alerted).not.toContain(withAlert.id);
    expect(await alertsFor(searcher.token, withAlert.id)).toHaveLength(1);

    const [rows] = await pool.query('SELECT last_alert_at FROM saved_searches WHERE id = ?', [
      withAlert.id,
    ]);
    const cursor = new Date((rows as { last_alert_at: Date }[])[0]!.last_alert_at);
    expect(cursor.getTime()).toBeGreaterThan(Date.now() + 2 * HOUR);
  });

  it('frequência: "na hora" avisa na rodada seguinte e "de hora em hora" espera a hora', async () => {
    const searcher = await actor('client');
    const freela = await actor('freelancer');
    const TAG = `freq${Date.now()}`;
    const instant = (
      await save(searcher.token, { query: TAG, alertEnabled: true, alertFrequency: 'instant' })
    ).body as { id: number; alertFrequency: string };
    const hourly = (
      await save(searcher.token, { name: `${TAG} hora`, query: TAG, alertEnabled: true })
    ).body as { id: number; alertFrequency: string };
    expect([instant.alertFrequency, hourly.alertFrequency]).toEqual(['instant', 'hourly']);
    await publish(freela, `${TAG} novo`, 300);

    // Uma rodada dos jobs depois (5 min): só a "na hora" avisa.
    const soon = await runSavedSearchAlerts(new Date(Date.now() + 5 * 60_000));
    expect(soon.alerted).toContain(instant.id);
    expect(soon.alerted).not.toContain(hourly.id);

    // Passada a hora: a de hora em hora avisa, e a "na hora" não repete o mesmo serviço.
    const later = await runSavedSearchAlerts(inHours(1.1));
    expect(later.alerted).toContain(hourly.id);
    expect(later.alerted).not.toContain(instant.id);
    expect(await alertsFor(searcher.token, instant.id)).toHaveLength(1);
    expect(await alertsFor(searcher.token, hourly.id)).toHaveLength(1);
  });

  it('frequência: "uma vez por dia" só avisa no horário do resumo diário, com título de resumo', async () => {
    const searcher = await actor('client');
    const freela = await actor('freelancer');
    const TAG = `diario${Date.now()}`;
    const daily = (
      await save(searcher.token, { query: TAG, alertEnabled: true, alertFrequency: 'daily' })
    ).body as { id: number; lastAlertAt: string };
    await publish(freela, `${TAG} novo`, 300);

    // Primeiro horário diário depois do cursor: um minuto antes não vence; um minuto depois, sim.
    const next = new Date(lastDailyAlertAt(new Date(daily.lastAlertAt)).getTime() + 24 * HOUR);
    const early = await runSavedSearchAlerts(new Date(next.getTime() - 60_000));
    expect(early.alerted).not.toContain(daily.id);
    const onTime = await runSavedSearchAlerts(new Date(next.getTime() + 60_000));
    expect(onTime.alerted).toContain(daily.id);
    const notes = await alertsFor(searcher.token, daily.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: `Resumo do dia: serviço novo para “${TAG}”` });
  });
});
