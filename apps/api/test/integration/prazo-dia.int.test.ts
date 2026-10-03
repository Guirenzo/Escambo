import type { BrazilTimezone } from '@escambo/types';
import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runOverdueContracts } from '../../src/jobs/overdue-contracts';
import { addDaysToDay, dayIn, endOfDayIn, formatDue } from '../../src/utils/timezone';
import { now, startDaytimeClock, stopClock } from './clock.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * O prazo é um dia (ADR 58) contra o MySQL real. Nada de fuso gravado: o fuso do prazo é calculado
 * na leitura, o fuso em que o instante marca 23:59:59 (primeiro o de quem entrega, depois o do
 * cliente, depois um nome por relógio); sem isso (legado 23:59:59Z), fica o de quem entrega e a
 * hora real aparece ("até 20:59"). Os avisos dizem o prazo como dia, "qui, 08/10/2026, até 23:59",
 * com " (horário de Manaus)" só para quem está em outro relógio (Manaus e Cuiabá não se anotam).
 * Os dias saem do relógio do teste (12:00 de Brasília de hoje) e os textos esperados são escritos
 * à mão a partir do dia, sem passar pelas funções de formatação da API.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const BRASILIA: BrazilTimezone = 'America/Sao_Paulo';
const MANAUS: BrazilTimezone = 'America/Manaus';
const CUIABA: BrazilTimezone = 'America/Cuiaba';
const RIO_BRANCO: BrazilTimezone = 'America/Rio_Branco';

const TITLE = 'Identidade visual da padaria';
const MIN = 60_000;

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  timezone: BrazilTimezone | null = null,
): Promise<Actor> {
  const email = `int_prazodia_${role}_${Date.now()}_${seq++}@escambo.test`;
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

async function ok(path: string, actor: Actor, body: object = {}): Promise<void> {
  const res = await request(app).post(path).set(auth(actor.token)).send(body);
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
}

interface ContractView {
  id: number;
  status: string;
  deadlineAt: string | null;
  deadlineZone: BrazilTimezone;
  proposalExpiresAt: string | null;
  extension: { seq: number; respondBy: string | null; deadlineZone: BrazilTimezone } | null;
  history: { status: string; note: string | null }[];
  milestones: { id: number; title: string; dueAt: string | null; dueZone: BrazilTimezone }[];
}

async function propose(client: Actor, freelancer: Actor, extra: object): Promise<ContractView> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: TITLE,
      description: 'Logo, cartão de visita e cardápio da padaria do bairro',
      price: 200,
      ...extra,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as ContractView;
}

async function accepted(client: Actor, freelancer: Actor, extra: object): Promise<number> {
  const { id } = await propose(client, freelancer, extra);
  await ok(`/api/contracts/${id}/accept`, freelancer);
  return id;
}

