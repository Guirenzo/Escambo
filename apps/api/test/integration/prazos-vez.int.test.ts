import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runOverdueContracts } from '../../src/jobs/overdue-contracts';
import { runTacitApproval } from '../../src/jobs/tacit-approval';
import { contractsRepository } from '../../src/modules/contracts/contracts.repository';
import { contractsService } from '../../src/modules/contracts/contracts.service';
import { owesDelivery } from '../../src/modules/contracts/deadline-grace';
import { rn029Eligible } from '../../src/modules/contracts/deadline-sql';
import { setClockForTests } from '../../src/utils/clock';
import { dayZones } from '../../src/utils/human-hours';
import { formatDateTime, formatDeadline, formatDue, localParts } from '../../src/utils/timezone';
import { waitForNotification } from './notifications.helpers';
import { fundWallet } from './wallet.helpers';
import { DAY, fromNow, HOUR, isoFromNow, now, startDaytimeClock, stopClock } from './clock.helpers';

/**
 * A vez de quem entrega, a hora humana e a extensão de prazo (ADR 57) contra o MySQL real:
 *  - R-VEZ: depois da primeira entrega o prazo não cobra mais (revisão pedida, marcos entregues);
 *    o marco entregue conta no aviso ao cliente e na descrição da disputa; a disputa automática
 *    grava o status real de antes; o predicado SQL (rn029Eligible) e o gêmeo em TypeScript
 *    (owesDelivery) dão o mesmo resultado;
 *  - R-HORA: o aviso e a disputa só saem de dia no fuso de quem entrega (Rio Branco, UTC−5), e a
 *    carência gravada no aviso é a cumprida, mesmo se o painel mudar as horas depois;
 *  - R-EXTENSÃO: até 2 pedidos, o silêncio do cliente expira o pedido e devolve a carência de onde
 *    parou (nunca de noite), pedido trocado no meio (seq), data pedida já passada, pedido encerrado
 *    pela entrega;
 *  - concorrência: a gravação repete a leitura (linha velha do job não abre disputa) e duas
 *    instâncias nunca gravam a mesma coisa duas vezes.
 * O relógio do fluxo começa às 12:00 de Brasília (dia nos 5 fusos); o tempo anda pelas colunas.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const SP = 'America/Sao_Paulo' as const;
const RB = 'America/Rio_Branco' as const;
const REASON = 'O material do cliente chegou depois do combinado';

interface Actor {
  id: number;
  token: string;
}

interface ContractView {
  status: string;
  deadlineAt: string | null;
  deadlineExtendedAt: string | null;
  overdueNotifiedAt: string | null;
  extension: {
    status: string;
    deadlineAt: string;
    resolvedAt: string | null;
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
  milestones: { id: number; title: string; status: string }[];
}

/** Dois marcos iguais, somando os R$ 300 da contratação. */
const MILESTONES = [
  { title: 'Layout', amount: 150 },
  { title: 'Publicação', amount: 150 },
];

let startedAt: Date;
let seq = 0;

