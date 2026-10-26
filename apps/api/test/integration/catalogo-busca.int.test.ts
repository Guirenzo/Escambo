import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { serviceViews, VIEW_WINDOW_MS } from '../../src/modules/services/service-views';
import { setClockForTests } from '../../src/utils/clock';

/**
 * Catálogo e busca (1.44.0) contra o MySQL real: tags no serviço (RF-024, limites da RN-018),
 * visualizações do detalhe (RF-029), a modalidade "remoto e presencial" (RF-023, migration 0035)
 * e a busca de texto pelo FULLTEXT ft_svc_search (RNF-004/RNF-022: prefixo, palavra curta, palavra
 * vazia, tag e operadores que não passam).
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

interface Item {
  id: number;
  title: string;
  isRemote: boolean;
  modality: string;
  tags: string[];
  viewsCount?: number;
  boosted?: boolean;
}

/**
 * Palavra única desta execução: as buscas só acham o que este arquivo publicou. Só dígitos depois
 * do "cat": em base 36 ela podia conter "js" ou "ux", e a busca por "contém" achava tudo.
 */
const RUN = `cat${Date.now()}`;

let seq = 0;
async function register(role: 'freelancer' | 'client', fullName: string): Promise<Actor> {
  const email = `int_catalogo_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  const actor = { id: login.body.user.id as number, token: login.body.accessToken as string };
  if (role === 'freelancer') {
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(actor.token))
      .send({ fullName, city: 'Joinville', isAvailable: true })
      .expect(200);
  }
  return actor;
}

let categoryId = 0;
async function publish(owner: Actor, body: Record<string, unknown>): Promise<Item> {
  const res = await request(app)
    .post('/api/services')
    .set(auth(owner.token))
    .send({
      categoryId,
      description: 'Serviço do teste de catálogo e busca.',
      priceType: 'negotiable',
      price: null,
      ...body,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Item;
}

const search = async (query: string): Promise<Item[]> => {
  const res = await request(app).get(`/api/services?limit=100&${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as Item[];
};
const titles = async (query: string): Promise<string[]> =>
  (await search(query)).map((s) => s.title).sort();
const q = (text: string): string => `q=${encodeURIComponent(text)}`;

let dono: Actor;

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
  const cats = await request(app).get('/api/categories');
  categoryId = cats.body[0].id as number;
  dono = await register('freelancer', 'Dona do Catálogo');
});

afterEach(() => {
  setClockForTests(null);
  serviceViews.clear();
});

afterAll(async () => {
  await pool.end();
});