async function view(id: number, actor: Actor): Promise<ContractView> {
  const res = await request(app).get(`/api/contracts/${id}`).set(auth(actor.token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ContractView;
}

/** "Anda o tempo" direto no banco. */
async function setColumns(
  table: 'contracts' | 'contract_milestones',
  id: number,
  cols: Record<string, Date | string | null>,
): Promise<void> {
  const sets = Object.keys(cols)
    .map((k) => `${k} = :${k}`)
    .join(', ');
  await pool.query(`UPDATE ${table} SET ${sets} WHERE id = :id`, { ...cols, id });
}

async function graceEndsAt(id: number): Promise<Date> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT grace_ends_at FROM contracts WHERE id = :id',
    { id },
  );
  expect(rows[0]?.grace_ends_at).toBeTruthy();
  return new Date(rows[0]!.grace_ends_at as Date);
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

/** O envio é "melhor esforço", depois da resposta: espera o aviso chegar e devolve o único. */
async function onlyNotice(userId: number, type: string, contractId: number): Promise<Notice> {
  await expect.poll(async () => (await noticesOf(userId, type, contractId)).length).toBe(1);
  return (await noticesOf(userId, type, contractId))[0]!;
}

const WEEKDAY = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const weekdayOf = (day: string): string => WEEKDAY[new Date(`${day}T12:00:00Z`).getUTCDay()]!;

/** "qui, 08/10/2026, até 23:59", escrito à mão a partir de "2026-10-08". */
function dayText(day: string, until = '23:59'): string {
  const [y, m, d] = day.split('-');
  return `${weekdayOf(day)}, ${d}/${m}/${y}, até ${until}`;
}

/** "qui, 08/10", o dia sem o ano (títulos). */
function shortDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${weekdayOf(day)}, ${d}/${m}`;
}

/** O dia de hoje no fuso, pelo relógio do teste, mais `n` dias. */
const dayFromToday = (zone: BrazilTimezone, n: number): string =>
  addDaysToDay(dayIn(zone, now()), n);

beforeAll(async () => {
  startDaytimeClock();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('O prazo é um dia (ADR 58)', () => {
  it('criar com o fim do dia de Manaus devolve deadlineZone Manaus e a proposta diz "até 23:59"; em outro relógio, com a nota do fuso', async () => {
    const client = await registerAndLogin('client');
    const freManaus = await registerAndLogin('freelancer', MANAUS);
    const freBrasilia = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 400);

    const day = dayFromToday(MANAUS, 10);
    const deadline = endOfDayIn(MANAUS, day);
    // 23:59:59 em Manaus (UTC−4) é 03:59:59 UTC do dia seguinte.
    expect(deadline.toISOString()).toBe(`${addDaysToDay(day, 1)}T03:59:59.000Z`);

    const created = await propose(client, freManaus, { deadlineAt: deadline.toISOString() });
    expect(created.deadlineAt).toBe(deadline.toISOString());
    expect(created.deadlineZone).toBe(MANAUS);
    // As duas partes leem o mesmo dia, cada uma da sua conta.
    expect((await view(created.id, client)).deadlineZone).toBe(MANAUS);
    expect((await view(created.id, freManaus)).deadlineZone).toBe(MANAUS);
    const proposal = await onlyNotice(freManaus.id, 'contract_proposal', created.id);
    expect(proposal.title).toBe('Nova proposta de contratação');
    expect(proposal.body).toBe(
      `${TITLE}. Prazo de entrega: ${dayText(day)}. Responda até ${formatDue(new Date(created.proposalExpiresAt!), MANAUS)}.`,
    );

    // Quem entrega está em Brasília e o dia é o de Manaus (chamada direta à API): o fuso do prazo
    // é Manaus, e a proposta diz isso a quem está em outro relógio.
    const other = await propose(client, freBrasilia, { deadlineAt: deadline.toISOString() });
    expect(other.deadlineZone).toBe(MANAUS);
    const otherProposal = await onlyNotice(freBrasilia.id, 'contract_proposal', other.id);
    expect(otherProposal.body).toBe(
      `${TITLE}. Prazo de entrega: ${dayText(day)} (horário de Manaus). Responda até ${formatDue(new Date(other.proposalExpiresAt!), BRASILIA)}.`,
    );
  });

  it('marcos com data e contratação sem prazo: cada marco no fuso em que vence o dia (Cuiabá antes de Manaus para quem está lá), sem data no de quem entrega; o marco atrasado diz o dia', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer', CUIABA);
    await fundWallet(app, client.token, 400);

    const d = (n: number): string => dayFromToday(CUIABA, n);
    const created = await propose(client, freelancer, {
      price: 350,
      deadlineAt: null,
      milestones: [
        { title: 'Rascunho', amount: 100, dueAt: endOfDayIn(MANAUS, d(3)).toISOString() },
        { title: 'Arte final', amount: 100, dueAt: endOfDayIn(BRASILIA, d(5)).toISOString() },
        {
          title: 'Manual da marca',
          amount: 100,
          dueAt: endOfDayIn(RIO_BRANCO, d(6)).toISOString(),
        },
        { title: 'Ajustes', amount: 50 },
      ],
    });
    expect(created.deadlineAt).toBeNull();
    // Sem prazo, a contratação fica no fuso de quem entrega.
    expect(created.deadlineZone).toBe(CUIABA);
    const milestones = (await view(created.id, client)).milestones;
    expect(milestones.map((m) => [m.title, m.dueZone])).toEqual([
      // 23:59:59 de Manaus também é 23:59:59 em Cuiabá: vale o nome de quem entrega.
      ['Rascunho', CUIABA],
      ['Arte final', BRASILIA],
      // Ninguém está em Rio Branco: o nome vem da lista de relógios.
      ['Manual da marca', RIO_BRANCO],
      ['Ajustes', CUIABA],
    ]);

    // O primeiro marco venceu ontem às 23:59:59 de Brasília, sem entrega.
    await ok(`/api/contracts/${created.id}/accept`, freelancer);
    const first = milestones[0]!;
    const yesterday = dayFromToday(BRASILIA, -1);
    await setColumns('contract_milestones', first.id, {
      due_at: endOfDayIn(BRASILIA, yesterday),
    });
    expect((await view(created.id, freelancer)).milestones[0]!.dueZone).toBe(BRASILIA);

    const job = await runOverdueContracts(now());
    expect(job.failed).toEqual([]);
    expect(job.milestones).toContain(first.id);
    const toFreelancer = await onlyNotice(freelancer.id, 'milestone_overdue', created.id);
    expect(toFreelancer).toEqual({
      title: 'Marco atrasado: Rascunho',
      body: `${TITLE}: o prazo deste marco era ${dayText(yesterday)} (horário de Brasília). Entregue o marco ou combine com o cliente pelo chat.`,
    });
    const toClient = await onlyNotice(client.id, 'milestone_overdue', created.id);
    expect(toClient).toEqual({
      title: 'Marco atrasado: Rascunho',
      body: `${TITLE}: o prazo deste marco era ${dayText(yesterday)} e ele não foi entregue. É o prazo da contratação que abre a disputa automática.`,
    });
  });

  it('o cliente em Manaus lê "(horário de Brasília)" no aviso de atraso de um prazo de Brasília; quem está em Cuiabá lendo prazo de Manaus não vê nota', async () => {
    const cliManaus = await registerAndLogin('client', MANAUS);
    const cliCuiaba = await registerAndLogin('client', CUIABA);
    const freBrasilia = await registerAndLogin('freelancer');
    const freManaus = await registerAndLogin('freelancer', MANAUS);
    await fundWallet(app, cliManaus.token, 300);
    await fundWallet(app, cliCuiaba.token, 300);

    // Prazo de Brasília: venceu ontem às 23:59:59 de lá.
    const yBrasilia = dayFromToday(BRASILIA, -1);
    const brasilia = await accepted(cliManaus, freBrasilia, {
      deadlineAt: endOfDayIn(BRASILIA, dayFromToday(BRASILIA, 10)).toISOString(),
    });
    await setColumns('contracts', brasilia, { deadline_at: endOfDayIn(BRASILIA, yBrasilia) });
    // Prazo de Manaus: venceu ontem às 23:59:59 de Manaus.
    const yManaus = dayFromToday(MANAUS, -1);
    const manaus = await accepted(cliCuiaba, freManaus, {
      deadlineAt: endOfDayIn(MANAUS, dayFromToday(MANAUS, 10)).toISOString(),
    });
    await setColumns('contracts', manaus, { deadline_at: endOfDayIn(MANAUS, yManaus) });
    expect((await view(brasilia, cliManaus)).deadlineZone).toBe(BRASILIA);
    expect((await view(manaus, cliCuiaba)).deadlineZone).toBe(MANAUS);

    const job = await runOverdueContracts(now());
    expect(job.failed).toEqual([]);
    expect(job.notified).toEqual(expect.arrayContaining([brasilia, manaus]));

    const graceB = await graceEndsAt(brasilia);
    expect((await onlyNotice(freBrasilia.id, 'contract_overdue', brasilia)).body).toBe(
      `Até ${formatDue(graceB, BRASILIA)}: entregue ou peça a extensão, senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. O prazo era ${dayText(yBrasilia)}.`,
    );
    expect((await onlyNotice(cliManaus.id, 'contract_overdue', brasilia)).body).toBe(
      `Sem entrega nem extensão aceita até ${formatDue(graceB, MANAUS)}, a disputa abre sozinha. Se preferir, cancele com reembolso integral. O prazo era ${dayText(yBrasilia)} (horário de Brasília) e não houve entrega.`,
    );

    // Manaus e Cuiabá marcam a mesma hora: ninguém lê nota.
    const graceM = await graceEndsAt(manaus);
    expect((await onlyNotice(freManaus.id, 'contract_overdue', manaus)).body).toBe(
      `Até ${formatDue(graceM, MANAUS)}: entregue ou peça a extensão, senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. O prazo era ${dayText(yManaus)}.`,
    );
    expect((await onlyNotice(cliCuiaba.id, 'contract_overdue', manaus)).body).toBe(
      `Sem entrega nem extensão aceita até ${formatDue(graceM, CUIABA)}, a disputa abre sozinha. Se preferir, cancele com reembolso integral. O prazo era ${dayText(yManaus)} e não houve entrega.`,
    );
  });

  it('extensão aceita: o pedido (com o fuso da data pedida) e o aviso dizem o novo dia, o fuso do prazo passa a ser o da nova data e o histórico guarda os dois dias', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer', MANAUS);
    await fundWallet(app, client.token, 300);

    // O prazo é o fim do dia em Brasília; o pedido é para o fim do dia em Manaus.
    const oldDay = dayFromToday(BRASILIA, 5);
    const id = await accepted(client, freelancer, {
      deadlineAt: endOfDayIn(BRASILIA, oldDay).toISOString(),
    });
    expect((await view(id, freelancer)).deadlineZone).toBe(BRASILIA);

    const newDay = dayFromToday(MANAUS, 12);
    const reason = 'As fotos do cardápio chegaram com atraso';
    await ok(`/api/contracts/${id}/extension`, freelancer, {
      deadlineAt: endOfDayIn(MANAUS, newDay).toISOString(),
      reason,
    });
    const pending = await view(id, client);
    expect(pending.extension?.respondBy).toBeTruthy();
    // A data pedida é o fim do dia em Manaus: o pedido vem com o fuso dela, e o prazo atual segue
    // no de Brasília.
    expect(pending.extension?.deadlineZone).toBe(MANAUS);
    expect(pending.deadlineZone).toBe(BRASILIA);
    // O cliente, em Brasília, lê a data pedida com o fuso dela.
    expect((await onlyNotice(client.id, 'deadline_extension_requested', id)).body).toBe(
      `Responda até ${formatDue(new Date(pending.extension!.respondBy!), BRASILIA)}: novo prazo proposto ${dayText(newDay)} (horário de Manaus). Sem resposta, o pedido expira e vale o prazo atual. Motivo: ${reason}`,
    );

    await ok(`/api/contracts/${id}/extension/accept`, client, { seq: pending.extension!.seq });
    expect(await onlyNotice(freelancer.id, 'deadline_extension_accepted', id)).toEqual({
      title: `Extensão aceita: novo prazo ${shortDay(newDay)}`,
      body: `${TITLE}: o novo prazo é ${dayText(newDay)}; não há outra extensão nesta contratação.`,
    });
    const after = await view(id, client);
    expect(after.deadlineAt).toBe(endOfDayIn(MANAUS, newDay).toISOString());
    expect(after.deadlineZone).toBe(MANAUS);
    expect(after.extension?.deadlineZone).toBe(MANAUS);
    // O histórico não tem leitor: o novo prazo sempre leva o fuso.
    expect(after.history.at(-1)?.note).toBe(
      `Prazo estendido de ${shortDay(oldDay)} para ${dayText(newDay)} (horário de Manaus) (RN-028): ${reason}`,
    );
  });

  it('legado 23:59:59Z fica no fuso do freelancer: "até 20:59" em Brasília, "até 19:59" em Manaus', async () => {
    const cliManaus = await registerAndLogin('client', MANAUS);
    const cliBrasilia = await registerAndLogin('client');
    const freBrasilia = await registerAndLogin('freelancer');
    const freManaus = await registerAndLogin('freelancer', MANAUS);
    await fundWallet(app, cliManaus.token, 300);
    await fundWallet(app, cliBrasilia.token, 300);

    // A tela antiga gravava o fim do dia em UTC: 23:59:59Z não é 23:59:59 em fuso nenhum do Brasil.
    const yBrasilia = dayFromToday(BRASILIA, -1);
    const inBrasilia = await accepted(cliManaus, freBrasilia, {
      deadlineAt: endOfDayIn(BRASILIA, dayFromToday(BRASILIA, 10)).toISOString(),
    });
    await setColumns('contracts', inBrasilia, { deadline_at: `${yBrasilia} 23:59:59` });
    const yManaus = dayFromToday(MANAUS, -1);
    const inManaus = await accepted(cliBrasilia, freManaus, {
      deadlineAt: endOfDayIn(MANAUS, dayFromToday(MANAUS, 10)).toISOString(),
    });
    await setColumns('contracts', inManaus, { deadline_at: `${yManaus} 23:59:59` });

    const legacyB = await view(inBrasilia, cliManaus);
    expect(legacyB.deadlineAt).toBe(`${yBrasilia}T23:59:59.000Z`);
    expect(legacyB.deadlineZone).toBe(BRASILIA);
    expect((await view(inManaus, cliBrasilia)).deadlineZone).toBe(MANAUS);

    const job = await runOverdueContracts(now());
    expect(job.failed).toEqual([]);
    expect(job.notified).toEqual(expect.arrayContaining([inBrasilia, inManaus]));

    const graceB = await graceEndsAt(inBrasilia);
    expect((await onlyNotice(freBrasilia.id, 'contract_overdue', inBrasilia)).body).toBe(
      `Até ${formatDue(graceB, BRASILIA)}: entregue ou peça a extensão, senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. O prazo era ${dayText(yBrasilia, '20:59')}.`,
    );
    expect((await onlyNotice(cliManaus.id, 'contract_overdue', inBrasilia)).body).toBe(
      `Sem entrega nem extensão aceita até ${formatDue(graceB, MANAUS)}, a disputa abre sozinha. Se preferir, cancele com reembolso integral. O prazo era ${dayText(yBrasilia, '20:59')} (horário de Brasília) e não houve entrega.`,
    );

    const graceM = await graceEndsAt(inManaus);
    expect((await onlyNotice(freManaus.id, 'contract_overdue', inManaus)).body).toBe(
      `Até ${formatDue(graceM, MANAUS)}: entregue ou peça a extensão, senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. O prazo era ${dayText(yManaus, '19:59')}.`,
    );
    expect((await onlyNotice(cliBrasilia.id, 'contract_overdue', inManaus)).body).toBe(
      `Sem entrega nem extensão aceita até ${formatDue(graceM, BRASILIA)}, a disputa abre sozinha. Se preferir, cancele com reembolso integral. O prazo era ${dayText(yManaus, '19:59')} (horário de Manaus) e não houve entrega.`,
    );
  });

  it('o freelancer muda de fuso: o prazo continua o dia de Brasília, e o aviso de atraso sai na hora e no fuso atuais dele', async () => {
    const client = await registerAndLogin('client');
    const freelancer = await registerAndLogin('freelancer');
    await fundWallet(app, client.token, 300);

    const yesterday = dayFromToday(BRASILIA, -1);
    const id = await accepted(client, freelancer, {
      deadlineAt: endOfDayIn(BRASILIA, dayFromToday(BRASILIA, 10)).toISOString(),
    });
    await setColumns('contracts', id, { deadline_at: endOfDayIn(BRASILIA, yesterday) });

    const moved = await request(app)
      .put('/api/notifications/preferences')
      .set(auth(freelancer.token))
      .send({ timezone: RIO_BRANCO });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.timezone).toBe(RIO_BRANCO);
    // O instante só é 23:59:59 em Brasília: o dia não muda com a mudança de quem entrega.
    expect((await view(id, freelancer)).deadlineZone).toBe(BRASILIA);

    // 10:30 em Brasília, 08:30 em Rio Branco: o aviso espera as 9h do fuso atual dele.
    const early = new Date(now().getTime() - 90 * MIN);
    const before = await runOverdueContracts(early);
    expect(before.zones).toContain(BRASILIA);
    expect(before.zones).not.toContain(RIO_BRANCO);
    expect(before.notified).not.toContain(id);
    expect(await noticesOf(freelancer.id, 'contract_overdue', id)).toEqual([]);

    const job = await runOverdueContracts(now());
    expect(job.failed).toEqual([]);
    expect(job.notified).toContain(id);
    const grace = await graceEndsAt(id);
    expect((await onlyNotice(freelancer.id, 'contract_overdue', id)).body).toBe(
      `Até ${formatDue(grace, RIO_BRANCO)}: entregue ou peça a extensão, senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. O prazo era ${dayText(yesterday)} (horário de Brasília).`,
    );
    expect((await onlyNotice(client.id, 'contract_overdue', id)).body).toBe(
      `Sem entrega nem extensão aceita até ${formatDue(grace, BRASILIA)}, a disputa abre sozinha. Se preferir, cancele com reembolso integral. O prazo era ${dayText(yesterday)} e não houve entrega.`,
    );
  });
});
