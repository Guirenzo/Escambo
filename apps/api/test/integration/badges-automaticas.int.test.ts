import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { gamificationRepository } from '../../src/modules/gamification/gamification.repository';
import { gamificationService } from '../../src/modules/gamification/gamification.service';
import { DAY, fromNow, startDaytimeClock, stopClock } from './clock.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * Badges automáticas (RF-065, RN-053) contra o MySQL real, pelo fluxo da API: entregas no prazo
 * (a atrasada não conta; por marcos, a revisão pedida no prazo segura a reentrega), clientes que
 * voltam e trocas concluídas, cada uma no limite do seed. A concessão não duplica (evento repetido,
 * em paralelo ou reavaliação), e conta excluída, suspensa ou banida segue a regra do ranking: não
 * ganha badge nova e, como contraparte, não conta.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `int_badges_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { id: login.body.user.id as number, token: login.body.accessToken as string };
}

/** Freelancer com perfil: as badges por critério só são avaliadas para quem tem perfil. */
async function freelancer(fullName: string): Promise<Actor> {
  const actor = await registerAndLogin('freelancer');
  await request(app)
    .put('/api/profiles/freelancer')
    .set(auth(actor.token))
    .send({ fullName, city: 'Joinville', isAvailable: true })
    .expect(200);
  return actor;
}

async function client(balance: number): Promise<Actor> {
  const actor = await registerAndLogin('client');
  await fundWallet(app, actor.token, balance);
  return actor;
}

/** O prazo de cada contratação: 5 dias à frente do relógio do fluxo. */
const deadline = (): Date => fromNow(5 * DAY);

async function propose(
  c: Actor,
  f: Actor,
  extra: Record<string, unknown> = {},
): Promise<{ id: number; deadline: Date }> {
  const due = deadline();
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(c.token))
    .send({
      freelancerId: f.id,
      title: 'Contratação das badges',
      description: 'Contratação do teste de integração das badges automáticas',
      price: 10,
      deadlineAt: due.toISOString(),
      ...extra,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await request(app).post(`/api/contracts/${res.body.id}/accept`).set(auth(f.token)).expect(200);
  return { id: res.body.id as number, deadline: due };
}

/**
 * Proposta → aceite → entrega → aprovação. Com `late`, a entrega sai um dia depois do prazo (o
 * relógio do fluxo anda até lá e volta ao meio-dia de hoje no fim).
 */
async function completeContract(
  c: Actor,
  f: Actor,
  opts: { late?: boolean } = {},
): Promise<number> {
  const { id, deadline: due } = await propose(c, f);
  if (opts.late) startDaytimeClock(new Date(due.getTime() + DAY));
  try {
    await request(app)
      .post(`/api/contracts/${id}/deliver`)
      .set(auth(f.token))
      .send({ message: 'Entrega das badges.' })
      .expect(200);
    const ok = await request(app).post(`/api/contracts/${id}/approve`).set(auth(c.token));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('completed');
  } finally {
    if (opts.late) startDaytimeClock();
  }
  return id;
}

/** Troca equilibrada (sem torna) proposta por `a` e aceita por `b`; devolve os dois contratos. */
async function barter(
  a: Actor,
  b: Actor,
): Promise<{ id: number; aDelivers: number; bDelivers: number }> {
  const created = await request(app).post('/api/barters').set(auth(a.token)).send({
    receiverId: b.id,
    offeredDescription: 'Ofereço uma identidade visual',
    requestedDescription: 'Quero uma landing page',
    estimatedValueOffered: 100,
    estimatedValueRequested: 100,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const accepted = await request(app)
    .post(`/api/barters/${created.body.id}/accept`)
    .set(auth(b.token));
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  return {
    id: created.body.id as number,
    aDelivers: accepted.body.contractOfferedId as number,
    bDelivers: accepted.body.contractRequestedId as number,
  };
}

/** Leva um contrato da troca de 'accepted' a 'completed': quem entrega entrega, o outro aprova. */
async function completeLinked(
  contractId: number,
  deliverer: Actor,
  receiver: Actor,
): Promise<void> {
  await request(app)
    .post(`/api/contracts/${contractId}/deliver`)
    .set(auth(deliverer.token))
    .send({ message: 'Entregue.' })
    .expect(200);
  const ok = await request(app)
    .post(`/api/contracts/${contractId}/approve`)
    .set(auth(receiver.token));
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
}

async function completeBarter(a: Actor, b: Actor): Promise<number> {
  const t = await barter(a, b);
  await completeLinked(t.aDelivers, a, b);
  await completeLinked(t.bDelivers, b, a);
  return t.id;
}

/** As badges de quem, pelo slug, com quantas vezes cada uma aparece. */
async function badgesOf(userId: number): Promise<Record<string, number>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT b.slug, COUNT(*) AS n FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
      WHERE ub.user_id = :userId GROUP BY b.slug`,
    { userId },
  );
  return Object.fromEntries(rows.map((r) => [r.slug as string, Number(r.n)]));
}

