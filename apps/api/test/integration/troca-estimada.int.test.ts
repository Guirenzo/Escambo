import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';
import { confirmEmail } from './mail.helpers';

/**
 * Troca estimada pelo sistema (RF-084, RN-066) contra o MySQL: o lado de serviço com preço fechado
 * vale o catálogo, valor diferente é recusado sem gravar nem reservar, o lado a combinar, por hora
 * ou descrito vale o que o proponente informa, e a torna sai da diferença como sempre.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function freelancer(): Promise<Actor> {
  const email = `troca_estimada_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role: 'freelancer' })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  await confirmEmail(app, login.body.user.id);
  return { id: login.body.user.id, token: login.body.accessToken };
}

let categoryId = 0;
async function service(
  owner: Actor,
  priceType: 'fixed' | 'hourly' | 'negotiable',
  price: number | null,
): Promise<number> {
  if (!categoryId) categoryId = (await request(app).get('/api/categories')).body[0].id;
  const res = await request(app)
    .post('/api/services')
    .set(auth(owner.token))
    .send({
      categoryId,
      title: `Serviço estimado ${seq++}`,
      description: 'Serviço para a estimativa da troca',
      priceType,
      price,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

const propose = (from: Actor, body: Record<string, unknown>) =>
  request(app).post('/api/barters').set(auth(from.token)).send(body);

const wallet = async (who: Actor) =>
  (await request(app).get('/api/wallet').set(auth(who.token))).body as {
    balance: number;
    balancePending: number;
  };

async function barterCount(proposer: Actor): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM barter_agreements WHERE proposer_id = ?',
    [proposer.id],
  );
  return Number(rows[0]!.n);
}

afterAll(async () => {
  await pool.end();
});

describe('Troca: o sistema estima o valor dos lados (RF-084)', () => {
  it('preço fechado dos dois lados: sem valores, o catálogo estima, a torna é a diferença e fica reservada', async () => {
    const a = await freelancer();
    const b = await freelancer();
    const mine = await service(a, 'fixed', 200);
    const theirs = await service(b, 'fixed', 300);
    await fundWallet(app, a.token, 150);

    const res = await propose(a, {
      receiverId: b.id,
      offeredServiceId: mine,
      requestedServiceId: theirs,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      estimatedValueOffered: 200,
      estimatedValueRequested: 300,
      offeredValueSource: 'catalog',
      requestedValueSource: 'catalog',
      cashDifference: 100,
      cashPayerId: a.id,
      platformFee: 15,
      tornaStatus: 'held',
    });
    expect(await wallet(a)).toMatchObject({ balance: 50, balancePending: 100 });

    // Quem recebe vê de onde veio cada valor.
    const seen = await request(app).get(`/api/barters/${res.body.id}`).set(auth(b.token));
    expect(seen.body).toMatchObject({
      offeredValueSource: 'catalog',
      requestedValueSource: 'catalog',
    });

    // O aceite gera as contratações com os valores estimados.
    const accepted = await request(app)
      .post(`/api/barters/${res.body.id}/accept`)
      .set(auth(b.token))
      .expect(200);
    const offered = await request(app)
      .get(`/api/contracts/${accepted.body.contractOfferedId}`)
      .set(auth(a.token))
      .expect(200);
    const requested = await request(app)
      .get(`/api/contracts/${accepted.body.contractRequestedId}`)
      .set(auth(a.token))
      .expect(200);
    expect([offered.body.price, requested.body.price]).toEqual([200, 300]);
  });

  it('valor digitado diferente do catálogo: 422 estimate_mismatch, nada gravado nem reservado; igual ao centavo passa', async () => {
    const a = await freelancer();
    const b = await freelancer();
    const mine = await service(a, 'fixed', 200);
    const theirs = await service(b, 'fixed', 300);
    await fundWallet(app, a.token, 300);
    const base = { receiverId: b.id, offeredServiceId: mine, requestedServiceId: theirs };

    // Diminuir o pedido para pagar menos torna.
    const cheaper = await propose(a, { ...base, estimatedValueRequested: 210 });
    expect([cheaper.status, cheaper.body.error]).toEqual([422, 'estimate_mismatch']);
    expect(cheaper.body.message).toMatch(/^O serviço pedido custa R\$\s300,00 no catálogo/);
    // Inflar o próprio serviço para receber torna.
    const inflated = await propose(a, {
      ...base,
      estimatedValueOffered: 900,
      estimatedValueRequested: 300,
    });
    expect([inflated.status, inflated.body.error]).toEqual([422, 'estimate_mismatch']);
    expect(inflated.body.message).toMatch(/^O serviço que você oferece custa R\$\s200,00/);
    expect(await barterCount(a)).toBe(0);
    expect(await wallet(a)).toMatchObject({ balance: 300, balancePending: 0 });

    // O preço mudou depois que a tela abriu: o valor velho é recusado; sem valor, vale o novo.
    await request(app)
      .patch(`/api/services/${theirs}`)
      .set(auth(b.token))
      .send({ price: 350 })
      .expect(200);
    const stale = await propose(a, {
      ...base,
      estimatedValueOffered: 200,
      estimatedValueRequested: 300,
    });
    expect([stale.status, stale.body.error]).toEqual([422, 'estimate_mismatch']);
    const fresh = await propose(a, {
      ...base,
      estimatedValueOffered: 200.0,
      estimatedValueRequested: 350,
    });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    expect(fresh.body).toMatchObject({ cashDifference: 150, cashPayerId: a.id });
  });

  it('a combinar, por hora ou descrito: o valor informado vale e é obrigatório; a torna sai dele', async () => {
    const a = await freelancer();
    const b = await freelancer();
    const mine = await service(a, 'fixed', 200);
    const open = await service(b, 'negotiable', null);
    const hourly = await service(b, 'hourly', 80);

    for (const requestedServiceId of [open, hourly]) {
      const missing = await propose(a, {
        receiverId: b.id,
        offeredServiceId: mine,
        requestedServiceId,
      });
      expect([missing.status, missing.body.error]).toEqual([422, 'estimate_required']);
    }
    const described = await propose(a, {
      receiverId: b.id,
      offeredDescription: 'Fotos do cardápio',
      requestedServiceId: open,
      estimatedValueRequested: 100,
    });
    expect([described.status, described.body.message]).toEqual([
      422,
      'Informe quanto vale o que você oferece.',
    ]);
    expect(await barterCount(a)).toBe(0);

    // Pedido a combinar valendo 500: quem propõe recebe o mais valioso e reserva 300 de torna.
    await fundWallet(app, a.token, 400);
    const res = await propose(a, {
      receiverId: b.id,
      offeredServiceId: mine,
      requestedServiceId: open,
      estimatedValueRequested: 500,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      estimatedValueOffered: 200,
      estimatedValueRequested: 500,
      offeredValueSource: 'catalog',
      requestedValueSource: 'informed',
      cashDifference: 300,
      cashPayerId: a.id,
    });

    // Por hora: o catálogo dá o preço da hora, não o do trabalho; quem propõe informa o total.
    const perHour = await propose(a, {
      receiverId: b.id,
      offeredServiceId: mine,
      requestedServiceId: hourly,
      estimatedValueRequested: 240,
    });
    expect(perHour.status, JSON.stringify(perHour.body)).toBe(201);
    expect(perHour.body).toMatchObject({
      requestedValueSource: 'informed',
      cashDifference: 40,
      cashPayerId: a.id,
      tornaStatus: 'held',
    });
  });
});
