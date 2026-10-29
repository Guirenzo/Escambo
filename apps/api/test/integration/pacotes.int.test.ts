import type { ContractWithHistory, Service, ServicePackage } from '@escambo/types';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { settingsRepository } from '../../src/modules/settings/settings.repository';
import { settingsService } from '../../src/modules/settings/settings.service';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { setClockForTests } from '../../src/utils/clock';
import { addDaysToDay, dayIn, endOfDayIn } from '../../src/utils/timezone';
import { deleteUsersWithoutLedger } from './helpers/ledger-cleanup';

/**
 * Pacotes Básico, Padrão e Premium por serviço (RF-086, RN-068, ADR 69) contra o MySQL real: o
 * anúncio guarda o preço e o prazo do Básico (busca, ordem e troca leem dali), a edição substitui
 * os pacotes na mesma transação, e a contratação de um pacote grava as revisões dele (RN-023), o
 * prazo e a cópia do pacote, que não muda quando o freelancer edita o serviço depois.
 */

const app = createApp();
// Daqui a uma semana, ao meio-dia de Brasília: o schema da proposta confere o prazo pelo relógio
// real, então o relógio parado da API fica no futuro, longe da virada do dia.
const today = new Date();
const NOW = new Date(
  Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 7, 15, 0, 0),
);
/** 23:59:59 em Brasília do dia NOW + n (o prazo de um pacote de n dias, RN-080). */
const packageDay = (n: number): string =>
  endOfDayIn('America/Sao_Paulo', addDaysToDay(dayIn('America/Sao_Paulo', NOW), n)).toISOString();
const ownedUsers: number[] = [];
const ownedContracts: number[] = [];
const ownedBarters: number[] = [];
const originals = new Map<string, string | null>();

interface Actor {
  id: number;
  token: string;
}
const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });

