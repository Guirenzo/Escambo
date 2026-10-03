import type { BrazilTimezone } from '@escambo/types';
import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { fundWallet } from './wallet.helpers';
import { runTacitApproval } from '../../src/jobs/tacit-approval';
import { contractsRepository } from '../../src/modules/contracts/contracts.repository';
import { contractsService } from '../../src/modules/contracts/contracts.service';
import {
  milestonesRepository,
  type DueMilestoneRow,
} from '../../src/modules/contracts/milestones.repository';
import { gamificationService } from '../../src/modules/gamification/gamification.service';
import { setClockForTests } from '../../src/utils/clock';
import { formatDue } from '../../src/utils/timezone';
import { DAY, fromNow, HOUR, now, startDaytimeClock, stopClock } from './clock.helpers';

/**
 * Aprovação tácita (RN-024, ADR 57): a hora é gravada na entrega (5 dias corridos, nunca de noite
 * no fuso do cliente) e o job aprova quando ela passa, com liberação do escrow e registro no
 * histórico. Entregas recentes ficam como estão; de noite no fuso do cliente, nada acontece.
 * ADR 58: a tácita move dinheiro sozinha, então avisa as duas partes (o cliente, com até quando
 * pode avaliar; o freelancer, com o líquido); os marcos vencidos da mesma contratação viram um aviso
 * só para cada parte, e a conclusão roda uma vez. A tácita que perde para a aprovação manual não
 * avisa nada.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const BRASILIA: BrazilTimezone = 'America/Sao_Paulo';
const MANAUS: BrazilTimezone = 'America/Manaus';

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  timezone: BrazilTimezone | null = null,
): Promise<Actor> {
  const email = `tacit_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const id = login.body.user.id as number;
  if (timezone)
    await pool.query('UPDATE users SET timezone = :timezone WHERE id = :id', { id, timezone });
  return { id, token: login.body.accessToken };
}

/** Contratação entregue (create → accept → deliver). */
async function deliveredContract(client: Actor, freelancer: Actor, title: string): Promise<number> {
  const created = await request(app).post('/api/contracts').set(auth(client.token)).send({
    freelancerId: freelancer.id,
    title,
    description: 'Contratação do teste de aprovação tácita',
    price: 200,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as number;
  const acc = await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token));
  expect(acc.status).toBe(200);
  const del = await request(app)
    .post(`/api/contracts/${id}/deliver`)
    .set(auth(freelancer.token))
    .send({ message: 'Entregue.' });
  expect(del.status).toBe(200);
  return id;
}

/**
 * Contratação por marcos (R$ 100 + R$ 100; com `credits`, esses créditos), aceita, com os dois
 * marcos entregues.
 */
