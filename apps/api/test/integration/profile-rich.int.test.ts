import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/** Perfil mais rico: dias de atendimento, portfólio (CRUD, limite, dono) e perfil público. */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  ulid: string;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `int_rich_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  return { id: login.body.user.id, ulid: login.body.user.ulid, token: login.body.accessToken };
}

const IMG = 'https://img.escambo.test/trabalho.png';

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('Perfil do freelancer: dias de atendimento e portfólio', () => {
  it('dias salvos e normalizados; portfólio com validação, limite, dono e exposição pública', async () => {
    const f = await registerAndLogin('freelancer');
    const other = await registerAndLogin('freelancer');
    const client = await registerAndLogin('client');

    // Sem perfil de freelancer ainda: portfólio recusa com 409.
    await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(f.token))
      .send({ title: 'Antes do perfil', externalUrl: 'https://exemplo.test' })
      .expect(409);

    const saved = await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.token))
      .send({ fullName: 'Freela Rico', city: 'Joinville', availableDays: [5, 1, 1, 3] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.availableDays).toEqual([1, 3, 5]);
    expect(saved.body.responseTimeHours).toBeNull();
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(f.token))
      .send({ fullName: 'Freela Rico', availableDays: [7] })
      .expect(422);

    // Portfólio: item precisa de imagem ou link; URL inválida cai na validação.
    await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(f.token))
      .send({ title: 'Sem nada' })
      .expect(422);
    await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(f.token))
      .send({ title: 'Imagem torta', imageUrl: 'nao-e-url' })
      .expect(422);
    const one = await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(f.token))
      .send({ title: 'Site da padaria', description: 'React + CMS', imageUrl: IMG });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(one.body).toHaveLength(1);
    const two = await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(f.token))
      .send({ title: 'App da academia', externalUrl: 'https://app.exemplo.test' });
    expect(two.body).toHaveLength(2);
    const [a, b] = two.body as { id: number; title: string; sortOrder: number }[];
    expect(a!.sortOrder).toBeLessThan(b!.sortOrder);

    // Editar o meu; o de outro é 404 (não vaza nem altera).
    const edited = await request(app)
      .put(`/api/profiles/portfolio/${a!.id}`)
      .set(auth(f.token))
      .send({ title: 'Site da padaria (2026)', imageUrl: IMG });
    expect(edited.status).toBe(200);
    expect((edited.body as { title: string }[])[0]!.title).toBe('Site da padaria (2026)');
    await request(app)
      .put(`/api/profiles/freelancer`)
      .set(auth(other.token))
      .send({ fullName: 'Outro' })
      .expect(200);
    await request(app)
      .put(`/api/profiles/portfolio/${a!.id}`)
      .set(auth(other.token))
      .send({ title: 'Invasão', imageUrl: IMG })
      .expect(404);
    await request(app)
      .delete(`/api/profiles/portfolio/${a!.id}`)
      .set(auth(other.token))
      .expect(404);

    // Público: portfólio, dias e tempo de resposta saem no perfil por ulid (sem login).
    const pub = await request(app).get(`/api/profiles/freelancer/${f.ulid}`);
    expect(pub.status).toBe(200);
    expect(pub.body.availableDays).toEqual([1, 3, 5]);
    expect(pub.body.responseTimeHours).toBeNull();
    expect((pub.body.portfolio as { title: string }[]).map((i) => i.title)).toEqual([
      'Site da padaria (2026)',
      'App da academia',
    ]);
    expect(
      (await request(app).get('/api/profiles/portfolio').set(auth(client.token))).body,
    ).toEqual([]);

    // Limite de 12 itens.
    for (let i = 3; i <= 12; i++) {
      await request(app)
        .post('/api/profiles/portfolio')
        .set(auth(f.token))
        .send({ title: `Trabalho ${i}`, externalUrl: `https://exemplo.test/${i}` })
        .expect(201);
    }
    const full = await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(f.token))
      .send({ title: 'Décimo terceiro', externalUrl: 'https://exemplo.test/13' });
    expect(full.status).toBe(409);
    expect(full.body.error).toBe('portfolio_full');

    // Remover libera espaço.
    const removed = await request(app)
      .delete(`/api/profiles/portfolio/${b!.id}`)
      .set(auth(f.token));
    expect(removed.status).toBe(200);
    expect(removed.body).toHaveLength(11);
  });

  it('ordem do portfólio: grava todas as posições, sai no perfil público e recusa lista diferente (ADR 43)', async () => {
    const f = await registerAndLogin('freelancer');
    const other = await registerAndLogin('freelancer');
    for (const a of [f, other]) {
      await request(app)
        .put('/api/profiles/freelancer')
        .set(auth(a.token))
        .send({ fullName: 'Freela Ordem' })
        .expect(200);
    }
    const put = (a: Actor, ids: unknown) =>
      request(app).put('/api/profiles/portfolio/order').set(auth(a.token)).send({ ids });
    let list: { id: number; title: string }[] = [];
    for (const title of ['Logo', 'Site', 'Cardápio']) {
      const res = await request(app)
        .post('/api/profiles/portfolio')
        .set(auth(f.token))
        .send({ title, externalUrl: `https://exemplo.test/${title.length}` })
        .expect(201);
      list = res.body;
    }
    const id = (title: string): number => list.find((i) => i.title === title)!.id;

    const reordered = await put(f, [id('Cardápio'), id('Logo'), id('Site')]);
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    expect(
      (reordered.body as { title: string; sortOrder: number }[]).map((i) => [i.title, i.sortOrder]),
    ).toEqual([
      ['Cardápio', 1],
      ['Logo', 2],
      ['Site', 3],
    ]);
    const pub = await request(app).get(`/api/profiles/freelancer/${f.ulid}`).expect(200);
    expect((pub.body.portfolio as { title: string }[]).map((i) => i.title)).toEqual([
      'Cardápio',
      'Logo',
      'Site',
    ]);

    // Lista que não bate com o portfólio de agora (faltando ou com trabalho de outro) não grava.
    const foreign = await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(other.token))
      .send({ title: 'Alheio', externalUrl: 'https://exemplo.test/alheio' })
      .expect(201);
    const foreignId = (foreign.body as { id: number }[])[0]!.id;
    for (const ids of [
      [id('Logo'), id('Site')],
      [id('Logo'), id('Site'), id('Cardápio'), foreignId],
    ]) {
      const res = await put(f, ids);
      expect([res.status, res.body.error], JSON.stringify(ids)).toEqual([
        409,
        'portfolio_order_mismatch',
      ]);
    }
    for (const ids of [[], [id('Logo'), id('Logo'), id('Site')], 'x', [0]]) {
      expect((await put(f, ids)).status, JSON.stringify(ids)).toBe(422);
    }
    await request(app)
      .put('/api/profiles/portfolio/order')
      .send({ ids: [1] })
      .expect(401);
    const unchanged = await request(app).get('/api/profiles/portfolio').set(auth(f.token));
    expect((unchanged.body as { title: string }[]).map((i) => i.title)).toEqual([
      'Cardápio',
      'Logo',
      'Site',
    ]);

    // Trabalho novo entra no fim, sem mexer na ordem escolhida.
    const added = await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(f.token))
      .send({ title: 'Fachada', externalUrl: 'https://exemplo.test/fachada' })
      .expect(201);
    expect((added.body as { title: string }[]).map((i) => i.title)).toEqual([
      'Cardápio',
      'Logo',
      'Site',
      'Fachada',
    ]);
  });
});