async function registerAndLogin(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `vez_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

/** Cliente com saldo e freelancer, os dois no fuso padrão (Brasília). */
async function pair(funds: number): Promise<{ client: Actor; freelancer: Actor }> {
  const client = await registerAndLogin('client');
  const freelancer = await registerAndLogin('freelancer');
  await fundWallet(app, client.token, funds);
  return { client, freelancer };
}

async function view(id: number, token: string): Promise<ContractView> {
  const res = await request(app).get(`/api/contracts/${id}`).set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ContractView;
}

/** Proposta com prazo daqui a 5 dias (padrão), entrega única ou por marcos. */
async function propose(
  client: Actor,
  freelancer: Actor,
  opts: {
    price?: number;
    deadlineAt?: string | null;
    milestones?: { title: string; amount: number }[];
  } = {},
): Promise<number> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: 'Site institucional',
      description: 'Layout, conteúdo e publicação do site da empresa',
      price: opts.price ?? 300,
      deadlineAt: opts.deadlineAt === undefined ? isoFromNow(5 * DAY) : opts.deadlineAt,
      ...(opts.milestones ? { milestones: opts.milestones } : {}),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

async function accept(id: number, freelancer: Actor): Promise<void> {
  const res = await request(app).post(`/api/contracts/${id}/accept`).set(auth(freelancer.token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function accepted(
  client: Actor,
  freelancer: Actor,
  opts: Parameters<typeof propose>[2] = {},
): Promise<number> {
  const id = await propose(client, freelancer, opts);
  await accept(id, freelancer);
  return id;
}

async function deliver(id: number, freelancer: Actor): Promise<void> {
  const res = await request(app)
    .post(`/api/contracts/${id}/deliver`)
    .set(auth(freelancer.token))
    .send({ message: 'Entregue: arquivos no chat.' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.status).toBe('delivered');
}

async function requestRevision(id: number, client: Actor): Promise<void> {
  const res = await request(app)
    .post(`/api/contracts/${id}/request-revision`)
    .set(auth(client.token))
    .send({ note: 'Faltou a página de contato' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.status).toBe('revision_requested');
}

async function deliverMilestone(id: number, milestoneId: number, freelancer: Actor): Promise<void> {
  const res = await request(app)
    .post(`/api/contracts/${id}/milestones/${milestoneId}/deliver`)
    .set(auth(freelancer.token))
    .send({ message: 'Marco pronto, arquivos no chat.' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function approveMilestone(id: number, milestoneId: number, client: Actor): Promise<void> {
  const res = await request(app)
    .post(`/api/contracts/${id}/milestones/${milestoneId}/approve`)
    .set(auth(client.token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function milestoneRevision(id: number, milestoneId: number, client: Actor): Promise<void> {
  const res = await request(app)
    .post(`/api/contracts/${id}/milestones/${milestoneId}/request-revision`)
    .set(auth(client.token))
    .send({ note: 'Ajustar as cores' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const askExtension = (id: number, freelancer: Actor, deadlineAt: string) =>
  request(app)
    .post(`/api/contracts/${id}/extension`)
    .set(auth(freelancer.token))
    .send({ deadlineAt, reason: REASON });

const decide = (
  id: number,
  client: Actor,
  decision: 'accept' | 'decline',
  body: Record<string, unknown> = {},
) =>
  request(app)
    .post(`/api/contracts/${id}/extension/${decision}`)
    .set(auth(client.token))
    .send(body);

/** Anda o tempo: grava colunas da contratação com instantes do relógio do fluxo. */
async function setCols(id: number, cols: Record<string, Date | string | null>): Promise<void> {
  const sets = Object.keys(cols)
    .map((k) => `${k} = :${k}`)
    .join(', ');
  await pool.query(`UPDATE contracts SET ${sets} WHERE id = :id`, { ...cols, id });
}

/** A linha como o repositório lê (com as colunas calculadas do prazo). */
async function dbRow(id: number) {
  const row = await contractsRepository.findById(id);
  expect(row, `contratação ${id}`).toBeDefined();
  return row!;
}

async function countOf(userId: number, type: string): Promise<number> {
  const [rows] = (await pool.query(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = :userId AND type = :type',
    { userId, type },
  )) as unknown as [{ n: number | string }[]];
  return Number(rows[0]!.n);
}

async function bodiesOf(token: string, type: string): Promise<(string | null)[]> {
  const res = await request(app).get('/api/notifications?limit=100').set(auth(token));
  return ((res.body?.items ?? []) as { type: string; body: string | null }[])
    .filter((n) => n.type === type)
    .map((n) => n.body);
}

async function disputesOf(contractId: number): Promise<{ reason: string; description: string }[]> {
  const [rows] = (await pool.query(
    'SELECT reason, description FROM disputes WHERE contract_id = :contractId ORDER BY id ASC',
    { contractId },
  )) as unknown as [{ reason: string; description: string }[]];
  return rows;
}

/** Minuto do dia do instante no fuso (0 a 1439). */
const minuteIn = (zone: typeof SP | typeof RB, at: Date): number => {
  const p = localParts(zone, at);
  return p.hour * 60 + p.minute;
};

/** O instante em que Rio Branco (UTC−5, sem horário de verão) marca h:m, `days` depois do dia do relógio. */
const rioBranco = (days: number, h: number, m: number): Date =>
  new Date(
    Date.UTC(
      startedAt.getUTCFullYear(),
      startedAt.getUTCMonth(),
      startedAt.getUTCDate() + days,
      h + 5,
      m,
    ),
  );

beforeAll(async () => {
  startedAt = startDaytimeClock();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('R-VEZ: depois da primeira entrega o prazo não cobra mais', () => {
  it('A1: aviso dado, entrega atrasada, carência vencida e revisão pedida: o job não abre disputa nem avisa de novo', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, { price: 200 });
    await setCols(id, { deadline_at: fromNow(-2 * DAY) });

    const first = await runOverdueContracts(now());
    expect(first.notified).toContain(id);
    expect(first.disputed).not.toContain(id);
    await expect.poll(() => countOf(client.id, 'contract_overdue')).toBe(1);
    await expect.poll(() => countOf(freelancer.id, 'contract_overdue')).toBe(1);

    // Entrega atrasada, dentro da carência: a vez passa ao cliente.
    await deliver(id, freelancer);
    // A carência gravada no aviso passa, e só então o cliente pede revisão.
    await setCols(id, { grace_ends_at: fromNow(-HOUR) });
    await requestRevision(id, client);
    expect(await waitForNotification(app, freelancer.token, 'contract_revision')).toBe(true);

    const second = await runOverdueContracts(now());
    expect(second.zones.length).toBeGreaterThan(0);
    expect(second.notified).not.toContain(id);
    expect(second.disputed).not.toContain(id);
    const c = await view(id, client.token);
    expect(c.status).toBe('revision_requested');
    expect(c.deadline.state).toBe('met');
    expect(await disputesOf(id)).toEqual([]);
    expect(await countOf(client.id, 'contract_overdue')).toBe(1);
    expect(await countOf(freelancer.id, 'contract_overdue')).toBe(1);
  });

  it('A1b: entregue antes do prazo, prazo vencido e revisão pedida: a fase 1 não avisa', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, { price: 200 });
    await deliver(id, freelancer);
    await setCols(id, { deadline_at: fromNow(-2 * DAY) });
    expect((await runOverdueContracts(now())).notified).not.toContain(id);
    await requestRevision(id, client);

    const job = await runOverdueContracts(now());
    expect(job.zones.length).toBeGreaterThan(0);
    expect(job.notified).not.toContain(id);
    expect(job.disputed).not.toContain(id);
    const r = await dbRow(id);
    expect(r.status).toBe('revision_requested');
    expect(r.overdue_notified_at).toBeNull();
    expect(r.grace_ends_at).toBeNull();
    expect((await view(id, client.token)).deadline.state).toBe('met');
    expect(await countOf(client.id, 'contract_overdue')).toBe(0);
    expect(await countOf(freelancer.id, 'contract_overdue')).toBe(0);
  });

  it('A2: por marcos, os 2 entregues e o prazo vencido: nem aviso nem disputa; a aprovação tácita conclui', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, { milestones: MILESTONES });
    const [m1, m2] = (await view(id, client.token)).milestones;
    await deliverMilestone(id, m1!.id, freelancer);
    await deliverMilestone(id, m2!.id, freelancer);
    await setCols(id, { deadline_at: fromNow(-2 * DAY) });

    const job = await runOverdueContracts(now());
    expect(job.notified).not.toContain(id);
    expect(job.disputed).not.toContain(id);
    expect(job.milestones).not.toContain(m1!.id);
    expect(job.milestones).not.toContain(m2!.id);
    expect((await dbRow(id)).overdue_notified_at).toBeNull();

    // Nem com um aviso antigo e a carência vencida (entregas feitas depois do aviso).
    await setCols(id, { overdue_notified_at: fromNow(-30 * HOUR), grace_ends_at: fromNow(-HOUR) });
    expect((await runOverdueContracts(now())).disputed).not.toContain(id);
    expect((await view(id, client.token)).status).toBe('in_progress');
    expect(await disputesOf(id)).toEqual([]);
    expect(await countOf(client.id, 'contract_overdue')).toBe(0);

    // A aprovação tácita de cada marco venceu: o job aprova os dois e conclui a contratação.
    await pool.query(
      'UPDATE contract_milestones SET approval_due_at = :due WHERE contract_id = :id',
      { id, due: fromNow(-HOUR) },
    );
    const tacit = await runTacitApproval(now());
    expect(tacit.milestones).toEqual(expect.arrayContaining([m1!.id, m2!.id]));
    expect(tacit.failed).not.toContain(id);
    const done = await view(id, client.token);
    expect(done.status).toBe('completed');
    expect(done.milestones.map((m) => m.status)).toEqual(['released', 'released']);
    const wallet = await request(app).get('/api/wallet').set(auth(freelancer.token));
    expect(wallet.body).toMatchObject({ balance: 255, balancePending: 0 });
  });

  it('A2 parcial: 1 de 2 marcos entregue com o prazo vencido: o aviso conta o entregue e a disputa lista os dois lados', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, { milestones: MILESTONES });
    const [m1] = (await view(id, client.token)).milestones;
    await deliverMilestone(id, m1!.id, freelancer);
    await setCols(id, { deadline_at: fromNow(-2 * DAY) });

    const job = await runOverdueContracts(now());
    expect(job.notified).toContain(id);
    expect(job.disputed).not.toContain(id);
    const r = await dbRow(id);
    const deadline = new Date(r.deadline_at!);
    const grace = new Date(r.grace_ends_at!);
    const clientBody = `Sem as entregas que faltam nem extensão aceita até ${formatDue(grace, SP)}, a disputa abre sozinha. O prazo era ${formatDeadline(deadline, SP, SP)}: 1 de 2 marcos entregues; falta o marco «Publicação».`;
    await expect.poll(() => bodiesOf(client.token, 'contract_overdue')).toEqual([clientBody]);
    const [body] = await bodiesOf(client.token, 'contract_overdue');
    expect(body).toContain('1 de 2 marcos entregues');
    expect(body).not.toContain('não houve entrega');
    await expect
      .poll(() => bodiesOf(freelancer.token, 'contract_overdue'))
      .toEqual([
        `Até ${formatDue(grace, SP)}: entregue o marco «Publicação» ou peça a extensão, senão a disputa abre sozinha. O prazo era ${formatDeadline(deadline, SP, SP)}.`,
      ]);

    // Carência vencida sem o marco que falta: a disputa abre, com os marcos dos dois lados.
    const graceEnd = fromNow(-HOUR);
    await setCols(id, { grace_ends_at: graceEnd });
    expect((await runOverdueContracts(now())).disputed).toContain(id);
    expect((await view(id, client.token)).status).toBe('disputed');
    const disputes = await disputesOf(id);
    expect(disputes).toHaveLength(1);
    expect(disputes[0]!.reason).toBe('deadline');
    expect(disputes[0]!.description).toBe(
      `Aberta automaticamente pela plataforma (RN-029): o prazo de entrega, ${formatDeadline(deadline, SP)}, venceu com marcos nunca entregues, o aviso saiu em ${formatDateTime(new Date(r.overdue_notified_at!), SP)} e, até ${formatDateTime(graceEnd, SP)}, eles não foram entregues nem houve extensão aceita. O aviso e o limite estão em horário de Brasília. Marcos entregues: «Layout»; sem entrega: «Publicação».`,
    );
    expect(await waitForNotification(app, client.token, 'dispute_opened')).toBe(true);
    expect(await waitForNotification(app, freelancer.token, 'dispute_opened')).toBe(true);
  });

  it('I12: a disputa automática grava no histórico o status real de antes (accepted)', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, { price: 200 });
    await setCols(id, { deadline_at: fromNow(-2 * DAY) });
    expect((await runOverdueContracts(now())).notified).toContain(id);
    await setCols(id, { grace_ends_at: fromNow(-HOUR) });
    expect((await runOverdueContracts(now())).disputed).toContain(id);

    const c = await view(id, client.token);
    expect(c.status).toBe('disputed');
    expect(c.history.at(-1)).toMatchObject({
      previousStatus: 'accepted',
      status: 'disputed',
      note: 'Disputa aberta',
    });
    const [rows] = (await pool.query(
      `SELECT old_status FROM contract_status_history
        WHERE contract_id = :id AND new_status = 'disputed'`,
      { id },
    )) as unknown as [{ old_status: string | null }[]];
    expect(rows).toEqual([{ old_status: 'accepted' }]);
  });

  it('concordância: rn029Eligible (SQL) e owesDelivery (TS) dão o mesmo resultado em cada combinação', async () => {
    const { client, freelancer } = await pair(2000);
    const two = [
      { title: 'Etapa 1', amount: 50 },
      { title: 'Etapa 2', amount: 50 },
    ];
    const cases: { name: string; id: number; expected: boolean }[] = [];
    const add = (name: string, id: number, expected: boolean) => cases.push({ name, id, expected });
    const pairOf = async (id: number) => {
      const [a, b] = (await view(id, client.token)).milestones;
      return [a!.id, b!.id] as const;
    };

    // Entrega única.
    add('proposta com prazo', await propose(client, freelancer, { price: 100 }), false);
    add('aceita com prazo, sem entrega', await accepted(client, freelancer, { price: 100 }), true);
    add(
      'aceita sem prazo',
      await accepted(client, freelancer, { price: 100, deadlineAt: null }),
      false,
    );
    const delivered = await accepted(client, freelancer, { price: 100 });
    await deliver(delivered, freelancer);
    add('entregue', delivered, false);
    const revision = await accepted(client, freelancer, { price: 100 });
    await deliver(revision, freelancer);
    await requestRevision(revision, client);
    add('revisão pedida', revision, false);
    const back = await accepted(client, freelancer, { price: 100 });
    await deliver(back, freelancer);
    await setCols(back, { status: 'in_progress' });
    add('em andamento com entrega registrada', back, false);
    const cancelled = await accepted(client, freelancer, { price: 100 });
    const cancel = await request(app)
      .post(`/api/contracts/${cancelled}/cancel`)
      .set(auth(client.token));
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    add('cancelada', cancelled, false);
    const disputed = await accepted(client, freelancer, { price: 100 });
    await setCols(disputed, { status: 'disputed' });
    add('em disputa', disputed, false);

    // Por marcos.
    add(
      'marcos: proposta',
      await propose(client, freelancer, { price: 100, milestones: two }),
      false,
    );
    add(
      'marcos: aceita, nenhum entregue',
      await accepted(client, freelancer, { price: 100, milestones: two }),
      true,
    );
    add(
      'marcos: sem prazo, nenhum entregue',
      await accepted(client, freelancer, { price: 100, milestones: two, deadlineAt: null }),
      false,
    );
    const oneWaiting = await accepted(client, freelancer, { price: 100, milestones: two });
    const [w1] = await pairOf(oneWaiting);
    await deliverMilestone(oneWaiting, w1, freelancer);
    add('marcos: 1 entregue esperando, 1 nunca entregue', oneWaiting, true);
    const oneReleased = await accepted(client, freelancer, { price: 100, milestones: two });
    const [r1] = await pairOf(oneReleased);
    await deliverMilestone(oneReleased, r1, freelancer);
    await approveMilestone(oneReleased, r1, client);
    add('marcos: 1 aprovado, 1 nunca entregue', oneReleased, true);
    const bothDelivered = await accepted(client, freelancer, { price: 100, milestones: two });
    const [b1, b2] = await pairOf(bothDelivered);
    await deliverMilestone(bothDelivered, b1, freelancer);
    await deliverMilestone(bothDelivered, b2, freelancer);
    add('marcos: os 2 entregues', bothDelivered, false);
    const inRevision = await accepted(client, freelancer, { price: 100, milestones: two });
    const [v1, v2] = await pairOf(inRevision);
    await deliverMilestone(inRevision, v1, freelancer);
    await milestoneRevision(inRevision, v1, client);
    await deliverMilestone(inRevision, v2, freelancer);
    add('marcos: 1 em revisão, 1 entregue', inRevision, false);
    const releasedAndRevision = await accepted(client, freelancer, { price: 100, milestones: two });
    const [x1, x2] = await pairOf(releasedAndRevision);
    await deliverMilestone(releasedAndRevision, x1, freelancer);
    await approveMilestone(releasedAndRevision, x1, client);
    await deliverMilestone(releasedAndRevision, x2, freelancer);
    await milestoneRevision(releasedAndRevision, x2, client);
    add('marcos: 1 aprovado, 1 em revisão', releasedAndRevision, false);

    const results: { name: string; sql: boolean; ts: boolean }[] = [];
    for (const c of cases) {
      const [rows] = (await pool.query(
        `SELECT ${rn029Eligible('c')} AS r FROM contracts c WHERE c.id = :id`,
        { id: c.id },
      )) as unknown as [{ r: number | string }[]];
      results.push({
        name: c.name,
        sql: Number(rows[0]!.r) === 1,
        ts: owesDelivery(await dbRow(c.id)),
      });
    }
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(results).toEqual(cases.map((c) => ({ name: c.name, sql: c.expected, ts: c.expected })));
  });
});

describe('R-EXTENSÃO: pedidos, silêncio do cliente e decisões fora de hora', () => {
  it('A3 limite: pede, recusa, pede, recusa; o 3º pedido é barrado e a disputa sai na hora gravada', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, { price: 200 });
    await setCols(id, { deadline_at: fromNow(-2 * DAY) });
    expect((await runOverdueContracts(now())).notified).toContain(id);

    const first = await askExtension(id, freelancer, isoFromNow(5 * DAY));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.extension).toMatchObject({ status: 'pending', seq: 1 });
    expect((await decide(id, client, 'decline')).status).toBe(200);
    const second = await askExtension(id, freelancer, isoFromNow(6 * DAY));
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.extension).toMatchObject({ status: 'pending', seq: 2 });
    const declined = await decide(id, client, 'decline');
    expect(declined.status).toBe(200);
    expect(declined.body.deadline.extensionRequestsLeft).toBe(0);

    const third = await askExtension(id, freelancer, isoFromNow(7 * DAY));
    expect(third.status).toBe(409);
    expect(third.body.error).toBe('extension_limit');

    // A disputa sai exatamente na hora gravada depois da segunda recusa, nem um segundo antes.
    const graceEnds = new Date((await dbRow(id)).grace_ends_at!);
    expect(graceEnds.getTime()).toBeGreaterThan(now().getTime());
    expect((await view(id, client.token)).deadline.mediationAt).toBe(graceEnds.toISOString());
    const early = await runOverdueContracts(new Date(graceEnds.getTime() - 1000));
    expect(early.zones.length).toBeGreaterThan(0);
    expect(early.disputed).not.toContain(id);
    expect((await runOverdueContracts(graceEnds)).disputed).toContain(id);
    expect((await dbRow(id)).status).toBe('disputed');
  });

  it('A3 silêncio: pedido sem resposta expira pelo job, os dois são avisados e a carência volta de dia', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, { price: 200 });
    await setCols(id, { deadline_at: fromNow(-3 * DAY) });
    expect((await runOverdueContracts(now())).notified).toContain(id);
    const asked = await askExtension(id, freelancer, isoFromNow(5 * DAY));
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);

    // O aviso saiu há 60 h (carência até 36 h atrás); o pedido veio 10 h depois do aviso, com 14 h
    // ainda de carência, e o cliente não respondeu até a hora dita (2 h atrás).
    await setCols(id, {
      overdue_notified_at: fromNow(-60 * HOUR),
      grace_ends_at: fromNow(-36 * HOUR),
      extension_requested_at: fromNow(-50 * HOUR),
      extension_respond_by: fromNow(-2 * HOUR),
    });
    const decidedAt = now();
    const job = await runOverdueContracts(decidedAt);
    expect(job.expired).toContain(id);
    expect(job.disputed).not.toContain(id);

    const c = await view(id, client.token);
    expect(c.extension?.status).toBe('expired');
    expect(c.extension?.resolvedAt).toBe(decidedAt.toISOString());
    expect(await waitForNotification(app, client.token, 'deadline_extension_expired')).toBe(true);
    expect(await waitForNotification(app, freelancer.token, 'deadline_extension_expired')).toBe(
      true,
    );

    // As 14 h que faltavam voltam a partir da decisão (cairiam às 2h da madrugada): as 9h seguintes,
    // no fuso dos dois (Brasília), pelo menos 12 h depois da decisão.
    const grace = new Date((await dbRow(id)).grace_ends_at!);
    expect(grace.getTime()).toBeGreaterThanOrEqual(decidedAt.getTime() + 12 * HOUR);
    expect(minuteIn(SP, grace)).toBeGreaterThanOrEqual(9 * 60);
    expect(minuteIn(SP, grace)).toBeLessThan(20 * 60 + 30);
    expect(localParts(SP, grace)).toMatchObject({ hour: 9, minute: 0, second: 0 });
    expect(c.deadline).toMatchObject({ state: 'grace', mediationAt: grace.toISOString() });
  });

  it('F8: aceitar proposta com o prazo vencido dá deadline_passed; aceitar extensão com a data pedida já passada dá extension_stale', async () => {
    const { client, freelancer } = await pair(300);
    const proposal = await propose(client, freelancer, { price: 100 });
    await setCols(proposal, { deadline_at: fromNow(-HOUR) });
    const late = await request(app)
      .post(`/api/contracts/${proposal}/accept`)
      .set(auth(freelancer.token));
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('deadline_passed');
    expect((await dbRow(proposal)).status).toBe('pending');

    const id = await accepted(client, freelancer, { price: 100 });
    expect((await askExtension(id, freelancer, isoFromNow(8 * DAY))).status).toBe(200);
    await setCols(id, { deadline_at: fromNow(-3 * HOUR), extension_deadline_at: fromNow(-HOUR) });
    const stale = await decide(id, client, 'accept');
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('extension_stale');
    const c = await view(id, client.token);
    expect(c.extension?.status).toBe('pending');
    expect(c.deadlineExtendedAt).toBeNull();
  });

  it('F9: a entrega encerra o pedido pendente (closed); decidir depois dá no_pending_extension', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, { price: 100 });
    const asked = await askExtension(id, freelancer, isoFromNow(8 * DAY));
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    await deliver(id, freelancer);

    const c = await view(id, client.token);
    expect(c.extension?.status).toBe('closed');
    expect(c.extension?.resolvedAt).toEqual(expect.any(String));
    expect(c.deadline.state).toBe('met');
    for (const decision of ['accept', 'decline'] as const) {
      const res = await decide(id, client, decision);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('no_pending_extension');
    }
    expect((await dbRow(id)).deadline_extended_at).toBeNull();
  });

  it('seq: aceite com o número de um pedido velho dá extension_changed; sem seq, aceita o pedido atual', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, { price: 100 });
    // O prazo atual é daqui a 5 dias: os pedidos vão além dele.
    expect((await askExtension(id, freelancer, isoFromNow(6 * DAY))).body.extension.seq).toBe(1);
    expect((await decide(id, client, 'decline', { seq: 1 })).status).toBe(200);
    const proposed = isoFromNow(7 * DAY);
    const second = await askExtension(id, freelancer, proposed);
    expect(second.body.extension).toMatchObject({ status: 'pending', seq: 2 });

    const old = await decide(id, client, 'accept', { seq: 1 });
    expect(old.status).toBe(409);
    expect(old.body.error).toBe('extension_changed');
    expect((await view(id, client.token)).extension?.status).toBe('pending');

    const ok = await decide(id, client, 'accept');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.extension.status).toBe('accepted');
    expect(ok.body.deadlineAt).toBe(proposed);
    expect(ok.body.deadlineExtendedAt).not.toBeNull();
  });
});

describe('R-HORA: aviso e disputa de dia no fuso de quem entrega, na hora gravada', () => {
  it('F7: o painel muda a carência para 1 h depois do aviso; a disputa espera a hora gravada', async () => {
    const { client, freelancer } = await pair(300);
    const id = await accepted(client, freelancer, { price: 200 });
    await setCols(id, { deadline_at: fromNow(-2 * DAY) });
    const first = await runOverdueContracts(now());
    expect(first.graceHours).toBe(24);
    expect(first.notified).toContain(id);
    const r = await dbRow(id);
    const graceEnds = new Date(r.grace_ends_at!);
    expect(graceEnds.getTime()).toBe(new Date(r.overdue_notified_at!).getTime() + 24 * HOUR);

    const [[setting]] = (await pool.query(
      "SELECT value FROM platform_settings WHERE key_name = 'deadline_grace_hours'",
    )) as unknown as [[{ value: string }]];
    await pool.query(
      "UPDATE platform_settings SET value = '1' WHERE key_name = 'deadline_grace_hours'",
    );
    try {
      const later = await runOverdueContracts(fromNow(2 * HOUR));
      expect(later.graceHours).toBe(1);
      expect(later.disputed).not.toContain(id);
      expect((await view(id, client.token)).deadline).toMatchObject({
        state: 'grace',
        mediationAt: graceEnds.toISOString(),
      });
      expect(
        (await runOverdueContracts(new Date(graceEnds.getTime() - 1000))).disputed,
      ).not.toContain(id);
      expect((await dbRow(id)).status).toBe('accepted');
      expect((await runOverdueContracts(graceEnds)).disputed).toContain(id);
    } finally {
      await pool.query(
        "UPDATE platform_settings SET value = :value WHERE key_name = 'deadline_grace_hours'",
        { value: setting.value },
      );
    }
  });

  it('Rio Branco: o aviso sai a partir das 9h de quem entrega e a disputa não abre de noite nem antes das 9h dele', async () => {
    const { client, freelancer } = await pair(300);
    await pool.query("UPDATE users SET timezone = 'America/Rio_Branco' WHERE id = :id", {
      id: freelancer.id,
    });
    const id = await accepted(client, freelancer, { price: 200 });
    await setCols(id, { deadline_at: fromNow(-3 * DAY) });

    const back = now();
    /** O relógio do fluxo vai ao instante exato, e o job roda nele. */
    const runAt = (at: Date) => {
      setClockForTests(at);
      return runOverdueContracts(at);
    };
    try {
      // 08:30 em Rio Branco (10:30 em Brasília): dia em outros fusos, não no de quem entrega.
      const early = rioBranco(0, 8, 30);
      expect(localParts(RB, early)).toMatchObject({ hour: 8, minute: 30 });
      const r0830 = await runAt(early);
      expect(r0830.zones).toContain(SP);
      expect(r0830.zones).not.toContain(RB);
      expect(r0830.notified).not.toContain(id);
      expect((await dbRow(id)).overdue_notified_at).toBeNull();

      // 09:05 em Rio Branco: avisa, e a carência de 24 h termina às 09:05 do dia seguinte dele.
      const notice = rioBranco(0, 9, 5);
      const r0905 = await runAt(notice);
      expect(r0905.zones).toContain(RB);
      expect(r0905.notified).toContain(id);
      const r = await dbRow(id);
      expect(new Date(r.overdue_notified_at!).toISOString()).toBe(notice.toISOString());
      const graceEnds = new Date(r.grace_ends_at!);
      expect(graceEnds.toISOString()).toBe(rioBranco(1, 9, 5).toISOString());
      expect(localParts(RB, graceEnds)).toMatchObject({ hour: 9, minute: 5 });

      // Carência terminando às 20:15 de Rio Branco; às 21:10 dele é noite em todos os fusos.
      await setCols(id, { grace_ends_at: rioBranco(0, 20, 15) });
      const night = await runAt(rioBranco(0, 21, 10));
      expect(night.zones).toEqual([]);
      expect(night.disputed).not.toContain(id);
      // 07:30 em Rio Branco: já é dia em Brasília, ainda não para quem entrega.
      const dawn = await runAt(rioBranco(1, 7, 30));
      expect(dawn.zones).toContain(SP);
      expect(dawn.zones).not.toContain(RB);
      expect(dawn.disputed).not.toContain(id);
      expect((await dbRow(id)).status).toBe('accepted');
      // 09:02 do dia seguinte em Rio Branco: abre.
      const morning = await runAt(rioBranco(1, 9, 2));
      expect(morning.disputed).toContain(id);
      expect((await dbRow(id)).status).toBe('disputed');
    } finally {
      startDaytimeClock(back);
    }
  });
});

describe('Concorrência: a gravação repete a leitura', () => {
  it('F6: linha lida pelo job antes de uma entrega, ou de um pedido de extensão, não abre disputa', async () => {
    const { client, freelancer } = await pair(300);

    // Entrega entre a leitura do job e a gravação da disputa.
    const a = await accepted(client, freelancer, { price: 100 });
    await setCols(a, { deadline_at: fromNow(-2 * DAY) });
    expect((await runOverdueContracts(now())).notified).toContain(a);
    await setCols(a, { grace_ends_at: fromNow(-HOUR) });
    const oldA = (await contractsRepository.findGraceEnded(now(), dayZones(now()))).find(
      (row) => row.id === a,
    );
    expect(oldA).toBeDefined();
    await deliver(a, freelancer);
    expect(await contractsService.openOverdueDispute(oldA!, now())).toBeNull();
    expect((await view(a, client.token)).status).toBe('delivered');
    expect(await disputesOf(a)).toEqual([]);

    // Pedido de extensão entre a leitura e a gravação: o pedido saiu (no relógio de quem pediu)
    // antes do fim da carência; o job de outra instância já roda depois dele.
    const b = await accepted(client, freelancer, { price: 100 });
    await setCols(b, { deadline_at: fromNow(-2 * DAY) });
    expect((await runOverdueContracts(now())).notified).toContain(b);
    await setCols(b, { grace_ends_at: fromNow(HOUR) });
    const jobNow = fromNow(2 * HOUR);
    const oldB = (await contractsRepository.findGraceEnded(jobNow, dayZones(jobNow))).find(
      (row) => row.id === b,
    );
    expect(oldB).toBeDefined();
    const asked = await askExtension(b, freelancer, isoFromNow(8 * DAY));
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(await contractsService.openOverdueDispute(oldB!, jobNow)).toBeNull();
    const cb = await view(b, client.token);
    expect(cb.status).toBe('accepted');
    expect(cb.extension?.status).toBe('pending');
    expect(await disputesOf(b)).toEqual([]);
  });

  it('duas instâncias: o aviso é marcado uma vez só; recusa do cliente e expiração pelo job: exatamente uma passa', async () => {
    const { client, freelancer } = await pair(300);
    const a = await accepted(client, freelancer, { price: 100 });
    await setCols(a, { deadline_at: fromNow(-2 * DAY) });
    const p = {
      id: a,
      deadlineAt: new Date((await dbRow(a)).deadline_at!),
      now: now(),
      graceEndsAt: fromNow(DAY),
    };
    const marks = await Promise.all([
      contractsRepository.markOverdueNotified(p),
      contractsRepository.markOverdueNotified(p),
    ]);
    expect(marks.filter(Boolean)).toHaveLength(1);
    const marked = await dbRow(a);
    expect(new Date(marked.overdue_notified_at!).toISOString()).toBe(p.now.toISOString());
    expect(new Date(marked.grace_ends_at!).toISOString()).toBe(p.graceEndsAt.toISOString());

    // O cliente responde ainda dentro da hora (respond_by daqui a 1 h) enquanto o job de outra
    // instância, já depois dela, expira o mesmo pedido: cada um passa na própria conferência de
    // hora, e só o status 'pending' decide quem grava.
    const b = await accepted(client, freelancer, { price: 100 });
    expect((await askExtension(b, freelancer, isoFromNow(8 * DAY))).status).toBe(200);
    await setCols(b, { extension_respond_by: fromNow(HOUR) });
    const row = await dbRow(b);
    const [declined, expired] = await Promise.all([
      decide(b, client, 'decline'),
      contractsService.expireExtension(row, 24, fromNow(2 * HOUR)),
    ]);
    // Quem perde recebe 409 (a recusa) ou false (o job); nada de erro de servidor.
    expect([200, 409]).toContain(declined.status);
    expect([declined.status === 200, expired].filter(Boolean)).toHaveLength(1);
    const settled = await dbRow(b);
    expect(settled.extension_status).toBe(expired ? 'expired' : 'declined');
    expect(settled.extension_resolved_at).not.toBeNull();
  });
});