async function deliveredMilestones(
  client: Actor,
  freelancer: Actor,
  title: string,
  credits: [number, number] | null = null,
): Promise<{ id: number; m1: number; m2: number }> {
  const [a1, a2] = credits ?? [100, 100];
  const created = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title,
      description: 'Contratação por marcos do teste de aprovação tácita',
      price: a1 + a2,
      ...(credits ? { paymentMode: 'credits' } : {}),
      milestones: [
        { title: 'Rascunho', amount: a1 },
        { title: 'Arte final', amount: a2 },
      ],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as number;
  const acc = await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token));
  expect(acc.status).toBe(200);
  const shown = await request(app).get(`/api/contracts/${id}`).set(auth(client.token));
  const [m1, m2] = (shown.body.milestones as { id: number }[]).map((m) => m.id);
  for (const m of [m1!, m2!]) {
    const del = await request(app)
      .post(`/api/contracts/${id}/milestones/${m}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'Arquivos no chat.' });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
  }
  return { id, m1: m1!, m2: m2! };
}

interface Notice {
  title: string;
  body: string | null;
}

/** Os avisos de um tipo que a pessoa recebeu sobre a contratação, em ordem de chegada. */
async function noticesOf(userId: number, type: string, contractId: number): Promise<Notice[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT title, body, data FROM notifications WHERE user_id = :userId AND type = :type ORDER BY id',
    { userId, type },
  );
  return rows
    .filter((r) => {
      const data = (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as {
        contractId?: number;
      } | null;
      return data?.contractId === contractId;
    })
    .map((r) => ({ title: r.title as string, body: r.body as string | null }));
}

/** O envio é "melhor esforço", depois da gravação: espera chegarem `n` avisos e devolve todos. */
async function waitNotices(
  userId: number,
  type: string,
  contractId: number,
  n: number,
): Promise<Notice[]> {
  await expect.poll(async () => (await noticesOf(userId, type, contractId)).length).toBe(n);
  return noticesOf(userId, type, contractId);
}

/** Dá tempo a um envio que não deveria acontecer (o "melhor esforço" sai depois da gravação). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 500));

async function completedAt(id: number): Promise<Date> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT status, completed_at FROM contracts WHERE id = :id',
    { id },
  );
  expect(rows[0]?.status).toBe('completed');
  return new Date(rows[0]!.completed_at as Date);
}

beforeAll(async () => {
  startDaytimeClock();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('Aprovação tácita (job)', () => {
  it('aprova a entrega vencida, libera o escrow e registra o motivo; a recente fica entregue', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 400);

    const old = await deliveredContract(client, freelancer, 'Entrega antiga sem resposta');
    const recent = await deliveredContract(client, freelancer, 'Entrega recente');

    // A hora foi gravada na entrega: 5 dias corridos depois, de dia no fuso do cliente.
    const [[row]] = (await pool.query('SELECT approval_due_at FROM contracts WHERE id = :id', {
      id: recent,
    })) as unknown as [[{ approval_due_at: Date }]];
    const due = new Date(row.approval_due_at).getTime();
    expect(due).toBeGreaterThanOrEqual(now().getTime() + 5 * DAY - 2000);
    expect(due).toBeLessThanOrEqual(now().getTime() + 5 * DAY + 13 * HOUR);
    const shown = await request(app).get(`/api/contracts/${recent}`).set(auth(client.token));
    expect(shown.body.approvalDueAt).toBe(new Date(due).toISOString());

    // Simula o tempo: a aprovação tácita da antiga já venceu.
    await pool.query('UPDATE contracts SET approval_due_at = :due WHERE id = :id', {
      id: old,
      due: fromNow(-HOUR),
    });

    // De noite (03:00 em Brasília, 01:00 em Rio Branco…) o job não aprova nada.
    const night = new Date(now().getTime() + 15 * HOUR);
    expect((await runTacitApproval(night)).approved).not.toContain(old);

    const result = await runTacitApproval(now());
    expect(result.zones.length).toBeGreaterThan(0);
    expect(result.approved).toContain(old);
    expect(result.approved).not.toContain(recent);
    expect(result.failed).toEqual([]);

    const oldDetail = await request(app).get(`/api/contracts/${old}`).set(auth(client.token));
    expect(oldDetail.body.status).toBe('completed');
    const last = oldDetail.body.history.at(-1);
    expect(last).toMatchObject({ status: 'completed', previousStatus: 'delivered' });
    expect(String(last.note)).toContain('Aprovação tácita');

    const recentDetail = await request(app).get(`/api/contracts/${recent}`).set(auth(client.token));
    expect(recentDetail.body.status).toBe('delivered');

    // Escrow da antiga liberado (200 - 15% = 170); a recente segue retida.
    const wallet = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(wallet.body).toMatchObject({ balance: 170, balancePending: 170 });

    // Idempotente: rodar de novo não aprova nada a mais.
    const again = await runTacitApproval(now());
    expect(again.approved).not.toContain(old);
    expect(again.approved).not.toContain(recent);
  });
});

describe('A tácita avisa as duas partes (ADR 58)', () => {
  it('entrega única: o cliente lê que foi aprovada e até quando pode avaliar; o freelancer, o líquido que entrou, cada um no seu fuso', async () => {
    const client = await registerAndLogin('client', MANAUS);
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 200);
    const title = 'Logo da padaria';
    const id = await deliveredContract(client, freelancer, title);
    const due = fromNow(-HOUR);
    await pool.query('UPDATE contracts SET approval_due_at = :due WHERE id = :id', { id, due });

    const t = now();
    const result = await runTacitApproval(t);
    expect(result.approved).toContain(id);
    expect(result.failed).not.toContain(id);
    // A conclusão é gravada no relógio do fluxo: é dela que conta a janela da avaliação.
    expect((await completedAt(id)).toISOString()).toBe(t.toISOString());

    const [toClient] = await waitNotices(client.id, 'contract_auto_approved', id, 1);
    expect(toClient).toEqual({
      title: `Aprovada automaticamente: ${title}`,
      body: `Sem resposta até ${formatDue(due, MANAUS)}, a entrega foi aprovada e o pagamento foi liberado ao freelancer (contratação de R$ 200,00). Você pode avaliar até ${formatDue(new Date(t.getTime() + 7 * DAY), MANAUS)}.`,
    });
    const [toFreelancer] = await waitNotices(freelancer.id, 'contract_completed', id, 1);
    expect(toFreelancer).toEqual({
      title: `Contratação concluída: ${title}`,
      body: `Sem resposta do cliente até ${formatDue(due, BRASILIA)}, a entrega foi aprovada automaticamente e R$ 170,00 foi liberado na sua carteira.`,
    });
    // Nenhuma cópia trocada: o cliente não recebe a do freelancer, nem o contrário.
    expect(await noticesOf(client.id, 'contract_completed', id)).toEqual([]);
    expect(await noticesOf(freelancer.id, 'contract_auto_approved', id)).toEqual([]);
  });

  it('dois marcos vencidos da mesma contratação: um aviso a cada parte, o último vira contract_completed e a conclusão roda uma vez', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer', MANAUS);
    await fundWallet(app, client.token, 200);
    const title = 'Cardápio da padaria';
    const { id, m1, m2 } = await deliveredMilestones(client, freelancer, title);
    const due = fromNow(-HOUR);
    await pool.query('UPDATE contract_milestones SET approval_due_at = :due WHERE id IN (:ids)', {
      due,
      ids: [m1, m2],
    });
    const completed = vi.spyOn(gamificationService, 'onContractCompleted');

    const t = now();
    const result = await runTacitApproval(t);
    expect(result.milestones).toEqual(expect.arrayContaining([m1, m2]));
    expect(result.failed).not.toContain(id);
    expect((await completedAt(id)).toISOString()).toBe(t.toISOString());
    // A conclusão (XP, troca) roda uma vez para a contratação, não uma por marco.
    expect(completed.mock.calls.filter(([, contractId]) => contractId === id)).toEqual([
      [freelancer.id, id],
    ]);

    const [toClient] = await waitNotices(client.id, 'contract_auto_approved', id, 1);
    expect(toClient).toEqual({
      title: `2 marcos aprovados automaticamente: ${title}`,
      body: `Sem resposta até ${formatDue(due, BRASILIA)}, os marcos «Rascunho» e «Arte final» foram aprovados e o pagamento deles foi liberado ao freelancer (R$ 200,00 ao todo). Era o que faltava: a contratação foi concluída, e você pode avaliar até ${formatDue(new Date(t.getTime() + 7 * DAY), BRASILIA)}.`,
    });
    const [toFreelancer] = await waitNotices(freelancer.id, 'contract_completed', id, 1);
    expect(toFreelancer).toEqual({
      title: `Contratação concluída: ${title}`,
      body: `Sem resposta do cliente até ${formatDue(due, MANAUS)}, os marcos «Rascunho» e «Arte final» foram aprovados automaticamente e R$ 170,00 foi liberado na sua carteira. Eram os que faltavam.`,
    });
    // Um aviso só para cada parte: nenhum aviso por marco além do agrupado.
    await settle();
    expect(await noticesOf(client.id, 'contract_auto_approved', id)).toHaveLength(1);
    expect(await noticesOf(freelancer.id, 'contract_completed', id)).toHaveLength(1);
    expect(await noticesOf(freelancer.id, 'milestone_approved', id)).toEqual([]);

    const wallet = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(wallet.body).toMatchObject({ balance: 170, balancePending: 0 });
  });

  it('falha no meio do grupo: o marco aprovado é avisado sozinho e o outro fica para a próxima rodada, com aviso próprio', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 200);
    const title = 'Placa da fachada';
    const { id, m1, m2 } = await deliveredMilestones(client, freelancer, title);
    const due = fromNow(-HOUR);
    await pool.query('UPDATE contract_milestones SET approval_due_at = :due WHERE id IN (:ids)', {
      due,
      ids: [m1, m2],
    });

    const original = milestonesRepository.approve.bind(milestonesRepository);
    vi.spyOn(milestonesRepository, 'approve').mockImplementation(async (p) => {
      if (p.milestoneId === m2) throw new Error('falha simulada ao aprovar o marco');
      return original(p);
    });
    const first = await runTacitApproval(now());
    expect(first.milestones).toContain(m1);
    expect(first.milestones).not.toContain(m2);
    expect(first.failed).toContain(id);
    vi.restoreAllMocks();

    expect(await waitNotices(client.id, 'contract_auto_approved', id, 1)).toEqual([
      {
        title: 'Marco aprovado automaticamente: Rascunho',
        body: `${title}: sem resposta até ${formatDue(due, BRASILIA)}, o marco foi aprovado e o pagamento dele foi liberado ao freelancer (marco de R$ 100,00).`,
      },
    ]);
    expect(await waitNotices(freelancer.id, 'milestone_approved', id, 1)).toEqual([
      {
        title: 'Marco aprovado automaticamente: Rascunho',
        body: `${title}: sem resposta do cliente até ${formatDue(due, BRASILIA)}, R$ 85,00 foi liberado na sua carteira.`,
      },
    ]);
    const midway = await request(app).get(`/api/contracts/${id}`).set(auth(client.token));
    expect(midway.body.status).toBe('in_progress');

    const t = now();
    const second = await runTacitApproval(t);
    expect(second.milestones).toContain(m2);
    expect(second.failed).not.toContain(id);
    const toClient = await waitNotices(client.id, 'contract_auto_approved', id, 2);
    expect(toClient[1]).toEqual({
      title: 'Marco aprovado automaticamente: Arte final',
      body: `${title}: sem resposta até ${formatDue(due, BRASILIA)}, o marco foi aprovado e o pagamento dele foi liberado ao freelancer (marco de R$ 100,00). Era o que faltava: a contratação foi concluída, e você pode avaliar até ${formatDue(new Date(t.getTime() + 7 * DAY), BRASILIA)}.`,
    });
    expect(await waitNotices(freelancer.id, 'contract_completed', id, 1)).toEqual([
      {
        title: `Contratação concluída: ${title}`,
        body: `Sem resposta do cliente até ${formatDue(due, BRASILIA)}, o último marco («Arte final») foi aprovado automaticamente e R$ 85,00 foi liberado na sua carteira.`,
      },
    ]);
    expect((await completedAt(id)).toISOString()).toBe(t.toISOString());
  });

  it('em créditos: o marco de 1 crédito diz "1 crédito" e "os créditos dele foram liberados"; dois marcos, "os créditos deles foram liberados" e "10 créditos foram liberados na sua carteira"', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    // Bônus de boas-vindas (100 créditos) no primeiro acesso à carteira, das duas partes.
    for (const actor of [client, freelancer]) {
      const wallet = await request(app).get('/api/wallet').set(auth(actor.token));
      expect(wallet.body.credits).toBe(100);
    }
    const one = await deliveredMilestones(client, freelancer, 'Aulas de violão', [1, 9]);
    const both = await deliveredMilestones(client, freelancer, 'Aulas de inglês', [4, 6]);
    const due = fromNow(-HOUR);
    await pool.query('UPDATE contract_milestones SET approval_due_at = :due WHERE id IN (:ids)', {
      due,
      ids: [one.m1, both.m1, both.m2],
    });

    const t = now();
    const result = await runTacitApproval(t);
    expect(result.milestones).toEqual(expect.arrayContaining([one.m1, both.m1, both.m2]));
    expect(result.milestones).not.toContain(one.m2);
    expect(result.failed).not.toContain(one.id);
    expect(result.failed).not.toContain(both.id);

    // Um marco de 1 crédito: o singular, e "os créditos dele" (não "o pagamento dele").
    expect(await waitNotices(client.id, 'contract_auto_approved', one.id, 1)).toEqual([
      {
        title: 'Marco aprovado automaticamente: Rascunho',
        body: `Aulas de violão: sem resposta até ${formatDue(due, BRASILIA)}, o marco foi aprovado e os créditos dele foram liberados ao freelancer (marco de 1 crédito).`,
      },
    ]);
    expect(await waitNotices(freelancer.id, 'milestone_approved', one.id, 1)).toEqual([
      {
        title: 'Marco aprovado automaticamente: Rascunho',
        body: `Aulas de violão: sem resposta do cliente até ${formatDue(due, BRASILIA)}, 1 crédito foi liberado na sua carteira.`,
      },
    ]);

    // Os dois marcos de outra contratação: "os créditos deles", e eram os que faltavam.
    expect(await waitNotices(client.id, 'contract_auto_approved', both.id, 1)).toEqual([
      {
        title: '2 marcos aprovados automaticamente: Aulas de inglês',
        body: `Sem resposta até ${formatDue(due, BRASILIA)}, os marcos «Rascunho» e «Arte final» foram aprovados e os créditos deles foram liberados ao freelancer (10 créditos ao todo). Era o que faltava: a contratação foi concluída, e você pode avaliar até ${formatDue(new Date(t.getTime() + 7 * DAY), BRASILIA)}.`,
      },
    ]);
    expect(await waitNotices(freelancer.id, 'contract_completed', both.id, 1)).toEqual([
      {
        title: 'Contratação concluída: Aulas de inglês',
        body: `Sem resposta do cliente até ${formatDue(due, BRASILIA)}, os marcos «Rascunho» e «Arte final» foram aprovados automaticamente e 10 créditos foram liberados na sua carteira. Eram os que faltavam.`,
      },
    ]);

    // Em créditos não há taxa: entraram 1 + 4 + 6; os 9 do marco em aberto seguem retidos.
    const wallet = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(wallet.body).toMatchObject({ credits: 111, creditsPending: 9 });
  });

  it('a tácita que perde para a aprovação manual não avisa (entrega única e marco)', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 400);

    // Entrega única: o job leu a linha entregue e vencida; antes de gravar, o cliente aprovou.
    const single = await deliveredContract(client, freelancer, 'Banner da feira');
    await pool.query('UPDATE contracts SET approval_due_at = :due WHERE id = :id', {
      id: single,
      due: fromNow(-HOUR),
    });
    const stale = await contractsRepository.findById(single);
    expect(stale?.status).toBe('delivered');
    const manual = await request(app)
      .post(`/api/contracts/${single}/approve`)
      .set(auth(client.token));
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    vi.spyOn(contractsRepository, 'findById').mockResolvedValueOnce(stale);
    await expect(contractsService.approveTacitly(single, now())).rejects.toMatchObject({
      statusCode: 409,
      code: 'conflict',
    });

    // Por marcos: o job leu o marco vencido; antes de aprovar, o cliente aprovou à mão.
    const { id, m1 } = await deliveredMilestones(client, freelancer, 'Cartão de visita');
    await pool.query('UPDATE contract_milestones SET approval_due_at = :due WHERE id = :id', {
      id: m1,
      due: fromNow(-HOUR),
    });
    const [dueRows] = await pool.query<DueMilestoneRow[]>(
      `SELECT m.id, m.contract_id, c.client_id, c.freelancer_id, m.approval_due_at
         FROM contract_milestones m JOIN contracts c ON c.id = m.contract_id
        WHERE m.id = :id`,
      { id: m1 },
    );
    expect(dueRows).toHaveLength(1);
    const approved = await request(app)
      .post(`/api/contracts/${id}/milestones/${m1}/approve`)
      .set(auth(client.token));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await contractsService.approveMilestonesTacitly(id, dueRows, now())).toEqual({
      approved: [],
      failed: [],
    });

    // Só os avisos da aprovação manual; nenhum da tácita, para ninguém.
    expect(await waitNotices(freelancer.id, 'contract_completed', single, 1)).toEqual([
      { title: 'Contratação concluída — pagamento liberado', body: null },
    ]);
    expect(await waitNotices(freelancer.id, 'milestone_approved', id, 1)).toEqual([
      // A aprovação manual não mudou de estilo (o controller formata com espaço inseparável).
      { title: 'Marco aprovado: Rascunho', body: 'R$\u00a085,00 liberados na sua carteira.' },
    ]);
    await settle();
    for (const contractId of [single, id]) {
      expect(await noticesOf(client.id, 'contract_auto_approved', contractId)).toEqual([]);
    }
    expect(await noticesOf(freelancer.id, 'contract_completed', single)).toHaveLength(1);
    expect(await noticesOf(freelancer.id, 'milestone_approved', id)).toHaveLength(1);
    expect(await noticesOf(freelancer.id, 'contract_completed', id)).toEqual([]);
    // O dinheiro saiu uma vez só: 170 da entrega única + 85 do marco.
    const wallet = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(wallet.body).toMatchObject({ balance: 255 });
  });

  it('a avaliação vale até completed_at + 7 dias no relógio do fluxo: no instante dito no aviso aceita, um segundo depois recusa', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 200);
    const id = await deliveredContract(client, freelancer, 'Fotos do cardápio');
    await pool.query('UPDATE contracts SET approval_due_at = :due WHERE id = :id', {
      id,
      due: fromNow(-HOUR),
    });
    const t = now();
    expect((await runTacitApproval(t)).approved).toContain(id);
    const until = new Date((await completedAt(id)).getTime() + 7 * DAY);
    const [toClient] = await waitNotices(client.id, 'contract_auto_approved', id, 1);
    expect(toClient?.body).toContain(`Você pode avaliar até ${formatDue(until, BRASILIA)}.`);

    const review = () =>
      request(app)
        .post('/api/reviews')
        .set(auth(client.token))
        .send({ contractId: id, rating: 5, comment: 'Ótimo trabalho' });
    const back = now();
    try {
      setClockForTests(new Date(until.getTime() + 1000), { frozen: true });
      const late = await review();
      expect([late.status, late.body.error]).toEqual([409, 'review_window_closed']);

      setClockForTests(until, { frozen: true });
      const onTime = await review();
      expect(onTime.status, JSON.stringify(onTime.body)).toBe(201);
    } finally {
      startDaytimeClock(back);
    }
  });
});
