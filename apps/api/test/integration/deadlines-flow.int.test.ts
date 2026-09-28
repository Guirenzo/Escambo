import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runExpireProposals } from '../../src/jobs/expire-proposals';
import { runOverdueContracts } from '../../src/jobs/overdue-contracts';
import { formatDateTime } from '../../src/utils/timezone';
import { DAY, fromNow, HOUR, isoFromNow, now, startDaytimeClock, stopClock } from './clock.helpers';
import { waitForNotification } from './notifications.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * Prazos de ponta a ponta contra o MySQL real (ADR 57):
 *  - RN-021: a validade da proposta é gravada na criação; vencida, o job expira, a reserva volta
 *    ao cliente e os dois são avisados; de noite, o job não mexe;
 *  - RN-028: o freelancer pede extensão (até 2 pedidos, um aceito), o cliente recusa/aceita o
 *    pedido que viu (seq) e o prazo muda; a Sala mostra quantos pedidos ainda cabem;
 *  - RN-029: prazo vencido → aviso às duas partes com o fim da carência gravado → na hora gravada,
 *    disputa aberta pela plataforma, com um pedido de extensão pendente segurando o job;
 *  - marco atrasado: só o marco nunca entregue é avisado.
 * O relógio do fluxo começa às 12:00 de Brasília (dia nos 5 fusos) e os jobs rodam com ele; o
 * tempo é "andado" direto no banco, com instantes relativos a esse relógio.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const BRASILIA = 'America/Sao_Paulo';
