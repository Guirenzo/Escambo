import type { BrazilTimezone, ContractWithHistory } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { runDeadlineReminders } from '../../src/jobs/deadline-reminders';
import { settingsRepository } from '../../src/modules/settings/settings.repository';
import { settingsService } from '../../src/modules/settings/settings.service';
import { walletRepository } from '../../src/modules/wallet/wallet.repository';
import { setClockForTests } from '../../src/utils/clock';
import { endOfDayIn } from '../../src/utils/timezone';
import { withLegacyParallelContracts } from './helpers/legacy-parallel-contracts';

/** G.6: API e configuração reais, snapshots persistidos e duas instâncias do lembrete no InnoDB. */
const app = createApp();
const HOUR = 3_600_000;
const MANAUS: BrazilTimezone = 'America/Manaus';
const NORONHA: BrazilTimezone = 'America/Noronha';
// A validação HTTP também consulta Date.now(): os dias escolhidos precisam estar no futuro real.
const base = new Date(Date.now() + 3 * 24 * HOUR);
const at = (days: number, hour: number, minute = 0, second = 0): Date =>
  new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate() + days,
      hour,
      minute,
      second,
    ),
  );
const setNow = (date: Date): void => setClockForTests(date, { frozen: true });
const settingKeys = [
  'counter_offer_response_hours',
  'extension_response_hours',
  'proposal_expiry_hours',
] as const;
type SettingKey = (typeof settingKeys)[number];
interface Actor {
  id: number;
  token: string;
}
const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
let admin: Actor;
const originals = new Map<SettingKey, number>();