describe('Tags no serviço (RF-024, RN-018)', () => {
  it('cadastro grava normalizadas; detalhe, busca e "meus serviços" devolvem em ordem alfabética', async () => {
    const created = await publish(dono, {
      title: `${RUN} Identidade visual`,
      tags: ['  Logo  Vetorial ', 'FIGMA', `Tagx${RUN}`],
    });
    const expected = ['figma', 'logo vetorial', `tagx${RUN}`].sort();
    expect(created.tags).toEqual(expected);

    const detail = await request(app).get(`/api/services/${created.id}`).expect(200);
    expect(detail.body.tags).toEqual(expected);
    const card = (await search(q(`${RUN} identidade`))).find((s) => s.id === created.id);
    expect(card?.tags).toEqual(expected);
    const mine = await request(app).get('/api/services/mine').set(auth(dono.token)).expect(200);
    expect((mine.body as Item[]).find((s) => s.id === created.id)?.tags).toEqual(expected);
  });

  it('limites: 10 passam e 11 não; 2 e 30 caracteres passam, 1 e 31 não; repetida sem caixa e sem acento não', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `t${i}${RUN}`.slice(0, 30));
    const ok = await publish(dono, { title: `${RUN} Dez tags`, tags: ten });
    expect(ok.tags).toHaveLength(10);
    await publish(dono, { title: `${RUN} Bordas`, tags: ['ab', 'x'.repeat(30)] });

    for (const tags of [
      [...ten, 'mais uma'],
      ['a'],
      ['x'.repeat(31)],
      ['React', 'react'],
      ['Programação', 'programacao'],
    ]) {
      const res = await request(app)
        .post('/api/services')
        .set(auth(dono.token))
        .send({
          categoryId,
          title: `${RUN} Recusado`,
          description: 'Não deve ser gravado.',
          priceType: 'negotiable',
          tags,
        });
      expect(res.status, JSON.stringify(tags)).toBe(422);
      expect(Object.keys(res.body.details)).toEqual(['tags']);
    }
    const mine = await request(app).get('/api/services/mine').set(auth(dono.token)).expect(200);
    expect((mine.body as Item[]).some((s) => s.title === `${RUN} Recusado`)).toBe(false);
  });

  it('a mesma tag (pela collation, sem caixa e sem acento) é reaproveitada entre serviços', async () => {
    const word = `edição${RUN}`.slice(0, 30);
    const a = await publish(dono, { title: `${RUN} Vídeo A`, tags: [word] });
    const b = await publish(dono, {
      title: `${RUN} Vídeo B`,
      tags: [word.replace('ç', 'c').replace('ã', 'a').toUpperCase()],
    });
    // O nome gravado é o da primeira vez, com acento.
    expect(b.tags).toEqual([word]);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT stp.tag_id) AS n FROM service_tag_pivot stp WHERE stp.service_id IN (:ids)`,
      { ids: [a.id, b.id] },
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('na edição, a lista substitui a anterior; [] tira todas; sem o campo, nada muda', async () => {
    const svc = await publish(dono, { title: `${RUN} Editável`, tags: ['antiga', 'fica'] });
    const patch = (body: Record<string, unknown>) =>
      request(app).patch(`/api/services/${svc.id}`).set(auth(dono.token)).send(body);

    expect((await patch({ tags: ['fica', 'Nova'] }).expect(200)).body.tags).toEqual([
      'fica',
      'nova',
    ]);
    expect((await patch({ title: `${RUN} Editado` }).expect(200)).body.tags).toEqual([
      'fica',
      'nova',
    ]);
    expect((await patch({ tags: [] }).expect(200)).body.tags).toEqual([]);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM service_tag_pivot WHERE service_id = :id',
      { id: svc.id },
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('Visualizações do detalhe (RF-029)', () => {
  it('o dono não conta; o mesmo visitante conta uma vez a cada 30 min; o número só sai para o dono', async () => {
    const cliente = await register('client', 'Quem Visita');
    const svc = await publish(dono, { title: `${RUN} Contado` });
    const views = async (): Promise<number | undefined> => {
      const mine = await request(app).get('/api/services/mine').set(auth(dono.token)).expect(200);
      return (mine.body as Item[]).find((s) => s.id === svc.id)?.viewsCount;
    };
    const [before] = await pool.query<RowDataPacket[]>(
      'SELECT updated_at FROM services WHERE id = :id',
      { id: svc.id },
    );

    // O dono abrindo o próprio serviço (com o token) não conta.
    await request(app).get(`/api/services/${svc.id}`).set(auth(dono.token)).expect(200);
    expect(await views()).toBe(0);

    // Anônimo (o IP) conta uma vez; recarregar não conta.
    await request(app).get(`/api/services/${svc.id}`).expect(200);
    await request(app).get(`/api/services/${svc.id}`).expect(200);
    expect(await views()).toBe(1);

    // Outra conta conta à parte, também uma vez.
    await request(app).get(`/api/services/${svc.id}`).set(auth(cliente.token)).expect(200);
    await request(app).get(`/api/services/${svc.id}`).set(auth(cliente.token)).expect(200);
    expect(await views()).toBe(2);

    // Passada a janela, a mesma visita conta de novo.
    setClockForTests(new Date(Date.now() + VIEW_WINDOW_MS + 60_000));
    await request(app).get(`/api/services/${svc.id}`).expect(200);
    expect(await views()).toBe(3);

    // Nunca na rota pública: nem no detalhe, nem na busca.
    const detail = await request(app).get(`/api/services/${svc.id}`).expect(200);
    expect(detail.body).not.toHaveProperty('viewsCount');
    const cards = await search(q(`${RUN} contado`));
    expect(cards.map((s) => s.id)).toContain(svc.id);
    for (const card of cards) expect(card).not.toHaveProperty('viewsCount');

    // Ser visto não é editar: updated_at fica como estava.
    const [after] = await pool.query<RowDataPacket[]>(
      'SELECT updated_at, views_count FROM services WHERE id = :id',
      { id: svc.id },
    );
    expect(after[0]!.updated_at).toEqual(before[0]!.updated_at);
    expect(Number(after[0]!.views_count)).toBe(3);
  });

  it('serviço inexistente é 404 e não conta nada', async () => {
    await request(app).get('/api/services/999999999').expect(404);
    expect(serviceViews.size()).toBe(0);
  });
});

describe('Modalidade "remoto e presencial" (RF-023, 0035)', () => {
  it('a coluna is_onsite existe, NOT NULL, com o DEFAULT (1 - is_remote) para quem grava só is_remote', async () => {
    const [cols] = await pool.query<RowDataPacket[]>(
      `SELECT c.column_type AS type, c.is_nullable AS nullable, c.column_default AS def,
              prev.column_name AS after
         FROM information_schema.columns c
         JOIN information_schema.columns prev
           ON prev.table_schema = c.table_schema AND prev.table_name = c.table_name
          AND prev.ordinal_position = c.ordinal_position - 1
        WHERE c.table_schema = DATABASE() AND c.table_name = 'services'
          AND c.column_name = 'is_onsite'`,
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ type: 'tinyint(1)', nullable: 'NO', after: 'is_remote' });
    expect(String(cols[0]!.def)).toMatch(/1\s*-\s*`?is_remote`?/);

    // Quem grava direto, sem a coluna nova (scripts antigos), continua coerente.
    const insert = async (isRemote: number): Promise<number> => {
      const [res] = await pool.query<import('mysql2').ResultSetHeader>(
        `INSERT INTO services (user_id, category_id, title, description, is_remote)
         VALUES (:userId, :categoryId, :title, 'Gravado direto no banco.', :isRemote)`,
        { userId: dono.id, categoryId, title: `${RUN} Legado ${isRemote}`, isRemote },
      );
      return res.insertId;
    };
    const remote = await insert(1);
    const onsite = await insert(0);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, is_remote, is_onsite FROM services WHERE id IN (:ids) ORDER BY id',
      { ids: [remote, onsite] },
    );
    expect(rows.map((r) => [Number(r.is_remote), Number(r.is_onsite)])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    // E a API lê como remoto e presencial.
    const legacy = await request(app).get(`/api/services/${remote}`).expect(200);
    expect(legacy.body).toMatchObject({ isRemote: true, modality: 'remote' });
    await pool.query('DELETE FROM services WHERE id IN (:ids)', { ids: [remote, onsite] });
  });

  it('"os dois" aparece no filtro remoto e no presencial; o isRemote antigo segue valendo', async () => {
    const owner = await register('freelancer', 'Quem Atende');
    const both = await publish(owner, { title: `${RUN} Ambos`, modality: 'both' });
    const remote = await publish(owner, { title: `${RUN} Remoto`, isRemote: true });
    const onsite = await publish(owner, { title: `${RUN} Presencial`, isRemote: false });
    const legacyDefault = await publish(owner, { title: `${RUN} Padrão` });

    expect(both).toMatchObject({ modality: 'both', isRemote: true });
    expect(remote).toMatchObject({ modality: 'remote', isRemote: true });
    expect(onsite).toMatchObject({ modality: 'onsite', isRemote: false });
    // Sem nada, como antes: presencial.
    expect(legacyDefault).toMatchObject({ modality: 'onsite', isRemote: false });

    const mineOnly = `ownerId=${owner.id}`;
    expect(await titles(`${mineOnly}&isRemote=true`)).toEqual(
      [`${RUN} Ambos`, `${RUN} Remoto`].sort(),
    );
    expect(await titles(`${mineOnly}&isRemote=false`)).toEqual(
      [`${RUN} Ambos`, `${RUN} Padrão`, `${RUN} Presencial`].sort(),
    );
    expect(await titles(mineOnly)).toHaveLength(4);

    // Editar: o isRemote antigo vira só remoto; a modality volta a "os dois".
    const edited = await request(app)
      .patch(`/api/services/${both.id}`)
      .set(auth(owner.token))
      .send({ isRemote: true })
      .expect(200);
    expect(edited.body).toMatchObject({ modality: 'remote', isRemote: true });
    const back = await request(app)
      .patch(`/api/services/${both.id}`)
      .set(auth(owner.token))
      .send({ modality: 'both' })
      .expect(200);
    expect(back.body.modality).toBe('both');
    expect(await titles(`${mineOnly}&isRemote=false`)).toContain(`${RUN} Ambos`);
  });
});

describe('Busca de texto pelo FULLTEXT (RNF-004, RNF-022)', () => {
  let owner: Actor;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    owner = await register('freelancer', 'Quem Busca');
    const make = async (key: string, title: string, description: string, tags: string[] = []) => {
      ids[key] = (await publish(owner, { title, description, tags })).id;
    };
    await make('designer', `${RUN} Designer de interfaces`, 'Telas para aplicativos e sites.');
    await make('ux', `${RUN} Pesquisa UX`, 'Entrevistas e testes com usuários.');
    await make('aulas', `${RUN} Aulas de inglês`, 'Conversação para iniciantes.');
    await make('programacao', `${RUN} Programação web`, 'Sites com Node.js e React.');
    await make('tag', `${RUN} Serviço sem a palavra`, 'Descrição neutra.', [`zeta${RUN}`]);
  });

  const found = async (text: string): Promise<string[]> => {
    const items = await search(`${q(text)}&ownerId=${owner.id}`);
    return Object.entries(ids)
      .filter(([, id]) => items.some((s) => s.id === id))
      .map(([key]) => key)
      .sort();
  };

  it('cada palavra vale como prefixo e todas são obrigatórias', async () => {
    expect(await found(`${RUN} desig`)).toEqual(['designer']);
    expect(await found(`${RUN} interf telas`)).toEqual(['designer']);
    expect(await found(`${RUN} designer inexistentezz`)).toEqual([]);
  });

  it('palavra curta demais para o índice (min token 3) vale como "contém", sozinha ou junto', async () => {
    expect(await found(`${RUN} ux`)).toEqual(['ux']);
    expect(await found('ux')).toEqual(['ux']);
    expect(await found('js')).toEqual(['programacao']);
  });

  it('palavra vazia (de, para) não zera a busca; acento e caixa não importam', async () => {
    expect(await found(`${RUN} aulas de inglês para`)).toEqual(['aulas']);
    expect(await found(`${RUN} INGLES`)).toEqual(['aulas']);
    expect(await found(`${RUN} programacao`)).toEqual(['programacao']);
  });

  it('acha pela tag (o nome começa com o texto), mesmo sem a palavra no título nem na descrição', async () => {
    expect(await found(`zeta${RUN}`)).toEqual(['tag']);
    expect(await found(`ZETA${RUN}`.slice(0, 8))).toEqual(['tag']);
  });

  it('operadores do BOOLEAN MODE e curingas do LIKE não quebram a busca nem viram operador', async () => {
    for (const text of [
      '+-"()~*@<>',
      `"${RUN}" -designer`,
      '100%_',
      `${RUN} (designer`,
      "d'água",
    ]) {
      const res = await request(app).get(`/api/services?${q(text)}&ownerId=${owner.id}`);
      expect(res.status, text).toBe(200);
    }
    // "-designer" não exclui: o hífen é separador, e designer continua obrigatória.
    expect(await found(`${RUN} -designer`)).toEqual(['designer']);
  });

  it('com texto, a relevância continua a da RN-019: impulsionado primeiro, depois o mais novo', async () => {
    const [plans] = await pool.query<RowDataPacket[]>('SELECT id FROM boost_plans LIMIT 1');
    await pool.query(
      `INSERT INTO boosts (user_id, service_id, plan_id, status, starts_at, expires_at)
       VALUES (:userId, :serviceId, :planId, 'active', NOW(), NOW() + INTERVAL 1 DAY)`,
      { userId: owner.id, serviceId: ids.designer, planId: plans[0]!.id },
    );
    const items = await search(`${q(RUN)}&ownerId=${owner.id}`);
    expect(items[0]).toMatchObject({ id: ids.designer, boosted: true });
    // O resto, do mais novo ao mais antigo (a ordem de publicação ao contrário).
    expect(items.slice(1).map((s) => s.id)).toEqual(
      [ids.ux, ids.aulas, ids.programacao, ids.tag].reverse(),
    );
  });
});