async function actor(role: 'client' | 'freelancer'): Promise<Actor> {
  const key = ulid();
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone, email_verified_at)
      VALUES (:key, :email, :role, 'active', 'America/Sao_Paulo', NOW())`,
    { key, email: `pacotes-${key}@escambo.test`, role },
  );
  ownedUsers.push(created.insertId);
  await walletRepository.ensure(created.insertId);
  await pool.query(
    'UPDATE wallets SET balance = 5000, credits_balance = 5000 WHERE user_id = :id',
    { id: created.insertId },
  );
  return {
    id: created.insertId,
    token: jwt.sign({ sub: key, uid: created.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

const pkg = (
  tier: ServicePackage['tier'],
  price: number,
  deliveryDays: number,
  revisions = 2,
  features: string[] = [],
) => ({
  tier,
  name: `Pacote ${tier}`,
  description: null,
  price,
  deliveryDays,
  revisions,
  features,
});

/** Básico R$ 100 em 3 dias, Padrão R$ 200 em 5 e Premium R$ 350,50 em 10 dias com 3 revisões. */
const THREE = [
  pkg('basic', 100, 3, 2, ['Logo']),
  pkg('standard', 200, 5, 2, ['Logo', 'Cartão de visita']),
  pkg('premium', 350.5, 10, 3, ['Logo', 'Cartão de visita', 'Manual da marca']),
];

let categoryId = 0;
async function publish(owner: Actor, body: Record<string, unknown>): Promise<Service> {
  const res = await request(app)
    .post('/api/services')
    .set(auth(owner))
    .send({
      categoryId,
      title: `Identidade visual ${ulid()}`,
      description: 'Logo, cores e manual da marca para pequenos negócios',
      isRemote: true,
      ...body,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Service;
}

async function serviceRow(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT price, delivery_days, price_type FROM services WHERE id = :id',
    { id },
  );
  return rows[0]!;
}

async function packageRows(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT tier, name, price, delivery_days, revisions, features FROM service_packages WHERE service_id = :id ORDER BY tier',
    { id },
  );
  return rows;
}

const propose = (client: Actor, freelancer: Actor, serviceId: number, body: object) =>
  request(app)
    .post('/api/contracts')
    .set(auth(client))
    .send({
      freelancerId: freelancer.id,
      serviceId,
      title: 'Identidade visual da padaria',
      description: 'Logo e manual para a padaria do bairro',
      ...body,
    });

async function contracted(client: Actor, freelancer: Actor, serviceId: number, body: object) {
  const res = await propose(client, freelancer, serviceId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  ownedContracts.push(res.body.id as number);
  return res.body as ContractWithHistory;
}

async function contractRow(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT price, revision_limit, package_tier, package_snapshot, deadline_at FROM contracts WHERE id = :id',
    { id },
  );
  return rows[0]!;
}

beforeAll(async () => {
  originals.set('min_service_price', await settingsRepository.get('min_service_price'));
  await settingsRepository.set('min_service_price', '10.00', 'decimal');
  settingsService.clearCache();
  categoryId = (await request(app).get('/api/categories')).body[0].id as number;
});
beforeEach(() => setClockForTests(NOW, { frozen: true }));
afterEach(async () => {
  if (ownedContracts.length)
    await pool.query('DELETE FROM contracts WHERE id IN (:ids)', { ids: ownedContracts });
  if (ownedBarters.length)
    await pool.query('DELETE FROM barter_agreements WHERE id IN (:ids)', { ids: ownedBarters });
  if (ownedUsers.length) {
    await pool.query('DELETE FROM notifications WHERE user_id IN (:ids)', { ids: ownedUsers });
    await pool.query('DELETE FROM services WHERE user_id IN (:ids)', { ids: ownedUsers });
    // Extrato imutável (RNF-036): quem tem lançamento fica, com os lançamentos.
    await deleteUsersWithoutLedger(ownedUsers);
  }
  ownedContracts.length = ownedBarters.length = ownedUsers.length = 0;
});
afterAll(async () => {
  setClockForTests(null);
  const min = originals.get('min_service_price');
  if (min != null) await settingsRepository.set('min_service_price', min, 'decimal');
  settingsService.clearCache();
  await pool.end();
});

describe('migration 0051 (pacotes)', () => {
  it('está aplicada: tabela com a chave única por nível e as duas colunas da contratação; rodar de novo não muda nada', async () => {
    const [done] = await pool.query<RowDataPacket[]>(
      `SELECT name FROM schema_migrations WHERE name = '0051_pacotes_servico'`,
    );
    expect(done).toHaveLength(1);
    const columns = async () => {
      const [cols] = await pool.query<RowDataPacket[]>(
        `SELECT column_name AS col, column_type AS type, is_nullable AS nullable
           FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'contracts'
            AND column_name IN ('package_tier', 'package_snapshot')
          ORDER BY column_name`,
      );
      return cols.map((c) => `${c.col} ${c.type} ${c.nullable}`);
    };
    const expected = [
      'package_snapshot json YES',
      "package_tier enum('basic','standard','premium') YES",
    ];
    expect(await columns()).toEqual(expected);

    const sql = readFileSync(
      join(__dirname, '../../db/migrations/0051_pacotes_servico.sql'),
      'utf8',
    );
    const conn = await mysql.createConnection({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      multipleStatements: true,
    });
    try {
      await conn.query(sql);
      await conn.query(sql); // idempotente
    } finally {
      await conn.end();
    }
    expect(await columns()).toEqual(expected);
    const [unique] = await pool.query<RowDataPacket[]>(
      `SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'service_packages'
          AND index_name = 'uq_service_tier' AND non_unique = 0`,
    );
    expect(unique[0]!.cols).toBe('service_id,tier');
  });
});

describe('publicar e editar pacotes (RF-086, RN-068)', () => {
  it('os 3 pacotes ficam gravados e o anúncio guarda o preço e o prazo do Básico', async () => {
    const owner = await actor('freelancer');
    const s = await publish(owner, {
      priceType: 'fixed',
      packages: [THREE[2], THREE[0], THREE[1]],
    });

    expect(s.price).toBe(100);
    expect(s.deliveryDays).toBe(3);
    expect(s.packages).toEqual(THREE);
    expect(await serviceRow(s.id)).toMatchObject({
      price: '100.00',
      delivery_days: 3,
      price_type: 'fixed',
    });
    expect((await packageRows(s.id)).map((r) => [r.tier, r.price, r.revisions])).toEqual([
      ['basic', '100.00', 2],
      ['standard', '200.00', 2],
      ['premium', '350.50', 3],
    ]);
    // O detalhe público e "Meus serviços" trazem os mesmos pacotes.
    const detail = await request(app).get(`/api/services/${s.id}`).expect(200);
    expect(detail.body.packages).toEqual(THREE);
    const mine = await request(app).get('/api/services/mine').set(auth(owner)).expect(200);
    expect(mine.body[0].packages).toEqual(THREE);
  });

  it('regras: só no preço fixo, sem price junto, Básico obrigatório, preço crescente e o mínimo', async () => {
    const owner = await actor('freelancer');
    const send = (body: Record<string, unknown>) =>
      request(app)
        .post('/api/services')
        .set(auth(owner))
        .send({ categoryId, title: 'Pacotes errados', description: 'Descrição longa', ...body });

    expect((await send({ priceType: 'hourly', packages: THREE })).body.error).toBe(
      'packages_require_fixed_price',
    );
    expect((await send({ price: 90, packages: THREE })).body.error).toBe('price_from_packages');
    const noBasic = await send({ packages: [THREE[1]] });
    expect([noBasic.status, noBasic.body.error]).toEqual([422, 'validation_error']);
    const order = await send({ packages: [pkg('basic', 150, 3), pkg('standard', 120, 5)] });
    expect([order.status, order.body.error]).toEqual([422, 'package_price_order']);
    const cheap = await send({ packages: [pkg('basic', 9.99, 3)] });
    expect([cheap.status, cheap.body.error]).toEqual([422, 'price_below_minimum']);
    const [count] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM services WHERE user_id = :id',
      { id: owner.id },
    );
    expect(Number(count[0]!.n)).toBe(0);
  });

  it('a busca filtra e ordena pelo "a partir de" (o Básico), nos índices de sempre', async () => {
    const owner = await actor('freelancer');
    const packaged = await publish(owner, { packages: THREE });
    const plain = await publish(owner, { priceType: 'fixed', price: 150, deliveryDays: 4 });
    const ids = async (query: string) =>
      (
        (await request(app).get(`/api/services?ownerId=${owner.id}&${query}`).expect(200)).body
          .items as Service[]
      ).map((s) => s.id);

    expect(await ids('sort=price_asc')).toEqual([packaged.id, plain.id]);
    expect(await ids('sort=price_desc')).toEqual([plain.id, packaged.id]);
    expect(await ids('minPrice=120')).toEqual([plain.id]);
    expect(await ids('maxPrice=110')).toEqual([packaged.id]);
    // O prazo do anúncio também é o do Básico (3 dias).
    expect(await ids('maxDeliveryDays=3')).toEqual([packaged.id]);
    const page = await request(app).get(`/api/services?ownerId=${owner.id}`).expect(200);
    const card = (page.body.items as Service[]).find((s) => s.id === packaged.id)!;
    expect(card.packages).toEqual(THREE);
  });

  it('a edição substitui os pacotes na mesma transação; [] tira todos e o preço do anúncio fica', async () => {
    const owner = await actor('freelancer');
    const s = await publish(owner, { packages: THREE });

    const edited = await request(app)
      .patch(`/api/services/${s.id}`)
      .set(auth(owner))
      .send({ packages: [pkg('basic', 120, 4), pkg('standard', 220, 6)] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.packages.map((p: ServicePackage) => p.tier)).toEqual(['basic', 'standard']);
    expect(await serviceRow(s.id)).toMatchObject({ price: '120.00', delivery_days: 4 });
    expect((await packageRows(s.id)).map((r) => r.tier)).toEqual(['basic', 'standard']);

    // Mudar o tipo de preço mantendo os pacotes: 422, nada muda.
    const hourly = await request(app)
      .patch(`/api/services/${s.id}`)
      .set(auth(owner))
      .send({ priceType: 'hourly' });
    expect([hourly.status, hourly.body.error]).toEqual([422, 'packages_require_fixed_price']);

    const removed = await request(app)
      .patch(`/api/services/${s.id}`)
      .set(auth(owner))
      .send({ packages: [] });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.packages).toEqual([]);
    expect(removed.body.price).toBe(120);
    expect(await packageRows(s.id)).toEqual([]);
  });

  it('o banco garante um pacote por nível (uq_service_tier)', async () => {
    const owner = await actor('freelancer');
    const s = await publish(owner, { packages: [THREE[0]] });
    await expect(
      pool.query(
        `INSERT INTO service_packages (service_id, tier, name, price, delivery_days)
         VALUES (:id, 'basic', 'Outro básico', 50, 2)`,
        { id: s.id },
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });
});

describe('contratar um pacote (RF-086, RN-023, ADR 69)', () => {
  async function scenario() {
    const freelancer = await actor('freelancer');
    const client = await actor('client');
    const s = await publish(freelancer, { packages: THREE });
    return { freelancer, client, s };
  }

  it('Premium: revisões do pacote, nível e cópia gravados; sem data, o prazo é o fim do dia do pacote', async () => {
    const { freelancer, client, s } = await scenario();
    const c = await contracted(client, freelancer, s.id, { price: 350.5, packageTier: 'premium' });

    expect(c.package).toEqual(THREE[2]);
    expect(c.revisions).toEqual({ used: 0, limit: 3 });
    // Hoje + 10 dias, até 23:59:59 em Brasília.
    expect(c.deadlineAt).toBe(packageDay(10));
    const row = await contractRow(c.id);
    expect(row.revision_limit).toBe(3);
    expect(row.package_tier).toBe('premium');
    expect(row.package_snapshot).toEqual(THREE[2]);
  });

  it('com 3 revisões do pacote, a quarta é 409 revision_limit (RN-023)', async () => {
    const { freelancer, client, s } = await scenario();
    const c = await contracted(client, freelancer, s.id, { price: 350.5, packageTier: 'premium' });
    await request(app).post(`/api/contracts/${c.id}/accept`).set(auth(freelancer)).expect(200);
    const deliver = () =>
      request(app)
        .post(`/api/contracts/${c.id}/deliver`)
        .set(auth(freelancer))
        .send({ message: 'Versão para conferir' });
    const revise = () =>
      request(app)
        .post(`/api/contracts/${c.id}/request-revision`)
        .set(auth(client))
        .send({ note: 'Ajuste nas cores, por favor' });
    for (let i = 1; i <= 3; i++) {
      expect((await deliver()).status).toBe(200);
      const res = await revise();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expect((await deliver()).status).toBe(200);
    const blocked = await revise();
    expect([blocked.status, blocked.body.error]).toEqual([409, 'revision_limit']);
    expect(blocked.body.message).toContain('As 3 revisões sem custo');
  });

  it('por marcos, cada marco ganha as revisões do pacote', async () => {
    const { freelancer, client, s } = await scenario();
    const c = await contracted(client, freelancer, s.id, {
      price: 350.5,
      packageTier: 'premium',
      milestones: [
        { title: 'Logo', amount: 150.5 },
        { title: 'Manual', amount: 200 },
      ],
    });
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT revision_limit FROM contract_milestones WHERE contract_id = :id ORDER BY sort_order',
      { id: c.id },
    );
    expect(rows.map((r) => r.revision_limit)).toEqual([3, 3]);
    const detail = await request(app).get(`/api/contracts/${c.id}`).set(auth(client)).expect(200);
    expect((detail.body as ContractWithHistory).milestones.map((m) => m.revisions)).toEqual([
      { used: 0, limit: 3 },
      { used: 0, limit: 3 },
    ]);
  });

  it('o pacote editado depois não muda a contratação: vale a cópia', async () => {
    const { freelancer, client, s } = await scenario();
    const c = await contracted(client, freelancer, s.id, { price: 200, packageTier: 'standard' });
    await request(app)
      .patch(`/api/services/${s.id}`)
      .set(auth(freelancer))
      .send({ packages: [pkg('basic', 110, 3), { ...pkg('standard', 260, 7), name: 'Novo nome' }] })
      .expect(200);

    const after = await request(app).get(`/api/contracts/${c.id}`).set(auth(client)).expect(200);
    expect(after.body.package).toEqual(THREE[1]);
    expect(after.body.price).toBe(200);
  });

  it('recusas: nível obrigatório, nível que não existe, preço desatualizado e prazo antes do pacote', async () => {
    const { freelancer, client, s } = await scenario();
    const required = await propose(client, freelancer, s.id, { price: 100 });
    expect([required.status, required.body.error]).toEqual([422, 'package_required']);

    await request(app)
      .patch(`/api/services/${s.id}`)
      .set(auth(freelancer))
      .send({ packages: [pkg('basic', 100, 3), pkg('standard', 240, 5)] })
      .expect(200);
    const missing = await propose(client, freelancer, s.id, {
      price: 350.5,
      packageTier: 'premium',
    });
    expect([missing.status, missing.body.error]).toEqual([422, 'package_not_found']);
    // A tela abriu com o Padrão a R$ 200; o freelancer subiu para R$ 240.
    const stale = await propose(client, freelancer, s.id, { price: 200, packageTier: 'standard' });
    expect([stale.status, stale.body.error]).toEqual([409, 'package_changed']);
    // O Padrão entrega em 5 dias: o fim do quarto dia é antes.
    const early = await propose(client, freelancer, s.id, {
      price: 240,
      packageTier: 'standard',
      deadlineAt: packageDay(4),
    });
    expect([early.status, early.body.error]).toEqual([422, 'deadline_before_package']);

    const [count] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM contracts WHERE client_id = :id',
      { id: client.id },
    );
    expect(Number(count[0]!.n)).toBe(0);
    // Nada reservado: o saldo do cliente segue inteiro.
    const [wallet] = await pool.query<RowDataPacket[]>(
      'SELECT balance, balance_pending FROM wallets WHERE user_id = :id',
      { id: client.id },
    );
    expect(wallet[0]).toMatchObject({ balance: '5000.00', balance_pending: '0.00' });
  });

  it('a troca vale o Básico (o preço do anúncio) e as 2 revisões de sempre (ADR 69)', async () => {
    const { freelancer, s } = await scenario();
    const other = await actor('freelancer');
    const mine = await publish(other, { priceType: 'fixed', price: 100 });

    const res = await request(app)
      .post('/api/barters')
      .set(auth(other))
      .send({ receiverId: freelancer.id, offeredServiceId: mine.id, requestedServiceId: s.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ownedBarters.push(res.body.id as number);
    expect(res.body).toMatchObject({
      estimatedValueRequested: 100,
      requestedValueSource: 'catalog',
      cashDifference: 0,
    });
    const accepted = await request(app)
      .post(`/api/barters/${res.body.id}/accept`)
      .set(auth(freelancer))
      .expect(200);
    ownedContracts.push(accepted.body.contractOfferedId, accepted.body.contractRequestedId);
    const requested = await contractRow(accepted.body.contractRequestedId as number);
    expect(requested).toMatchObject({
      revision_limit: 2,
      package_tier: null,
      package_snapshot: null,
    });
  });
});
