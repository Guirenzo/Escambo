import type { ContractWithHistory, MyDropouts } from '@escambo/types';
import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { deleteExportFile } from '../../src/modules/lgpd/lgpd.export';
import { fundWallet } from './wallet.helpers';

const app = createApp();
const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });
const exportsCreated: number[] = [];

interface Actor {
  id: number;
  email: string;
  token: string;
}

interface ExportedOffer {
  contract_id: number;
  seq: number;
  made_by: 'client' | 'freelancer';
  price: string;
  message: string | null;
  outcome: string;
}

interface ExportedDropout {
  id: number;
  contract_id: number;
  appeal_text: string | null;
  appealed_at: string | null;
  decision: string | null;
  decision_note: string | null;
}

interface ExportedData {
  formato: string;
  titular: { email: string };
  contratacoes: { id: number }[];
  ofertas: ExportedOffer[];
  desistencias: ExportedDropout[];
}

async function actor(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `adr61-export-${ulid()}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, email, token: login.body.accessToken };
}

async function create(client: Actor, freelancer: Actor, title: string): Promise<number> {
  const response = await request(app)
    .post('/api/contracts')
    .set(auth(client))
    .send({
      freelancerId: freelancer.id,
      title,
      description: `Dados fictícios da contratação ${title}`,
      price: 100,
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.id as number;
}

async function counter(id: number, by: Actor, seq: number, price: number, message: string) {
  const response = await request(app)
    .post(`/api/contracts/${id}/offers`)
    .set(auth(by))
    .send({ seq, price, deadlineAt: null, message });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
}

async function cancelAndAppeal(id: number, freelancer: Actor, text: string): Promise<number> {
  const detail = await request(app).get(`/api/contracts/${id}`).set(auth(freelancer)).expect(200);
  const quote = (detail.body as ContractWithHistory).cancellation!;
  expect(quote.dropout).not.toBeNull();
  const cancelled = await request(app)
    .post(`/api/contracts/${id}/cancel`)
    .set(auth(freelancer))
    .send({ expectedRefund: quote.refundClient, expectedDropoutCount: quote.dropout!.countAfter });
  expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  const mine = await request(app)
    .get('/api/profiles/me/dropouts')
    .set(auth(freelancer))
    .expect(200);
  const items = (mine.body as MyDropouts).items;
  expect(items).toHaveLength(1);
  const dropoutId = items[0]!.id;
  await request(app)
    .post(`/api/profiles/me/dropouts/${dropoutId}/appeal`)
    .set(auth(freelancer))
    .send({ text })
    .expect(200);
  return dropoutId;
}

async function download(actor: Actor): Promise<{ id: number; data: ExportedData; text: string }> {
  const created = await request(app).post('/api/lgpd/export-requests').set(auth(actor)).expect(201);
  expect(created.body.status).toBe('ready');
  const id = created.body.id as number;
  exportsCreated.push(id);
  const response = await request(app)
    .get(`/api/lgpd/export-requests/${id}/download`)
    .set(auth(actor))
    .expect(200);
  expect(response.headers['content-type']).toContain('application/json');
  return { id, data: JSON.parse(response.text) as ExportedData, text: response.text };
}

afterAll(async () => {
  try {
    if (exportsCreated.length) {
      const [files] = await pool.query<(RowDataPacket & { file_url: string | null })[]>(
        'SELECT file_url FROM data_export_requests WHERE id IN (:ids)',
        { ids: exportsCreated },
      );
      for (const file of files) if (file.file_url) await deleteExportFile(file.file_url);
    }
  } finally {
    await pool.end();
  }
});

describe('ADR 61 / G.6.11: exportação 1.8 preenchida e isolada pelo titular', () => {
  it('ofertas pertencem aos participantes; desistências e contestações somente ao freelancer titular', async () => {
    const client = await actor('client');
    const first = await actor('freelancer');
    const second = await actor('freelancer');
    await fundWallet(app, client.token, 500);

    const firstId = await create(client, first, 'Contrato exclusivo do primeiro freelancer');
    const firstMessage = 'Contraproposta privada da primeira negociação';
    await counter(firstId, first, 1, 120, firstMessage);
    await counter(firstId, client, 2, 110, 'Resposta do cliente à primeira negociação');
    await request(app)
      .post(`/api/contracts/${firstId}/accept`)
      .set(auth(first))
      .send({ seq: 3 })
      .expect(200);

    const secondId = await create(client, second, 'Contrato exclusivo do segundo freelancer');
    const secondMessage = 'Contraproposta privada da segunda negociação';
    await counter(secondId, second, 1, 130, secondMessage);
    await request(app)
      .post(`/api/contracts/${secondId}/offers/2/accept`)
      .set(auth(client))
      .expect(200);

    const firstAppeal = 'Contestação privada exclusiva do primeiro freelancer fictício';
    const secondAppeal = 'Contestação privada exclusiva do segundo freelancer fictício';
    const firstDropout = await cancelAndAppeal(firstId, first, firstAppeal);
    const secondDropout = await cancelAndAppeal(secondId, second, secondAppeal);

    const byFirst = await download(first);
    const bySecond = await download(second);
    const byClient = await download(client);
    for (const [exported, owner] of [
      [byFirst, first],
      [bySecond, second],
      [byClient, client],
    ] as const) {
      expect(exported.data.formato).toBe('escambo-export/1.13');
      expect(exported.data.titular.email).toBe(owner.email);
    }

    const firstOffers = [
      [firstId, 1, 'client', 100, 'countered'],
      [firstId, 2, 'freelancer', 120, 'countered'],
      [firstId, 3, 'client', 110, 'accepted'],
    ];
    const secondOffers = [
      [secondId, 1, 'client', 100, 'countered'],
      [secondId, 2, 'freelancer', 130, 'accepted'],
    ];
    const offers = (data: ExportedData) =>
      data.ofertas.map((offer) => [
        offer.contract_id,
        offer.seq,
        offer.made_by,
        Number(offer.price),
        offer.outcome,
      ]);
    expect(offers(byFirst.data)).toEqual(firstOffers);
    expect(offers(bySecond.data)).toEqual(secondOffers);
    expect(offers(byClient.data)).toEqual([...firstOffers, ...secondOffers]);
    expect(byFirst.text).not.toContain(secondMessage);
    expect(bySecond.text).not.toContain(firstMessage);

    expect(byFirst.data.desistencias).toHaveLength(1);
    expect(byFirst.data.desistencias[0]).toMatchObject({
      id: firstDropout,
      contract_id: firstId,
      appeal_text: firstAppeal,
      decision: null,
      decision_note: null,
    });
    expect(byFirst.data.desistencias[0]!.appealed_at).toEqual(expect.any(String));
    expect(bySecond.data.desistencias).toHaveLength(1);
    expect(bySecond.data.desistencias[0]).toMatchObject({
      id: secondDropout,
      contract_id: secondId,
      appeal_text: secondAppeal,
    });
    expect(byClient.data.desistencias).toEqual([]);
    expect(byFirst.text).not.toContain(secondAppeal);
    expect(bySecond.text).not.toContain(firstAppeal);
    expect(byClient.text).not.toContain(firstAppeal);
    expect(byClient.text).not.toContain(secondAppeal);

    await request(app)
      .get(`/api/lgpd/export-requests/${byFirst.id}/download`)
      .set(auth(client))
      .expect(403);
    await request(app)
      .get(`/api/lgpd/export-requests/${byFirst.id}/download`)
      .set(auth(second))
      .expect(403);
  });
});