/** Os créditos de recompensa da badge, pelo slug (o extrato guarda o id da badge). */
async function rewardsOf(userId: number, slug: string): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT x.amount FROM xp_transactions x JOIN badges b ON b.id = x.reference_id
      WHERE x.user_id = :userId AND x.reason = 'badge_earned' AND b.slug = :slug`,
    { userId, slug },
  );
  return rows.map((r) => Number(r.amount));
}

const setStatus = (userId: number, status: string): Promise<unknown> =>
  pool.query('UPDATE users SET status = :status WHERE id = :id', { status, id: userId });

beforeAll(async () => {
  startDaytimeClock();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('Badges automáticas pelo fluxo (RF-065, RN-053)', () => {
  it('fast-delivery: 20 entregas no prazo; a atrasada não conta e a revisão pedida no prazo segura a reentrega', async () => {
    const f = await freelancer('Freela Pontual');
    const c = await client(400);

    for (let i = 0; i < 19; i += 1) await completeContract(c, f);
    // A vigésima concluída sai um dia depois do prazo: 20 concluídas, 19 no prazo.
    await completeContract(c, f, { late: true });
    expect(await gamificationRepository.countOnTimeDeliveries(f.id)).toBe(19);
    expect(await badgesOf(f.id)).not.toHaveProperty('fast-delivery');

    // Por marcos: os dois entregues no prazo, revisão pedida no prazo e a reentrega já atrasada.
    const { id, deadline: due } = await propose(c, f, {
      price: 20,
      milestones: [
        { title: 'Rascunho', amount: 10 },
        { title: 'Final', amount: 10 },
      ],
    });
    const detail = await request(app).get(`/api/contracts/${id}`).set(auth(f.token));
    const [m1, m2] = detail.body.milestones as { id: number }[];
    for (const m of [m1!, m2!]) {
      await request(app)
        .post(`/api/contracts/${id}/milestones/${m.id}/deliver`)
        .set(auth(f.token))
        .send({ message: 'Marco entregue.' })
        .expect(200);
    }
    await request(app)
      .post(`/api/contracts/${id}/milestones/${m2!.id}/request-revision`)
      .set(auth(c.token))
      .send({ note: 'Ajuste o final' })
      .expect(200);
    startDaytimeClock(new Date(due.getTime() + DAY));
    try {
      await request(app)
        .post(`/api/contracts/${id}/milestones/${m2!.id}/deliver`)
        .set(auth(f.token))
        .send({ message: 'Final ajustado.' })
        .expect(200);
      for (const m of [m1!, m2!]) {
        await request(app)
          .post(`/api/contracts/${id}/milestones/${m.id}/approve`)
          .set(auth(c.token))
          .expect(200);
      }
    } finally {
      startDaytimeClock();
    }

    // A conclusão do marco é o evento: a vigésima no prazo concede a badge com a recompensa.
    expect(await gamificationRepository.countOnTimeDeliveries(f.id)).toBe(20);
    expect(await badgesOf(f.id)).toMatchObject({ 'fast-delivery': 1 });
    expect(await rewardsOf(f.id, 'fast-delivery')).toEqual([100]);
    const me = await request(app).get('/api/gamification/me').set(auth(f.token));
    expect(me.body.badges.map((b: { slug: string }) => b.slug)).toContain('fast-delivery');

    // O mesmo evento repetido, em paralelo, e a reavaliação: nada se repete.
    await Promise.all([
      gamificationService.evaluateBadges(f.id),
      gamificationService.evaluateBadges(f.id),
      gamificationService.onBarterCompleted(f.id),
    ]);
    await gamificationService.reevaluateAll();
    expect(await badgesOf(f.id)).toMatchObject({ 'fast-delivery': 1 });
    expect(await rewardsOf(f.id, 'fast-delivery')).toEqual([100]);
  }, 180_000);

  it('client-favorite: 5 clientes que voltam; cliente banido não conta e o freelancer suspenso espera a reavaliação', async () => {
    const f = await freelancer('Freela Querida');
    const banned = await client(50);
    const regulars = await Promise.all([1, 2, 3, 4, 5].map(() => client(50)));

    // Um cliente que voltou e depois foi banido: como no ranking, ele não conta.
    await completeContract(banned, f);
    await completeContract(banned, f);
    expect(await gamificationRepository.countRepeatClients(f.id)).toBe(1);
    await setStatus(banned.id, 'banned');
    expect(await gamificationRepository.countRepeatClients(f.id)).toBe(0);

    // Quatro clientes que voltam e um quinto só com a primeira: 4 de 5.
    for (const c of regulars.slice(0, 4)) {
      await completeContract(c, f);
      await completeContract(c, f);
    }
    const fifth = regulars[4]!;
    await completeContract(fifth, f);
    expect(await gamificationRepository.countRepeatClients(f.id)).toBe(4);
    expect(await badgesOf(f.id)).not.toHaveProperty('client-favorite');

    // A segunda do quinto cliente é aprovada com o freelancer já suspenso: conta fora do ranking
    // não ganha badge nova, mesmo com o critério cumprido.
    const { id } = await propose(fifth, f);
    await request(app)
      .post(`/api/contracts/${id}/deliver`)
      .set(auth(f.token))
      .send({ message: 'Entrega da volta.' })
      .expect(200);
    await setStatus(f.id, 'suspended');
    await request(app).post(`/api/contracts/${id}/approve`).set(auth(fifth.token)).expect(200);
    expect(await gamificationRepository.countRepeatClients(f.id)).toBe(5);
    expect(await badgesOf(f.id)).not.toHaveProperty('client-favorite');

    // Reativado, a reavaliação concede uma vez só, com a recompensa; a segunda rodada não muda nada.
    await setStatus(f.id, 'active');
    const first = await gamificationService.reevaluateAll();
    expect(first.failed).toBe(0);
    expect(first.awarded).toBeGreaterThanOrEqual(1);
    await gamificationService.reevaluateAll();
    expect(await badgesOf(f.id)).toMatchObject({ 'client-favorite': 1 });
    expect(await rewardsOf(f.id, 'client-favorite')).toEqual([150]);
  }, 180_000);

  it('bom-de-troca: 5 trocas concluídas; a de quem foi banido não conta e a troca pela metade também não', async () => {
    const f = await freelancer('Freela da Troca');
    const gone = await registerAndLogin('freelancer');
    const partner = await registerAndLogin('freelancer');
    const last = await registerAndLogin('freelancer');

    await completeBarter(f, gone);
    expect(await gamificationRepository.countBartersCompleted(f.id)).toBe(1);
    await setStatus(gone.id, 'banned');
    expect(await gamificationRepository.countBartersCompleted(f.id)).toBe(0);

    // Quatro trocas com o mesmo parceiro, ora propostas por um, ora pelo outro.
    for (let i = 0; i < 4; i += 1) {
      if (i % 2 === 0) await completeBarter(f, partner);
      else await completeBarter(partner, f);
    }
    expect(await gamificationRepository.countBartersCompleted(f.id)).toBe(4);
    expect(await badgesOf(f.id)).not.toHaveProperty('bom-de-troca');

    // Quinta troca: com só um lado concluído ela ainda não conta.
    const t = await barter(f, last);
    await completeLinked(t.aDelivers, f, last);
    expect(await gamificationRepository.countBartersCompleted(f.id)).toBe(4);
    expect(await badgesOf(f.id)).not.toHaveProperty('bom-de-troca');

    // O último contrato é o que o outro lado entrega: a conclusão dele é do parceiro, então a badge
    // de `f` só pode vir do gancho da troca.
    await completeLinked(t.bDelivers, last, f);
    const done = await request(app).get(`/api/barters/${t.id}`).set(auth(f.token));
    expect(done.body.status).toBe('completed');
    expect(await gamificationRepository.countBartersCompleted(f.id)).toBe(5);
    expect(await badgesOf(f.id)).toMatchObject({ 'bom-de-troca': 1 });
    expect(await rewardsOf(f.id, 'bom-de-troca')).toEqual([120]);

    // Gancho repetido e reavaliação: nem badge nem crédito em dobro.
    await Promise.all([
      gamificationService.onBarterCompleted(f.id),
      gamificationService.onBarterCompleted(f.id),
    ]);
    await gamificationService.reevaluateAll();
    expect(await badgesOf(f.id)).toMatchObject({ 'bom-de-troca': 1 });
    expect(await rewardsOf(f.id, 'bom-de-troca')).toEqual([120]);
  }, 180_000);
});