async function actor(
  role: 'client' | 'freelancer' | 'admin',
  zone: BrazilTimezone,
  credits = 100,
): Promise<Actor> {
  const key = ulid();
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone, email_verified_at)
     VALUES (:key, :email, :role, 'active', :zone, NOW())`,
    { key, email: `adversarial-${key}@escambo.test`, role, zone },
  );
  await walletRepository.ensure(created.insertId);
  await pool.query(
    'UPDATE wallets SET balance = 600, credits_balance = :credits WHERE user_id = :id',
    { id: created.insertId, credits },
  );
  return {
    id: created.insertId,
    token: jwt.sign({ sub: key, uid: created.insertId, role }, env.JWT_SECRET, { expiresIn: '1h' }),
  };
}
async function parties(clientZone = MANAUS, freelancerZone = NORONHA, credits = 100) {
  return {
    client: await actor('client', clientZone, credits),
    freelancer: await actor('freelancer', freelancerZone, 0),
  };
}
async function setting(key: SettingKey, value: number) {
  const saved = await request(app)
    .put(`/api/admin/settings/${key}`)
    .set(auth(admin))
    .send({ value });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body).toMatchObject({ key, value });
}
async function create(
  client: Actor,
  freelancer: Actor,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client))
    .send({
      freelancerId: freelancer.id,
      title: 'G.6 negociação fictícia',
      description: 'Termos e datas para a revisão adversarial de negociação',
      price: 100,
      ...extra,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}
async function detail(id: number, client: Actor): Promise<ContractWithHistory> {
  const res = await request(app).get(`/api/contracts/${id}`).set(auth(client));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ContractWithHistory;
}
const counter = (
  id: number,
  who: Actor,
  seq: number,
  price: number,
  extra: Record<string, unknown> = {},
) =>
  request(app)
    .post(`/api/contracts/${id}/offers`)
    .set(auth(who))
    .send({ seq, price, deadlineAt: null, message: 'Ajuste dos termos desta rodada', ...extra });
async function offer(
  id: number,
  who: Actor,
  seq: number,
  price: number,
  extra: Record<string, unknown> = {},
) {
  const res = await counter(id, who, seq, price, extra);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as ContractWithHistory;
}
async function persistedOffers(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT seq, respond_by FROM contract_offers WHERE contract_id = :id ORDER BY seq',
    { id },
  );
  return rows.map((row) => ({ seq: Number(row.seq), due: new Date(row.respond_by).toISOString() }));
}
function expectWindow(due: string, now: Date, zone: BrazilTimezone, deadline?: Date) {
  const instant = new Date(due);
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(
      instant,
    ),
  );
  expect(hour).toBeGreaterThanOrEqual(9);
  expect(hour).toBeLessThan(21);
  expect(instant.getTime() - now.getTime()).toBeGreaterThanOrEqual(HOUR);
  if (deadline) expect(instant.getTime()).toBeLessThanOrEqual(deadline.getTime());
}
const matrix = [24, 168].flatMap((hours) =>
  [MANAUS, NORONHA].map((clientZone) => ({
    hours,
    clientZone,
    freelancerZone: clientZone === MANAUS ? NORONHA : MANAUS,
  })),
);
// Às 23:45Z, Manaus marca 19:45 e Noronha 21:45. As expectativas são calendários explícitos.
const expectedDue = (zone: BrazilTimezone, hours: number) =>
  zone === MANAUS ? at(hours / 24, 23, 45) : at(hours / 24 + 1, 11);

beforeAll(async () => {
  setNow(at(0, 16));
  admin = await actor('admin', MANAUS);
  for (const key of settingKeys)
    originals.set(
      key,
      await settingsRepository.getNumber(key, key === 'proposal_expiry_hours' ? 72 : 48),
    );
});
beforeEach(async () => {
  setNow(at(0, 16));
  await setting('counter_offer_response_hours', 48);
  await setting('extension_response_hours', 48);
  await setting('proposal_expiry_hours', 72);
});
afterAll(async () => {
  try {
    for (const [key, value] of originals) await setting(key, value);
  } finally {
    settingsService.clearCache();
    setClockForTests(null);
    await pool.end();
  }
});

describe('G.6: extremos do painel e Manaus × Noronha pela API', () => {
  it.each(matrix)(
    '$hours h, cliente $clientZone: duas paridades e extensão gravam a hora de quem responde',
    async ({ hours, clientZone, freelancerZone }) => {
      await setting('counter_offer_response_hours', hours);
      await setting('extension_response_hours', hours);
      const pub = await request(app).get('/api/settings/public').expect(200);
      expect(pub.body).toMatchObject({
        counterOfferResponseHours: hours,
        extensionResponseHours: hours,
      });
      const { client, freelancer } = await parties(clientZone, freelancerZone);
      const id = await create(client, freelancer);
      const night = at(0, 23, 45);
      setNow(night);
      const even = await offer(id, freelancer, 1, 110);
      expect(even.negotiation!.respondBy).toBe(expectedDue(clientZone, hours).toISOString());
      expectWindow(even.negotiation!.respondBy!, night, clientZone);
      const odd = await offer(id, client, 2, 105);
      expect(odd.negotiation!.respondBy).toBe(expectedDue(freelancerZone, hours).toISOString());
      expectWindow(odd.negotiation!.respondBy!, night, freelancerZone);
      const snapshots = await persistedOffers(id);
      expect(snapshots.slice(1)).toEqual([
        { seq: 2, due: expectedDue(clientZone, hours).toISOString() },
        { seq: 3, due: expectedDue(freelancerZone, hours).toISOString() },
      ]);

      setNow(at(0, 16));
      const current = endOfDayIn(freelancerZone, at(15, 16).toISOString().slice(0, 10));
      const proposed = endOfDayIn(freelancerZone, at(25, 16).toISOString().slice(0, 10));
      // Preserva a comparação dos snapshots em contratações históricas paralelas pré-RN-020.
      const extensionId = await withLegacyParallelContracts(client.id, freelancer.id, () =>
        create(client, freelancer, { deadlineAt: current.toISOString() }),
      );
      await request(app)
        .post(`/api/contracts/${extensionId}/accept`)
        .set(auth(freelancer))
        .expect(200);
      setNow(night);
      const asked = await request(app)
        .post(`/api/contracts/${extensionId}/extension`)
        .set(auth(freelancer))
        .send({
          deadlineAt: proposed.toISOString(),
          reason: 'Mais tempo para concluir a entrega combinada',
        })
        .expect(200);
      expect(asked.body.extension.respondBy).toBe(expectedDue(clientZone, hours).toISOString());
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT extension_respond_by FROM contracts WHERE id = :id',
        { id: extensionId },
      );
      expect(new Date(rows[0]!.extension_respond_by).toISOString()).toBe(
        expectedDue(clientZone, hours).toISOString(),
      );
      expect(new Date(asked.body.extension.respondBy).getTime()).toBeLessThanOrEqual(
        proposed.getTime() - 12 * HOUR,
      );

      await setting('counter_offer_response_hours', hours === 24 ? 168 : 24);
      await setting('extension_response_hours', hours === 24 ? 168 : 24);
      expect(await persistedOffers(id)).toEqual(snapshots);
      expect((await detail(extensionId, client)).extension!.respondBy).toBe(
        asked.body.extension.respondBy,
      );
    },
  );

  it.each(matrix)(
    '$hours h, cliente $clientZone: teto do prazo aceita uma hora exata e recusa um segundo a menos',
    async ({ hours, clientZone, freelancerZone }) => {
      await setting('counter_offer_response_hours', hours);
      const { client, freelancer } = await parties(clientZone, freelancerZone);
      const initialDeadline = endOfDayIn(freelancerZone, at(10, 16).toISOString().slice(0, 10));
      const exact = await create(client, freelancer, { deadlineAt: initialDeadline.toISOString() });
      const short = await withLegacyParallelContracts(client.id, freelancer.id, () =>
        create(client, freelancer, { deadlineAt: initialDeadline.toISOString() }),
      );
      const deadline = clientZone === MANAUS ? at(1, 1, 59, 59) : at(1, 3, 59, 59);
      const cap = clientZone === MANAUS ? at(1, 0, 29, 59) : at(0, 22, 29, 59);
      const now = new Date(cap.getTime() - HOUR);
      setNow(now);
      const accepted = await offer(exact, freelancer, 1, 110, {
        deadlineAt: deadline.toISOString(),
      });
      expect(accepted.negotiation!.respondBy).toBe(cap.toISOString());
      expectWindow(accepted.negotiation!.respondBy!, now, clientZone, deadline);
      const before = await detail(short, client);
      setNow(new Date(now.getTime() + 1000));
      const rejected = await counter(short, freelancer, 1, 110, {
        deadlineAt: deadline.toISOString(),
      });
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
      expect(rejected.body.error).toBe('deadline_too_soon');
      const after = await detail(short, client);
      expect(after.offers).toEqual(before.offers);
      expect(after).toMatchObject({ status: 'pending', price: 100 });
    },
  );
});

async function reminderLedger(id: number, kind: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT due_at, seq FROM deadline_reminders WHERE entity_id = :id AND kind = :kind ORDER BY seq',
    { id, kind },
  );
  return rows.map((row) => ({ due: new Date(row.due_at).toISOString(), seq: Number(row.seq) }));
}
async function notes(id: number, user: Actor, type: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT body, data FROM notifications WHERE user_id = :user AND type = :type ORDER BY id',
    { user: user.id, type },
  );
  return rows.filter((row) => {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    return data?.contractId === id;
  });
}
/** Ambas as instâncias leem a candidata antes de esperar a mesma trava real. */
async function twoJobs(id: number, now: Date, kind: 'proposal' | 'counter_offer') {
  setNow(now);
  const blocker = await pool.getConnection();
  let work: Promise<Awaited<ReturnType<typeof runDeadlineReminders>>[]> | undefined;
  try {
    await blocker.beginTransaction();
    await blocker.query('SELECT id FROM contracts WHERE id = :id FOR UPDATE', { id });
    work = Promise.all([runDeadlineReminders(now), runDeadlineReminders(now)]);
    let waiting = 0;
    const until = Date.now() + 5000;
    while (waiting < 2 && Date.now() < until) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS waiting FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'contracts'`,
      );
      waiting = Number(rows[0]!.waiting);
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting, 'duas instâncias esperam a contratação no InnoDB').toBeGreaterThanOrEqual(2);
  } finally {
    await blocker.rollback();
    blocker.release();
    if (work) await work;
  }
  const result = await work!;
  expect(result.flatMap((row) => row.sent[kind]).filter((value) => value === id)).toEqual([id]);
  expect(result.flatMap((row) => row.failed)).not.toContain(id);
}

