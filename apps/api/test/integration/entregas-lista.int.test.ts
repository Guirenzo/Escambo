import type { Contract, ContractList, ContractWithHistory } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { waitForNotification } from './notifications.helpers';

/**
 * RF-035 e RF-040 contra o MySQL real: a mensagem e os links de cada entrega única (e das
 * reentregas) voltam no detalhe às duas partes e o começo da mensagem vai no aviso ao cliente; a
 * lista do painel pagina sem repetir, devolve o total de verdade e filtra por status.
 */

const app = createApp();
interface Actor {
  id: number;
  token: string;
}
const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });

async function actor(role: 'client' | 'freelancer', cash = 0): Promise<Actor> {
  const key = ulid();
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone)
     VALUES (:key, :email, :role, 'active', 'America/Sao_Paulo')`,
    { key, email: `entregas-${key}@escambo.test`, role },
  );
  await walletRepository.ensure(res.insertId);
  await pool.query('UPDATE wallets SET balance = :cash WHERE user_id = :id', {
    id: res.insertId,
    cash,
  });
  return {
    id: res.insertId,
    token: jwt.sign({ sub: key, uid: res.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

async function propose(client: Actor, freelancer: Actor, title: string): Promise<number> {
  const res = await request(app).post('/api/contracts').set(auth(client)).send({
    freelancerId: freelancer.id,
    title,
    description: 'Contratação criada pelo teste das entregas e da lista',
    price: 100,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

async function accept(freelancer: Actor, id: number): Promise<void> {
  const res = await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function list(who: Actor, query = ''): Promise<ContractList> {
  const res = await request(app).get(`/api/contracts${query}`).set(auth(who));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ContractList;
}

beforeAll(async () => {
  const res = await request(app).get('/api/health');
  expect(res.status, 'API /health deve responder com o banco de teste no ar').toBe(200);
});

afterAll(async () => {
  await pool.end();
});

describe('entregas únicas no detalhe e no aviso (RF-035)', () => {
  it('a entrega e a reentrega voltam às duas partes com mensagem, links e data, e o aviso traz o começo da mensagem', async () => {
    const client = await actor('client', 500);
    const freelancer = await actor('freelancer');
    const id = await propose(client, freelancer, 'Vídeo institucional com trilha');
    await accept(freelancer, id);

    // Antes de entregar, nada na lista de entregas.
    const before = await request(app).get(`/api/contracts/${id}`).set(auth(client));
    expect((before.body as ContractWithHistory).deliveries).toEqual([]);

    const first = `Segue a primeira versão.\n\nO roteiro ficou assim: ${'abertura, '.repeat(15)}fim.`;
    const files = ['https://cdn.escambo.test/video-v1.mp4', 'https://cdn.escambo.test/roteiro.pdf'];
    const d1 = await request(app)
      .post(`/api/contracts/${id}/deliver`)
      .set(auth(freelancer))
      .send({ message: first, files });
    expect(d1.status, JSON.stringify(d1.body)).toBe(200);

    expect(await waitForNotification(app, client.token, 'contract_delivered')).toBe(true);
    const [notices] = await pool.query<RowDataPacket[]>(
      `SELECT body FROM notifications WHERE user_id = :id AND type = 'contract_delivered'`,
      { id: client.id },
    );
    const excerpt = first.replace(/\s+/g, ' ').slice(0, 119).trimEnd();
    expect(String(notices[0]!.body).endsWith(` Mensagem: ${excerpt}…`)).toBe(true);

    const revision = await request(app)
      .post(`/api/contracts/${id}/request-revision`)
      .set(auth(client))
      .send({ note: 'Troque a trilha, por favor' });
    expect(revision.status, JSON.stringify(revision.body)).toBe(200);
    const d2 = await request(app)
      .post(`/api/contracts/${id}/deliver`)
      .set(auth(freelancer))
      .send({ message: 'Trilha trocada.' });
    expect(d2.status, JSON.stringify(d2.body)).toBe(200);

    for (const who of [client, freelancer]) {
      const res = await request(app).get(`/api/contracts/${id}`).set(auth(who));
      expect(res.status).toBe(200);
      const deliveries = (res.body as ContractWithHistory).deliveries!;
      expect(deliveries.map((d) => [d.message, d.files])).toEqual([
        [first, files],
        ['Trilha trocada.', []],
      ]);
      for (const d of deliveries) {
        expect(new Date(d.deliveredAt).toISOString()).toBe(d.deliveredAt);
        expect(d.id).toBeGreaterThan(0);
      }
      expect(deliveries[0]!.id).toBeLessThan(deliveries[1]!.id);
    }

    // Quem não participa continua sem ver nada (nem as entregas).
    const outsider = await actor('client');
    await request(app).get(`/api/contracts/${id}`).set(auth(outsider)).expect(403);
  });
});

describe('lista do painel: total, páginas e filtro por status (RF-040)', () => {
  it('pagina sem repetir, conta todas as contratações e filtra por status', async () => {
    const client = await actor('client', 1000);
    const freelancers = [
      await actor('freelancer'),
      await actor('freelancer'),
      await actor('freelancer'),
    ];
    const ids: number[] = [];
    for (const [i, f] of freelancers.entries())
      ids.push(await propose(client, f, `Projeto ${i + 1}`));
    await accept(freelancers[1]!, ids[1]!);

    const page1 = await list(client, '?limit=2');
    const page2 = await list(client, '?limit=2&page=2');
    expect(page1).toMatchObject({ page: 1, limit: 2, total: 3 });
    expect(page2).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(1);
    // Mais nova primeiro; as duas páginas juntas têm as três, sem repetir.
    const seen = [...page1.items, ...page2.items].map((c: Contract) => c.id);
    expect(seen).toEqual([...ids].reverse());

    const accepted = await list(client, '?status=accepted');
    expect(accepted.total).toBe(1);
    expect(accepted.items.map((c) => [c.id, c.status])).toEqual([[ids[1], 'accepted']]);

    const open = await list(client, '?status=pending,accepted');
    expect(open.total).toBe(3);
    const done = await list(client, '?status=completed&status=cancelled');
    expect(done).toMatchObject({ items: [], total: 0 });

    // O freelancer vê só a dele, com o total dele.
    const mine = await list(freelancers[0]!);
    expect(mine.total).toBe(1);
    expect(mine.items.map((c) => c.id)).toEqual([ids[0]]);

    const bad = await request(app).get('/api/contracts?status=pago').set(auth(client));
    expect(bad.status).toBe(422);
    expect(bad.body.details).toEqual({ status: ['Status de contratação desconhecido'] });
  });
});