/** 03:00 de Brasília: noite nos 5 fusos, e os jobs de prazo não agem. */
const night = (): Date => new Date(now().getTime() + 15 * HOUR);

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `int_dl_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

interface ContractView {
  status: string;
  deadlineAt: string | null;
  deadlineExtendedAt: string | null;
  overdueNotifiedAt: string | null;
  proposalExpiresAt: string | null;
  extension: {
    status: string;
    deadlineAt: string;
    reason: string;
    respondBy: string | null;
    seq: number;
  } | null;
  deadline: {
    state: string;
    noticeAt: string | null;
    mediationAt: string | null;
    extensionRequestsLeft: number;
  };
  history: { previousStatus: string | null; status: string; note: string | null }[];
  milestones: { id: number; title: string; status: string; dueAt: string | null }[];
}

const contract = async (id: number, token: string): Promise<ContractView> =>
  (await request(app).get(`/api/contracts/${id}`).set(auth(token))).body as ContractView;

/** As colunas de prazo como estão no banco. */
async function deadlineCols(id: number): Promise<{
  overdue_notified_at: Date | null;
  grace_ends_at: Date | null;
}> {
  const [[row]] = (await pool.query(
    'SELECT overdue_notified_at, grace_ends_at FROM contracts WHERE id = :id',
    { id },
  )) as unknown as [[{ overdue_notified_at: Date | null; grace_ends_at: Date | null }]];
  return row;
}

const wallet = async (token: string) =>
  (await request(app).get('/api/wallet').set(auth(token))).body as {
    balance: number;
    balancePending: number;
  };

async function propose(
  client: Actor,
  freelancer: Actor,
  price: number,
  deadlineAt: string | null,
): Promise<number> {
  const res = await request(app).post('/api/contracts').set(auth(client.token)).send({
    freelancerId: freelancer.id,
    title: 'Vídeo institucional',
    description: 'Roteiro, captação e edição do vídeo da empresa',
    price,
    deadlineAt,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

beforeAll(async () => {
  startDaytimeClock();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('Prazos: expiração da proposta, extensão e disputa automática (ADR 57)', () => {
  it('RN-021: proposta sem resposta expira pelo job na hora gravada e a reserva volta ao cliente', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 150);
    const before = now();
    const id = await propose(client, freelancer, 100, null);
    const after = now();
    expect(await wallet(client.token)).toMatchObject({ balance: 50, balancePending: 100 });

    // A validade é gravada na criação: 72 h (platform_settings.proposal_expiry_hours, seed), e
    // ao meio-dia não precisa ir para as 9h.
    const shown = await contract(id, client.token);
    expect(shown.proposalExpiresAt).not.toBeNull();
    const expires = new Date(shown.proposalExpiresAt!).getTime();
    expect(expires).toBeGreaterThanOrEqual(now().getTime());
    expect(expires).toBeGreaterThanOrEqual(before.getTime() + 72 * HOUR);
    expect(expires).toBeLessThanOrEqual(after.getTime() + 72 * HOUR);

    // Ainda dentro da validade: o job não mexe.
    expect((await runExpireProposals(now())).expired).not.toContain(id);

    await pool.query('UPDATE contracts SET proposal_expires_at = :at WHERE id = :id', {
      id,
      at: fromNow(-HOUR),
    });

    // De noite em todos os fusos, nada expira.
    const atNight = await runExpireProposals(night());
    expect(atNight.zones).toEqual([]);
    expect(atNight.expired).toEqual([]);
    expect((await contract(id, client.token)).status).toBe('pending');

    const result = await runExpireProposals(now());
    expect(result.zones.length).toBeGreaterThan(0);
    expect(result.expired).toContain(id);
    expect(result.failed).toEqual([]);

    const c = await contract(id, client.token);
    expect(c.status).toBe('cancelled');
    expect(c.proposalExpiresAt).toBeNull();
    expect(c.history.at(-1)).toMatchObject({ previousStatus: 'pending', status: 'cancelled' });
    expect(c.history.at(-1)?.note).toContain('RN-021');
    expect(await wallet(client.token)).toMatchObject({ balance: 150, balancePending: 0 });
    expect(await waitForNotification(app, client.token, 'contract_expired')).toBe(true);
    expect(await waitForNotification(app, freelancer.token, 'contract_expired')).toBe(true);

    // Idempotente: não expira de novo.
    expect((await runExpireProposals(now())).expired).not.toContain(id);
  });

  it('RN-028: extensão pedida pelo freelancer, recusada e depois aceita pelo seq; a terceira é barrada', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 300);
    const id = await propose(client, freelancer, 300, isoFromNow(5 * DAY));
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);
    const start = await contract(id, client.token);
    expect(start.deadline).toMatchObject({ state: 'running', extensionRequestsLeft: 2 });

    const askFor = (token: string, deadlineAt: string) =>
      request(app)
        .post(`/api/contracts/${id}/extension`)
        .set(auth(token))
        .send({ deadlineAt, reason: 'O material do cliente chegou depois do combinado' });
    const decide = (token: string, decision: 'accept' | 'decline', body: object = {}) =>
      request(app).post(`/api/contracts/${id}/extension/${decision}`).set(auth(token)).send(body);

    // Cliente não pede; prazo menor que o atual é inválido; prazo válido cria o pedido.
    await askFor(client.token, isoFromNow(12 * DAY)).expect(403);
    const bad = await askFor(freelancer.token, isoFromNow(2 * DAY));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_deadline');
    const before = now();
    const asked = await askFor(freelancer.token, isoFromNow(12 * DAY));
    const after = now();
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body.extension).toMatchObject({ status: 'pending', seq: 1 });
    // O cliente tem 48 h (de dia, no fuso dele) para responder.
    const respondBy = new Date(asked.body.extension.respondBy as string).getTime();
    expect(respondBy).toBeGreaterThanOrEqual(before.getTime() + 48 * HOUR);
    expect(respondBy).toBeLessThanOrEqual(after.getTime() + 48 * HOUR);
    expect(asked.body.deadline).toMatchObject({ state: 'paused' });
    const pendingAgain = await askFor(freelancer.token, isoFromNow(14 * DAY));
    expect(pendingAgain.status).toBe(409);
    expect(pendingAgain.body.error).toBe('extension_pending');
    expect(await waitForNotification(app, client.token, 'deadline_extension_requested')).toBe(true);

    // Freelancer não decide; cliente recusa o pedido 1 → prazo original continua, sobra um pedido.
    await decide(freelancer.token, 'accept', { seq: 1 }).expect(403);
    const declined = await decide(client.token, 'decline', { seq: 1 });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.extension.status).toBe('declined');
    expect(declined.body.deadlineExtendedAt).toBeNull();
    expect(declined.body.deadlineAt).toBe(start.deadlineAt);
    expect(await waitForNotification(app, freelancer.token, 'deadline_extension_declined')).toBe(
      true,
    );
    expect((await contract(id, client.token)).deadline.extensionRequestsLeft).toBe(1);

    // Novo pedido (a recusa não gasta a extensão) → aceito pelo seq que o cliente viu → prazo muda.
    const newDeadline = isoFromNow(10 * DAY);
    const second = await askFor(freelancer.token, newDeadline);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.extension).toMatchObject({ status: 'pending', seq: 2 });
    expect(second.body.extension.respondBy).toEqual(expect.any(String));
    // O cliente responde ao pedido que abriu: o número velho não passa.
    const stale = await decide(client.token, 'accept', { seq: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('extension_changed');
    const accepted = await decide(client.token, 'accept', { seq: 2 });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.deadlineAt).toBe(newDeadline);
    expect(accepted.body.deadlineExtendedAt).not.toBeNull();
    expect(accepted.body.extension.status).toBe('accepted');
    expect(await waitForNotification(app, freelancer.token, 'deadline_extension_accepted')).toBe(
      true,
    );
    const c = await contract(id, client.token);
    expect(c.history.at(-1)?.note).toContain('Prazo estendido de');
    expect(c.deadline).toMatchObject({ state: 'running', extensionRequestsLeft: 0 });
    const again = await decide(client.token, 'accept', { seq: 2 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('no_pending_extension');

    const third = await askFor(freelancer.token, isoFromNow(20 * DAY));
    expect(third.status).toBe(409);
    expect(third.body.error).toBe('extension_used');
  });

  it('RN-029: prazo vencido avisa uma vez com o fim da carência gravado; nessa hora, a plataforma abre a disputa', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    await fundWallet(app, client.token, 200);
    const id = await propose(client, freelancer, 200, isoFromNow(5 * DAY));
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);

    // Dentro do prazo: nada acontece.
    expect((await runOverdueContracts(now())).notified).not.toContain(id);

    // Prazo vencido há 30 h, mas com pedido de extensão pendente: o job segura (a decisão é do
    // cliente).
    const deadline = fromNow(-30 * HOUR);
    await pool.query('UPDATE contracts SET deadline_at = :deadline WHERE id = :id', {
      id,
      deadline,
    });
    await request(app)
      .post(`/api/contracts/${id}/extension`)
      .set(auth(freelancer.token))
      .send({
        deadlineAt: isoFromNow(5 * DAY),
        reason: 'Preciso de mais alguns dias para finalizar',
      })
      .expect(200);
    const held = await runOverdueContracts(now());
    expect(held.notified).not.toContain(id);
    expect(held.disputed).not.toContain(id);
    expect((await contract(id, client.token)).deadline.state).toBe('paused');

    // Cliente recusa → fase 1: aviso às duas partes, uma vez só, com o fim da carência gravado.
    await request(app)
      .post(`/api/contracts/${id}/extension/decline`)
      .set(auth(client.token))
      .send({ seq: 1 })
      .expect(200);
    expect((await deadlineCols(id)).grace_ends_at).toBeNull(); // sem aviso, a carência não começou
    const first = await runOverdueContracts(now());
    expect(first.graceHours).toBe(24); // platform_settings.deadline_grace_hours (seed)
    expect(first.notified).toContain(id);
    expect(first.disputed).not.toContain(id);
    const cols = await deadlineCols(id);
    expect(cols.overdue_notified_at).not.toBeNull();
    expect(cols.grace_ends_at).not.toBeNull();
    // Ao meio-dia, a carência de 24 h termina num instante de dia: sem ir para as 9h.
    expect(new Date(cols.grace_ends_at!).getTime()).toBe(
      new Date(cols.overdue_notified_at!).getTime() + 24 * HOUR,
    );
    const inGrace = await contract(id, client.token);
    expect(inGrace.overdueNotifiedAt).toBe(new Date(cols.overdue_notified_at!).toISOString());
    expect(inGrace.deadline).toMatchObject({
      state: 'grace',
      noticeAt: new Date(cols.overdue_notified_at!).toISOString(),
      mediationAt: new Date(cols.grace_ends_at!).toISOString(),
    });
    expect(await waitForNotification(app, client.token, 'contract_overdue')).toBe(true);
    expect(await waitForNotification(app, freelancer.token, 'contract_overdue')).toBe(true);

    // Nem segundo aviso nem disputa antes da hora gravada.
    const again = await runOverdueContracts(now());
    expect(again.notified).not.toContain(id);
    expect(again.disputed).not.toContain(id);

    // Fase 2: a hora gravada passou sem entrega → disputa por prazo (de dia), contrato congelado.
    const noticeAt = fromNow(-25 * HOUR);
    const graceEndsAt = fromNow(-HOUR);
    await pool.query(
      'UPDATE contracts SET overdue_notified_at = :noticeAt, grace_ends_at = :graceEndsAt WHERE id = :id',
      { id, noticeAt, graceEndsAt },
    );
    expect((await runOverdueContracts(night())).disputed).not.toContain(id);
    const second = await runOverdueContracts(now());
    expect(second.disputed).toContain(id);
    const disputed = await contract(id, client.token);
    expect(disputed.status).toBe('disputed');
    expect(disputed.history.at(-1)).toMatchObject({
      previousStatus: 'accepted',
      status: 'disputed',
    });
    expect(await waitForNotification(app, freelancer.token, 'dispute_opened')).toBe(true);
    expect(await waitForNotification(app, client.token, 'dispute_opened')).toBe(true);
    const queue = await request(app).get('/api/admin/disputes').set(auth(admin.token));
    expect(queue.status).toBe(200);
    const mine = (queue.body as { contractId: number; reason: string; description: string }[]).find(
      (d) => d.contractId === id,
    );
    expect(mine).toBeDefined();
    expect(mine?.reason).toBe('deadline');
    expect(mine?.description).toMatch(/^Aberta automaticamente pela plataforma \(RN-029\)/);
    // A mediação lê as horas gravadas, em Brasília.
    expect(mine?.description).toContain(`o aviso saiu em ${formatDateTime(noticeAt, BRASILIA)}`);
    expect(mine?.description).toContain(`até ${formatDateTime(graceEndsAt, BRASILIA)}`);

    // Não abre uma segunda disputa.
    expect((await runOverdueContracts(now())).disputed).not.toContain(id);
    const [[count]] = (await pool.query(
      'SELECT COUNT(*) AS n FROM disputes WHERE contract_id = :id',
      { id },
    )) as unknown as [[{ n: number }]];
    expect(Number(count.n)).toBe(1);
  });

  it('RN-069 + prazos: só o marco nunca entregue é avisado, uma vez; o prazo do marco não passa do da contratação', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 300);
    const body = (dues: [string, string], deadlineAt: string) => ({
      freelancerId: freelancer.id,
      title: 'Site em duas etapas',
      description: 'Layout aprovado e depois a publicação do site',
      price: 300,
      deadlineAt,
      milestones: [
        { title: 'Layout', amount: 150, dueAt: dues[0] },
        { title: 'Publicação', amount: 150, dueAt: dues[1] },
      ],
    });

    // Marco depois do prazo da contratação: 422 (validação) com a mensagem certa.
    const bad = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send(body([isoFromNow(12 * DAY), isoFromNow(14 * DAY)], isoFromNow(10 * DAY)));
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain('não pode passar do prazo da contratação');

    const due1 = isoFromNow(3 * DAY);
    const created = await request(app)
      .post('/api/contracts')
      .set(auth(client.token))
      .send(body([due1, isoFromNow(9 * DAY)], isoFromNow(10 * DAY)));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as number;
    await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token)).expect(200);
    const [m1, m2] = (await contract(id, client.token)).milestones;
    expect(m1).toMatchObject({ title: 'Layout', status: 'funded', dueAt: due1 });

    // O marco 2 é entregue e volta para revisão: segue financiado, mas já foi entregue.
    await request(app)
      .post(`/api/contracts/${id}/milestones/${m2!.id}/deliver`)
      .set(auth(freelancer.token))
      .send({ message: 'Publicação no ar' })
      .expect(200);
    await request(app)
      .post(`/api/contracts/${id}/milestones/${m2!.id}/request-revision`)
      .set(auth(client.token))
      .send({ note: 'Falta o domínio próprio' })
      .expect(200);
    expect((await contract(id, client.token)).milestones[1]).toMatchObject({ status: 'funded' });

    // Dentro do prazo: nada. Prazos dos dois marcos vencidos: aviso aos dois só do nunca entregue.
    expect((await runOverdueContracts(now())).milestones).not.toContain(m1!.id);
    await pool.query('UPDATE contract_milestones SET due_at = :due WHERE id IN (:m1, :m2)', {
      m1: m1!.id,
      m2: m2!.id,
      due: fromNow(-HOUR),
    });
    const first = await runOverdueContracts(now());
    expect(first.milestones).toContain(m1!.id);
    expect(first.milestones).not.toContain(m2!.id);
    expect(first.disputed).not.toContain(id); // o prazo da contratação (10 dias) segue valendo
    expect(await waitForNotification(app, freelancer.token, 'milestone_overdue')).toBe(true);
    expect(await waitForNotification(app, client.token, 'milestone_overdue')).toBe(true);
    const again = await runOverdueContracts(now());
    expect(again.milestones).not.toContain(m1!.id);
    expect(again.milestones).not.toContain(m2!.id);
    // A entrega do marco 2 pôs a contratação em andamento; o aviso do marco não abre disputa.
    expect((await contract(id, client.token)).status).toBe('in_progress');
  });
});
