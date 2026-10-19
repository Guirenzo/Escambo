import type { BrazilTimezone } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';

/**
 * Extrato de créditos com período (RF-047) contra o MySQL real, com o mesmo comportamento do
 * extrato de R$: os dias "de" e "até" são os do fuso da conta de quem lê, o "até" inclui o dia
 * inteiro, e a página diz se há mais ("Carregar mais").
 */

const app = createApp();

interface Reader {
  id: number;
  token: string;
}

async function reader(timezone: BrazilTimezone): Promise<Reader> {
  const key = ulid();
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone)
     VALUES (:key, :email, 'freelancer', 'active', :timezone)`,
    { key, email: `creditos-${key}@escambo.test`, timezone },
  );
  return {
    id: created.insertId,
    token: jwt.sign({ sub: key, uid: created.insertId, role: 'freelancer' }, env.JWT_SECRET, {
      expiresIn: '1h',
    }),
  };
}

/** Lança um movimento de créditos na data dada (UTC) e devolve o id do lançamento. */
async function entry(userId: number, at: string, amount = 10): Promise<number> {
  const [r] = await pool.query<ResultSetHeader>(
    `INSERT INTO credit_transactions (user_id, amount, balance_after, reason, created_at)
     VALUES (:userId, :amount, 100, 'grant', :at)`,
    { userId, amount, at: new Date(at) },
  );
  return r.insertId;
}

const get = (who: Reader, query: string) =>
  request(app).get(`/api/credits/transactions${query}`).set('Authorization', `Bearer ${who.token}`);

const ids = (body: { items: { id: number }[] }): number[] => body.items.map((t) => t.id);

let manaus: Reader;
let brasilia: Reader;
/** Os mesmos instantes nas duas contas: o que muda é o dia de cada fuso. */
const at = {
  sep30Night: '2026-09-30T23:30:00Z', // Manaus 30/09 19:30 · Brasília 30/09 20:30
  oct1Early: '2026-10-01T03:30:00Z', // Manaus 30/09 23:30 · Brasília 01/10 00:30
  oct1Start: '2026-10-01T04:00:00Z', // Manaus 01/10 00:00 · Brasília 01/10 01:00
  oct1End: '2026-10-02T03:59:59Z', //   Manaus 01/10 23:59:59 · Brasília 02/10 00:59:59
  oct2Start: '2026-10-02T04:00:00Z', // Manaus 02/10 00:00 · Brasília 02/10 01:00
} as const;
const m = {} as Record<keyof typeof at, number>;
const b = {} as Record<keyof typeof at, number>;

beforeAll(async () => {
  manaus = await reader('America/Manaus');
  brasilia = await reader('America/Sao_Paulo');
  for (const key of Object.keys(at) as (keyof typeof at)[]) {
    m[key] = await entry(manaus.id, at[key]);
    b[key] = await entry(brasilia.id, at[key], -5);
  }
});

afterAll(async () => {
  await pool.end();
});

describe('extrato de créditos por período (RF-047)', () => {
  it('sem período: o extrato inteiro de quem lê, do mais novo ao mais antigo, sem mais páginas', async () => {
    const res = await get(manaus, '').expect(200);

    expect(ids(res.body)).toEqual([m.oct2Start, m.oct1End, m.oct1Start, m.oct1Early, m.sep30Night]);
    expect(res.body).toMatchObject({ page: 1, limit: 20, hasMore: false });
    expect(res.body.items[0]).toEqual({
      id: m.oct2Start,
      amount: 10,
      balanceAfter: 100,
      reason: 'grant',
      contractId: null,
      createdAt: '2026-10-02T04:00:00.000Z',
    });
  });

  it('um dia só, no fuso de Manaus: da meia-noite (inclusive) até 23:59:59 do mesmo dia', async () => {
    const res = await get(manaus, '?from=2026-10-01&to=2026-10-01').expect(200);

    expect(ids(res.body)).toEqual([m.oct1End, m.oct1Start]);
    expect(res.body.hasMore).toBe(false);
  });

  it('o mesmo dia lido de Brasília pega outros instantes, e só os lançamentos de quem lê', async () => {
    const res = await get(brasilia, '?from=2026-10-01&to=2026-10-01').expect(200);

    expect(ids(res.body)).toEqual([b.oct1Start, b.oct1Early]);
    expect(res.body.items.every((t: { amount: number }) => t.amount === -5)).toBe(true);
  });

  it('só "até" ou só "de": o outro lado fica aberto', async () => {
    const until = await get(manaus, '?to=2026-09-30').expect(200);
    expect(ids(until.body)).toEqual([m.oct1Early, m.sep30Night]);

    const since = await get(manaus, '?from=2026-10-02').expect(200);
    expect(ids(since.body)).toEqual([m.oct2Start]);
  });

  it('"Carregar mais": a página cheia avisa que há mais, e a última não', async () => {
    const first = await get(manaus, '?from=2026-09-30&to=2026-10-01&limit=2').expect(200);
    expect(ids(first.body)).toEqual([m.oct1End, m.oct1Start]);
    expect(first.body).toMatchObject({ page: 1, limit: 2, hasMore: true });

    const second = await get(manaus, '?from=2026-09-30&to=2026-10-01&limit=2&page=2').expect(200);
    expect(ids(second.body)).toEqual([m.oct1Early, m.sep30Night]);
    expect(second.body).toMatchObject({ page: 2, limit: 2, hasMore: false });

    // Sem período, as 5 em páginas de 2: 2 + 2 + 1, e só a última diz que acabou.
    const pages = [];
    for (let page = 1; page <= 3; page++) {
      pages.push((await get(manaus, `?limit=2&page=${page}`).expect(200)).body);
    }
    expect(pages.map((p) => [ids(p).length, p.hasMore])).toEqual([
      [2, true],
      [2, true],
      [1, false],
    ]);
  });

  it('período sem lançamento devolve a lista vazia', async () => {
    const res = await get(manaus, '?from=2026-11-01&to=2026-11-30').expect(200);

    expect(res.body).toEqual({ items: [], page: 1, limit: 20, hasMore: false });
  });

  it('período invertido é 400 invalid_range; dia inexistente é 422 no campo', async () => {
    const inverted = await get(manaus, '?from=2026-10-02&to=2026-10-01').expect(400);
    expect(inverted.body).toEqual({
      error: 'invalid_range',
      message: 'Período inválido: a data inicial precisa ser até a final',
    });

    const invalid = await get(manaus, '?to=2026-02-30').expect(422);
    expect(invalid.body.error).toBe('validation_error');
    expect(invalid.body.details.to).toEqual(['Informe um dia válido no formato AAAA-MM-DD']);
  });
});