describe('G.6: livro dos lembretes no MySQL', () => {
  it.each(['counter_offer', 'proposal'] as const)(
    '%s: duas instâncias, duas ofertas com a mesma hora e um aviso por armação',
    async (kind) => {
      const { client, freelancer } = await parties();
      const id = await create(client, freelancer);
      await offer(id, freelancer, 1, 110);
      if (kind === 'proposal') await offer(id, client, 2, 105);
      const recipient = kind === 'counter_offer' ? client : freelancer;
      const other = kind === 'counter_offer' ? freelancer : client;
      const type =
        kind === 'counter_offer' ? 'contract_counter_offer_reminder' : 'contract_proposal_reminder';
      const slotHour = kind === 'counter_offer' ? 13 : 11;
      const firstDue = (await detail(id, client)).negotiation!.respondBy!;
      expect(firstDue).toBe(at(2, 16).toISOString());
      await twoJobs(id, at(1, slotHour), kind);
      expect(await notes(id, recipient, type)).toHaveLength(1);
      expect(await notes(id, other, type)).toEqual([]);

      setNow(at(1, 16));
      await setting('counter_offer_response_hours', 24);
      if (kind === 'counter_offer') {
        await offer(id, client, 2, 105);
        await offer(id, freelancer, 3, 120);
      } else {
        await offer(id, freelancer, 3, 120);
        await offer(id, client, 4, 115);
      }
      const latest = await detail(id, client);
      expect(latest.negotiation!.respondBy).toBe(firstDue);
      expect(latest.negotiation!.seq).toBe(kind === 'counter_offer' ? 4 : 5);
      await twoJobs(id, at(2, slotHour), kind);
      expect(await reminderLedger(id, kind)).toEqual([
        { due: firstDue, seq: 2 },
        { due: firstDue, seq: 4 },
      ]);
      const sent = await notes(id, recipient, type);
      expect(sent).toHaveLength(2);
      if (kind === 'counter_offer') {
        expect(sent[0]!.body).toContain('R$ 110,00');
        expect(sent[1]!.body).toContain('R$ 120,00');
        expect(sent[1]!.body).toContain('(a última)');
      } else {
        expect(sent[0]!.body).toContain('faça uma contraproposta');
        expect(sent[1]!.body).toContain('É a última rodada: aceite ou recuse até lá.');
        expect(sent[1]!.body).not.toContain('faça uma contraproposta');
      }
      await runDeadlineReminders(at(2, slotHour, 5));
      expect(await notes(id, recipient, type)).toHaveLength(2);
      expect(await reminderLedger(id, kind)).toHaveLength(2);
    },
  );

  it('proposta legada sem snapshot usa seq0 e conserva a deduplicação depois de duas instâncias', async () => {
    const { client, freelancer } = await parties();
    const id = await create(client, freelancer);
    const due = (await detail(id, client)).negotiation!.respondBy!;
    // Simula uma contratação pré-ADR61: a validade e a criação históricas permanecem no contrato.
    await pool.query('DELETE FROM contract_offers WHERE contract_id = :id', { id });
    await pool.query(
      'UPDATE contracts SET fee_percentage = NULL, revision_limit = NULL WHERE id = :id',
      { id },
    );
    await twoJobs(id, at(2, 11), 'proposal');
    expect(await reminderLedger(id, 'proposal')).toEqual([{ due, seq: 0 }]);
    expect(await notes(id, freelancer, 'contract_proposal_reminder')).toHaveLength(1);
    await runDeadlineReminders(at(2, 11, 5));
    expect(await reminderLedger(id, 'proposal')).toEqual([{ due, seq: 0 }]);
    expect(await notes(id, freelancer, 'contract_proposal_reminder')).toHaveLength(1);
    expect(await notes(id, client, 'contract_proposal_reminder')).toEqual([]);
    expect(await persistedOffers(id)).toEqual([]);
  });
});

it('créditos insuficientes no aceite da contraproposta não mudam preço, oferta, marcos ou ledger; a mesma oferta pode ser aceita depois', async () => {
  const { client, freelancer } = await parties(MANAUS, NORONHA, 30);
  const id = await create(client, freelancer, {
    paymentMode: 'credits',
    price: 30,
    milestones: [
      { title: 'Rascunho', amount: 10 },
      { title: 'Entrega', amount: 20 },
    ],
  });
  const beforeOffer = await detail(id, client);
  await offer(id, freelancer, 1, 35, {
    milestones: beforeOffer.milestones.map((m, index) => ({
      id: m.id,
      amount: index === 0 ? 15 : 20,
      dueAt: null,
    })),
  });
  const state = async () => {
    const contract = await detail(id, client);
    const [wallets] = await pool.query<RowDataPacket[]>(
      'SELECT user_id, balance, balance_pending, credits_balance, credits_pending FROM wallets WHERE user_id IN (:client, :freelancer) ORDER BY user_id',
      { client: client.id, freelancer: freelancer.id },
    );
    const [cash] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM wallet_transactions WHERE contract_id = :id ORDER BY id',
      { id },
    );
    const [credits] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM credit_transactions WHERE contract_id = :id ORDER BY id',
      { id },
    );
    return {
      status: contract.status,
      price: contract.price,
      offers: contract.offers,
      milestones: contract.milestones,
      wallets,
      cash,
      credits,
    };
  };
  const before = await state();
  const refused = await request(app).post(`/api/contracts/${id}/offers/2/accept`).set(auth(client));
  expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  expect(refused.body.error).toBe('insufficient_credits');
  expect(await state()).toEqual(before);
  expect(before.cash).toEqual([]);
  expect(before.credits).toEqual([]);
  await pool.query('UPDATE wallets SET credits_balance = 35 WHERE user_id = :id', {
    id: client.id,
  });
  const accepted = await request(app)
    .post(`/api/contracts/${id}/offers/2/accept`)
    .set(auth(client))
    .expect(200);
  expect(accepted.body).toMatchObject({
    status: 'accepted',
    price: 35,
    platformFee: 0,
    freelancerNet: 35,
  });
  expect(
    accepted.body.milestones.map((m: { amount: number; status: string }) => [m.amount, m.status]),
  ).toEqual([
    [15, 'funded'],
    [20, 'funded'],
  ]);
  const after = await state();
  expect(after.cash).toEqual([]);
  expect(after.credits.map((row) => [row.user_id, Number(row.amount), row.reason])).toEqual([
    [client.id, -35, 'escrow_hold'],
    [freelancer.id, 35, 'escrow_in'],
  ]);
});
