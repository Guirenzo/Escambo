import type { BrazilTimezone } from '@escambo/types';
import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runExpireProposals } from '../../src/jobs/expire-proposals';
import { runOverdueContracts } from '../../src/jobs/overdue-contracts';
import { runRepairDeadlines, type RepairDeadlinesResult } from '../../src/jobs/repair-deadlines';
import { runTacitApproval } from '../../src/jobs/tacit-approval';
import { extensionRespondBy, graceEndFrom } from '../../src/modules/contracts/deadline-grace';
import { floorSecond, humanize, lastHumanAtOrBefore } from '../../src/utils/human-hours';
import { DAY, fromNow, HOUR, isoFromNow, now, startDaytimeClock, stopClock } from './clock.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * Reparo dos prazos (ADR 57 e 58, jobs/repair-deadlines.ts) contra o MySQL real. As contratações de
 * antes da 0027 (e o que a API antiga grava durante o deploy) chegam com as colunas novas vazias e
 * o contador de pedidos zerado: aqui cada linha é criada pela API e levada ao formato antigo pelo
 * SQL. Uma rodada do reparo preenche cada uma com a hora humana no fuso ATUAL de quem é afetado
 * (freelancer em Manaus ou Noronha, cliente em Rio Branco ou Noronha, os demais em Brasília), uma
 * segunda rodada não muda nada, e as sanções (expiração do pedido, disputa, aprovação tácita,
 * proposta vencida) saem na rodada seguinte dos jobs, na hora reparada. ADR 58: as revisões em
 * aberto ganham a hora do pedido (a do último pedido no histórico da contratação; no marco, a da
 * nota "Revisão pedida no marco «título»" quando o título é único na contratação; senão, a da
 * rodada), nunca antes da última entrega, e dela conta o aviso de revisão parada. A mesma conta
 * conserta a hora que ficou de outro ciclo (a volta da 1.40 pediu a revisão de novo sem gravá-la).
 * O reparo varre o banco inteiro: tudo é conferido por id. Os valores esperados saem das mesmas
 * funções puras de hora que a API usa e, em vários casos, também de instantes escritos à mão.
 * Configurações do seed: carência de 24 h, proposta de 72 h, aprovação tácita em 5 dias.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

const BRASILIA: BrazilTimezone = 'America/Sao_Paulo';
const MANAUS: BrazilTimezone = 'America/Manaus';
const NORONHA: BrazilTimezone = 'America/Noronha';
const RIO_BRANCO: BrazilTimezone = 'America/Rio_Branco';

/**
 * Instantes escritos à mão, em março de 2026 (sem horário de verão): Noronha UTC−2, Brasília
 * UTC−3, Manaus UTC−4, Rio Branco UTC−5.
 */
const OLD_DEADLINE = new Date('2026-03-09T19:00:00Z');
/** Aviso dado às 19:40 em Manaus (20:40 em Brasília). */
const NOTICE_MANAUS = new Date('2026-03-10T23:40:00Z');
/** Proposta criada às 20:15 de 10/03 em Manaus (21:15 em Brasília). */
const PROPOSAL_CREATED = new Date('2026-03-11T00:15:00Z');
/** Primeira entrega (depois veio a revisão) e a última, às 20:50 em Brasília. */
const FIRST_DELIVERY = new Date('2026-03-04T14:00:00Z');
const LAST_DELIVERY = new Date('2026-03-10T23:50:00Z');
/** Os dois pedidos de revisão de uma contratação antiga: vale o último. */
const FIRST_REVISION = new Date('2026-03-05T14:00:00Z');
const LAST_REVISION = new Date('2026-03-08T13:30:00Z');
/** As duas entregas dessa contratação, cada uma antes do pedido que veio depois dela. */
const REVISED_DELIVERIES = [new Date('2026-03-04T18:00:00Z'), new Date('2026-03-07T16:00:00Z')];
/** Marco de título único entregue e devolvido para revisão: a hora da nota na linha do tempo. */
const MILESTONE_DELIVERED = new Date('2026-03-05T17:00:00Z');
const MILESTONE_REVISION = new Date('2026-03-06T12:45:00Z');
/**
 * A volta da 1.40: a API nova gravou a hora do 1º pedido; a 1.40 registrou a nova entrega e o 2º
 * pedido sem gravá-la. A coluna ficou com a hora do ciclo anterior, antes da última entrega.
 */
const RETURN_DELIVERIES = [new Date('2026-03-02T13:00:00Z'), new Date('2026-03-06T13:00:00Z')];
const RETURN_REVISIONS = [new Date('2026-03-03T13:00:00Z'), new Date('2026-03-07T13:00:00Z')];
/** O mesmo num marco: as entregas ficam em `delivered_at` (só a última), os pedidos nas notas. */
const RETURN_MILESTONE_DELIVERED = new Date('2026-03-06T15:00:00Z');
const RETURN_MILESTONE_REVISIONS = [
  new Date('2026-03-03T15:00:00Z'),
  new Date('2026-03-07T15:00:00Z'),
];

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  timezone: BrazilTimezone | null = null,
): Promise<Actor> {
  const email = `int_reparo_${role}_${Date.now()}_${seq++}@escambo.test`;
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

const MILESTONES = [
  { title: 'Rascunho', amount: 100 },
  { title: 'Arte final', amount: 100 },
];

async function propose(client: Actor, freelancer: Actor, extra: object = {}): Promise<number> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: 'Identidade visual da padaria',
      description: 'Logo, cartão de visita e cardápio da padaria do bairro',
      price: 200,
      deadlineAt: isoFromNow(5 * DAY),
      ...extra,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

async function accepted(client: Actor, freelancer: Actor, extra: object = {}): Promise<number> {
  const id = await propose(client, freelancer, extra);
  await ok(`/api/contracts/${id}/accept`, freelancer);
  return id;
}

const askExtension = (id: number, freelancer: Actor): Promise<void> =>
  ok(`/api/contracts/${id}/extension`, freelancer, {
    deadlineAt: isoFromNow(12 * DAY),
    reason: 'As fotos do cardápio chegaram com atraso',
  });

const deliver = (id: number, freelancer: Actor): Promise<void> =>
  ok(`/api/contracts/${id}/deliver`, freelancer, { message: 'Arquivos finais no chat.' });

const askRevision = (id: number, client: Actor): Promise<void> =>
  ok(`/api/contracts/${id}/request-revision`, client, { note: 'Ajustar as cores do cardápio' });

const askMilestoneRevision = (id: number, milestoneId: number, client: Actor): Promise<void> =>
  ok(`/api/contracts/${id}/milestones/${milestoneId}/request-revision`, client, {
    note: 'Trocar a fonte do rascunho',
  });

const deliverMilestone = (id: number, milestoneId: number, freelancer: Actor): Promise<void> =>
  ok(`/api/contracts/${id}/milestones/${milestoneId}/deliver`, freelancer, {
    message: 'Rascunho no chat.',
  });

/** Os marcos da contratação, na ordem. */
async function milestoneIds(id: number, token: string): Promise<number[]> {
  const res = await request(app).get(`/api/contracts/${id}`).set(auth(token));
  expect(res.status).toBe(200);
  return (res.body.milestones as { id: number }[]).map((m) => m.id);
}

async function firstMilestone(id: number, token: string): Promise<number> {
  return (await milestoneIds(id, token))[0]!;
}

/** Leva a linha ao formato antigo (ou "anda o tempo") direto no banco. */
async function setColumns(
  table: 'contracts' | 'contract_milestones',
  id: number,
  cols: Record<string, Date | number | string | null>,
): Promise<void> {
  const sets = Object.keys(cols)
    .map((k) => `${k} = :${k}`)
    .join(', ');
  await pool.query(`UPDATE ${table} SET ${sets} WHERE id = :id`, { ...cols, id });
}

/**
 * Põe horas escritas à mão nas linhas da contratação (no histórico ou nas entregas), na ordem em
 * que foram gravadas: uma hora por linha. O histórico grava com o relógio do banco, e as entregas
 * com o do fluxo; aqui as duas contam a mesma história.
 */
async function restamp(
  table: 'contract_status_history' | 'deliveries',
  contractId: number,
  filter: string,
  params: Record<string, string>,
  times: Date[],
): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM ${table} WHERE contract_id = :contractId AND ${filter} ORDER BY id`,
    { ...params, contractId },
  );
  expect(rows).toHaveLength(times.length);
  const sets = table === 'deliveries' ? 'created_at = :at, delivered_at = :at' : 'created_at = :at';
  for (const [i, at] of times.entries()) {
    await pool.query(`UPDATE ${table} SET ${sets} WHERE id = :id`, { id: rows[i]!.id, at });
  }
}

/** As entregas da contratação, uma hora por entrega. */
const restampDeliveries = (contractId: number, times: Date[]): Promise<void> =>
  restamp('deliveries', contractId, '1 = 1', {}, times);

/** Os pedidos de revisão da entrega única no histórico. */
const restampRevisions = (contractId: number, times: Date[]): Promise<void> =>
  restamp(
    'contract_status_history',
    contractId,
    'new_status = :status',
    { status: 'revision_requested' },
    times,
  );

/** As notas "Revisão pedida no marco «título»" da linha do tempo. */
const restampMilestoneRevisions = (
  contractId: number,
  title: string,
  times: Date[],
): Promise<void> =>
  restamp(
    'contract_status_history',
    contractId,
    'note LIKE :like',
    { like: `Revisão pedida no marco «${title}»%` },
    times,
  );

interface ContractCols extends RowDataPacket {
  status: string;
  deadline_at: Date | null;
  created_at: Date;
  extension_status: string;
  extension_requests: number;
  extension_deadline_at: Date | null;
  extension_respond_by: Date | null;
  extension_resolved_at: Date | null;
  overdue_notified_at: Date | null;
  grace_ends_at: Date | null;
  approval_due_at: Date | null;
  proposal_expires_at: Date | null;
  revision_requested_at: Date | null;
}

const COLS = `id, status, deadline_at, created_at, extension_status, extension_requests,
  extension_deadline_at, extension_respond_by, extension_resolved_at, overdue_notified_at,
  grace_ends_at, approval_due_at, proposal_expires_at, revision_requested_at`;

async function contractRow(id: number): Promise<ContractCols> {
  const [rows] = await pool.query<ContractCols[]>(`SELECT ${COLS} FROM contracts WHERE id = :id`, {
    id,
  });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

interface MilestoneCols extends RowDataPacket {
  status: string;
  delivered_at: Date | null;
  approval_due_at: Date | null;
  revision_requested_at: Date | null;
}

async function milestoneRow(id: number): Promise<MilestoneCols> {
  const [rows] = await pool.query<MilestoneCols[]>(
    `SELECT id, status, delivered_at, approval_due_at, revision_requested_at
       FROM contract_milestones WHERE id = :id`,
    { id },
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** O relógio do fluxo começou às 12:00 de Brasília de hoje: base dos valores escritos à mão. */
let noon: Date;
const fromNoon = (ms: number): string => new Date(noon.getTime() + ms).toISOString();
const MIN = 60_000;

beforeAll(async () => {
  noon = startDaytimeClock();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('Reparo dos prazos: linhas de antes da 0027', () => {
  /** As contratações montadas, por caso. */
  const c = {
    /** 1: extensão aceita pela API antiga, que zerou o aviso e deixou a carência. */
    graceNoNotice: 0,
    /** 1 (controle): aviso e carência gravados, nenhum pedido (contador 0 com 'none'). */
    graceWithNotice: 0,
    /** 2: pedido recusado com o contador zerado. */
    declined: 0,
    /** 3: pedido pendente numa contratação já entregue. */
    pendingDelivered: 0,
    /** 3: pedido pendente numa contratação concluída. */
    pendingCompleted: 0,
    /** 4: data pedida longe, cliente em Noronha. */
    respondFar: 0,
    /** 4: data pedida daqui a ~50 h, cliente em Noronha: vale o limite 12 h antes da data. */
    respondNear: 0,
    /** 4: data pedida já passada, cliente em Rio Branco. */
    respondPast: 0,
    /** 4: data pedida daqui a 10 h, cliente em Rio Branco. */
    respondSoon: 0,
    /** 5 e 13: aviso de março, freelancer em Manaus. */
    noticeManaus: 0,
    /** 5: por marcos, em andamento, freelancer em Noronha. */
    noticeInProgress: 0,
    /** 5 e 10: revisão pedida (fora da RN-029), com aviso da API antiga; a hora do pedido já gravada. */
    noticeRevision: 0,
    /** 6 e 13: proposta de março, freelancer em Manaus. */
    proposalOld: 0,
    /** 6: proposta com o prazo amanhã de madrugada, freelancer em Manaus. */
    proposalNearDeadline: 0,
    /** 7 e 13: entrega, revisão e nova entrega; a última em março. */
    deliveredOld: 0,
    /** 8 e 13: marco entregue, cliente em Rio Branco. */
    milestoneContract: 0,
    /** 10: duas entregas e duas revisões pedidas em março, sem a hora do pedido gravada. */
    revisionOld: 0,
    /** 10: em revisão sem nenhum pedido no histórico (gravado pela API antiga direto no status). */
    revisionNoHistory: 0,
    /** 11: marcos devolvidos para revisão sem a hora do pedido: um de título único, um repetido. */
    milestoneRevisionContract: 0,
    /** Volta da 1.40: o 2º pedido de revisão ficou com a hora do 1º, anterior à última entrega. */
    revisionReturn: 0,
    /** Volta da 1.40, num marco. */
    milestoneReturnContract: 0,
  };
  let milestoneId = 0;
  /** 11: o marco «Rascunho» (título único na contratação). */
  let revisionMilestoneId = 0;
  /** 11: o 1º dos dois marcos «Ajustes» (título repetido na contratação). */
  let repeatedMilestoneId = 0;
  /** Volta da 1.40: o marco «Rascunho» pedido de novo. */
  let returnMilestoneId = 0;
  /** A hora do pedido que a API gravou na revisão do caso 5 (não pode mudar). */
  let apiRevisionAt: Date;
  /** O instante da primeira rodada do reparo. */
  let t: Date;
  let first: RepairDeadlinesResult;
  /** Valores gravados à parte, para conferir depois. */
  let controlGraceEnds: Date;

  beforeAll(async () => {
    const cliBrasilia = await registerAndLogin('client');
    const cliRioBranco = await registerAndLogin('client', RIO_BRANCO);
    const cliNoronha = await registerAndLogin('client', NORONHA);
    const freBrasilia = await registerAndLogin('freelancer');
    const freManaus = await registerAndLogin('freelancer', MANAUS);
    const freNoronha = await registerAndLogin('freelancer', NORONHA);
    await fundWallet(app, cliBrasilia.token, 4000);
    await fundWallet(app, cliRioBranco.token, 1000);
    await fundWallet(app, cliNoronha.token, 1000);

    // 1. Extensão aceita pela API antiga durante o deploy: o aviso foi zerado, a carência ficou.
    c.graceNoNotice = await accepted(cliBrasilia, freBrasilia);
    await askExtension(c.graceNoNotice, freBrasilia);
    await ok(`/api/contracts/${c.graceNoNotice}/extension/accept`, cliBrasilia);
    await setColumns('contracts', c.graceNoNotice, {
      grace_ends_at: fromNow(20 * HOUR),
      extension_requests: 0,
    });
    // Controle: com o aviso dado, a carência fica; sem pedido, o contador segue 0.
    c.graceWithNotice = await accepted(cliBrasilia, freBrasilia);
    controlGraceEnds = fromNow(20 * HOUR);
    await setColumns('contracts', c.graceWithNotice, {
      deadline_at: fromNow(-DAY),
      overdue_notified_at: fromNow(-4 * HOUR),
      grace_ends_at: controlGraceEnds,
    });

    // 2. Recusa gravada pela API antiga: o contador não existia.
    c.declined = await accepted(cliBrasilia, freBrasilia);
    await askExtension(c.declined, freBrasilia);
    await ok(`/api/contracts/${c.declined}/extension/decline`, cliBrasilia);
    await setColumns('contracts', c.declined, { extension_requests: 0 });

    // 3. A API antiga entregava sem encerrar o pedido pendente.
    const legacyPending = {
      extension_status: 'pending',
      extension_resolved_at: null,
      extension_respond_by: null,
      extension_requests: 0,
    };
    c.pendingDelivered = await accepted(cliBrasilia, freBrasilia);
    await askExtension(c.pendingDelivered, freBrasilia);
    await deliver(c.pendingDelivered, freBrasilia);
    await setColumns('contracts', c.pendingDelivered, legacyPending);
    c.pendingCompleted = await accepted(cliBrasilia, freBrasilia);
    await askExtension(c.pendingCompleted, freBrasilia);
    await deliver(c.pendingCompleted, freBrasilia);
    await ok(`/api/contracts/${c.pendingCompleted}/approve`, cliBrasilia);
    await setColumns('contracts', c.pendingCompleted, legacyPending);

    // 4. Pedidos pendentes sem a hora de resposta (a coluna não existia).
    const legacyRequest = { extension_respond_by: null, extension_requests: 0 };
    c.respondFar = await accepted(cliNoronha, freBrasilia);
    await askExtension(c.respondFar, freBrasilia);
    await setColumns('contracts', c.respondFar, legacyRequest);
    c.respondNear = await accepted(cliNoronha, freBrasilia);
    await askExtension(c.respondNear, freBrasilia);
    await setColumns('contracts', c.respondNear, {
      ...legacyRequest,
      deadline_at: new Date(noon.getTime() + DAY),
      extension_deadline_at: new Date(noon.getTime() + 50 * HOUR),
    });
    c.respondPast = await accepted(cliRioBranco, freBrasilia);
    await askExtension(c.respondPast, freBrasilia);
    await setColumns('contracts', c.respondPast, {
      ...legacyRequest,
      deadline_at: fromNow(-2 * DAY),
      extension_deadline_at: fromNow(-2 * HOUR),
    });
    c.respondSoon = await accepted(cliRioBranco, freBrasilia);
    await askExtension(c.respondSoon, freBrasilia);
    await setColumns('contracts', c.respondSoon, {
      ...legacyRequest,
      deadline_at: fromNow(-DAY),
      extension_deadline_at: fromNow(10 * HOUR),
    });

    // 5. Aviso dado pela API antiga, sem o fim da carência.
    c.noticeManaus = await accepted(cliBrasilia, freManaus);
    await setColumns('contracts', c.noticeManaus, {
      deadline_at: OLD_DEADLINE,
      overdue_notified_at: NOTICE_MANAUS,
      grace_ends_at: null,
    });
    c.noticeInProgress = await accepted(cliBrasilia, freNoronha, {
      deadlineAt: isoFromNow(10 * DAY),
      milestones: MILESTONES,
    });
    const inProgressMilestone = await firstMilestone(c.noticeInProgress, cliBrasilia.token);
    await ok(
      `/api/contracts/${c.noticeInProgress}/milestones/${inProgressMilestone}/deliver`,
      freNoronha,
      { message: 'Rascunho no chat.' },
    );
    await setColumns('contracts', c.noticeInProgress, {
      deadline_at: fromNow(-DAY),
      overdue_notified_at: fromNow(-16 * HOUR),
      grace_ends_at: null,
    });
    c.noticeRevision = await accepted(cliBrasilia, freBrasilia);
    await deliver(c.noticeRevision, freBrasilia);
    await askRevision(c.noticeRevision, cliBrasilia);
    await setColumns('contracts', c.noticeRevision, {
      deadline_at: fromNow(-DAY),
      overdue_notified_at: fromNow(-3 * HOUR),
      grace_ends_at: null,
    });

    // 6. Propostas sem validade gravada.
    c.proposalOld = await propose(cliBrasilia, freManaus, { deadlineAt: isoFromNow(10 * DAY) });
    await setColumns('contracts', c.proposalOld, {
      created_at: PROPOSAL_CREATED,
      proposal_expires_at: null,
    });
    c.proposalNearDeadline = await propose(cliBrasilia, freManaus, {
      deadlineAt: isoFromNow(10 * DAY),
    });
    await setColumns('contracts', c.proposalNearDeadline, {
      created_at: now(),
      deadline_at: new Date(noon.getTime() + 20 * HOUR),
      proposal_expires_at: null,
    });

    // 7. Entrega única sem a hora da aprovação tácita; o histórico tem duas entregas.
    c.deliveredOld = await accepted(cliBrasilia, freManaus);
    await deliver(c.deliveredOld, freManaus);
    await askRevision(c.deliveredOld, cliBrasilia);
    await deliver(c.deliveredOld, freManaus);
    await restamp(
      'contract_status_history',
      c.deliveredOld,
      'new_status = :status',
      { status: 'delivered' },
      [FIRST_DELIVERY, LAST_DELIVERY],
    );
    await setColumns('contracts', c.deliveredOld, { approval_due_at: null });

    // 8. Marco entregue sem a hora da aprovação tácita: às 21:00 de Brasília, 19:00 em Rio Branco.
    c.milestoneContract = await accepted(cliRioBranco, freBrasilia, {
      deadlineAt: null,
      milestones: MILESTONES,
    });
    milestoneId = await firstMilestone(c.milestoneContract, cliRioBranco.token);
    await ok(
      `/api/contracts/${c.milestoneContract}/milestones/${milestoneId}/deliver`,
      freBrasilia,
      {
        message: 'Rascunho no chat.',
      },
    );
    await setColumns('contract_milestones', milestoneId, {
      delivered_at: new Date(noon.getTime() - 6 * DAY + 9 * HOUR),
      approval_due_at: null,
    });

    // 10. Contratação em revisão de antes da 0029: o histórico tem dois pedidos (vale o último), e
    // cada entrega veio antes do pedido seguinte, como na vida real.
    c.revisionOld = await accepted(cliBrasilia, freBrasilia);
    await deliver(c.revisionOld, freBrasilia);
    await askRevision(c.revisionOld, cliBrasilia);
    await deliver(c.revisionOld, freBrasilia);
    await askRevision(c.revisionOld, cliBrasilia);
    await restampDeliveries(c.revisionOld, REVISED_DELIVERIES);
    await restampRevisions(c.revisionOld, [FIRST_REVISION, LAST_REVISION]);
    await setColumns('contracts', c.revisionOld, { revision_requested_at: null });
    // Sem pedido no histórico: a hora da rodada.
    c.revisionNoHistory = await accepted(cliBrasilia, freBrasilia);
    await deliver(c.revisionNoHistory, freBrasilia);
    await setColumns('contracts', c.revisionNoHistory, {
      status: 'revision_requested',
      revision_requested_at: null,
    });
    // Controle: a revisão do caso 5 foi pedida pela API nova, que já gravou a hora.
    const [[control]] = (await pool.query(
      'SELECT revision_requested_at FROM contracts WHERE id = :id',
      { id: c.noticeRevision },
    )) as unknown as [[{ revision_requested_at: Date | null }]];
    expect(control.revision_requested_at).not.toBeNull();
    apiRevisionAt = new Date(control.revision_requested_at!);

    // 11. Marcos devolvidos para revisão de antes da 0030. «Rascunho» é único na contratação: a
    // nota da linha do tempo diz a hora. «Ajustes» aparece duas vezes: a nota não diz de qual é.
    c.milestoneRevisionContract = await accepted(cliBrasilia, freBrasilia, {
      deadlineAt: null,
      milestones: [
        { title: 'Rascunho', amount: 100 },
        { title: 'Ajustes', amount: 50 },
        { title: 'Ajustes', amount: 50 },
      ],
    });
    [revisionMilestoneId, repeatedMilestoneId] = (await milestoneIds(
      c.milestoneRevisionContract,
      cliBrasilia.token,
    )) as [number, number, number];
    for (const id of [revisionMilestoneId, repeatedMilestoneId]) {
      await deliverMilestone(c.milestoneRevisionContract, id, freBrasilia);
      await askMilestoneRevision(c.milestoneRevisionContract, id, cliBrasilia);
      await setColumns('contract_milestones', id, { revision_requested_at: null });
    }
    await setColumns('contract_milestones', revisionMilestoneId, {
      delivered_at: MILESTONE_DELIVERED,
    });
    await restampMilestoneRevisions(c.milestoneRevisionContract, 'Rascunho', [MILESTONE_REVISION]);

    // Volta da 1.40: entrega, revisão (a API nova grava a hora), nova entrega e nova revisão pela
    // 1.40, que não grava a hora. Simulado pelo SQL: a coluna volta à hora do 1º pedido.
    c.revisionReturn = await accepted(cliBrasilia, freBrasilia);
    for (let i = 0; i < 2; i++) {
      await deliver(c.revisionReturn, freBrasilia);
      await askRevision(c.revisionReturn, cliBrasilia);
    }
    await restampDeliveries(c.revisionReturn, RETURN_DELIVERIES);
    await restampRevisions(c.revisionReturn, RETURN_REVISIONS);
    await setColumns('contracts', c.revisionReturn, {
      revision_requested_at: RETURN_REVISIONS[0]!,
    });
    c.milestoneReturnContract = await accepted(cliBrasilia, freBrasilia, {
      deadlineAt: null,
      milestones: MILESTONES,
    });
    returnMilestoneId = await firstMilestone(c.milestoneReturnContract, cliBrasilia.token);
    for (let i = 0; i < 2; i++) {
      await deliverMilestone(c.milestoneReturnContract, returnMilestoneId, freBrasilia);
      await askMilestoneRevision(c.milestoneReturnContract, returnMilestoneId, cliBrasilia);
    }
    await restampMilestoneRevisions(
      c.milestoneReturnContract,
      'Rascunho',
      RETURN_MILESTONE_REVISIONS,
    );
    await setColumns('contract_milestones', returnMilestoneId, {
      delivered_at: RETURN_MILESTONE_DELIVERED,
      revision_requested_at: RETURN_MILESTONE_REVISIONS[0]!,
    });

    t = now();
    first = await runRepairDeadlines(t);
  });

  it('a primeira rodada conta uma linha por caso consertado', () => {
    expect(first).toEqual({
      graceWithoutNotice: 1,
      requestCounters: 8,
      closedExtensions: 2,
      respondBy: 4,
      graceEnds: 2,
      proposalExpiry: 2,
      approvalDue: 1,
      milestoneApprovalDue: 1,
      revisionRequested: 3,
      milestoneRevisionRequested: 3,
    });
  });

  it('1. carência sem aviso (extensão aceita pela API antiga) vira NULL; com o aviso dado, fica', async () => {
    const fixed = await contractRow(c.graceNoNotice);
    expect(fixed).toMatchObject({ status: 'accepted', extension_status: 'accepted' });
    expect(fixed.overdue_notified_at).toBeNull();
    expect(fixed.grace_ends_at).toBeNull();

    const control = await contractRow(c.graceWithNotice);
    expect(iso(control.grace_ends_at)).toBe(controlGraceEnds.toISOString());
    expect(control.overdue_notified_at).not.toBeNull();
  });

  it("2. contador zerado com pedido visível ('declined', 'pending', 'accepted') passa a 1; sem pedido, fica 0", async () => {
    expect(await contractRow(c.declined)).toMatchObject({
      extension_status: 'declined',
      extension_requests: 1,
    });
    expect(await contractRow(c.respondFar)).toMatchObject({
      extension_status: 'pending',
      extension_requests: 1,
    });
    expect(await contractRow(c.graceNoNotice)).toMatchObject({
      extension_status: 'accepted',
      extension_requests: 1,
    });
    expect(await contractRow(c.graceWithNotice)).toMatchObject({
      extension_status: 'none',
      extension_requests: 0,
    });
  });

  it('3. pedido pendente fora da vez de quem entrega é encerrado na hora da rodada', async () => {
    for (const [id, status] of [
      [c.pendingDelivered, 'delivered'],
      [c.pendingCompleted, 'completed'],
    ] as const) {
      const r = await contractRow(id);
      expect(r).toMatchObject({ status, extension_status: 'closed', extension_requests: 1 });
      expect(iso(r.extension_resolved_at)).toBe(t.toISOString());
      // Encerrado antes do passo 4: não ganha hora de resposta.
      expect(r.extension_respond_by).toBeNull();
    }
    // Ainda na vez de quem entrega: o pedido segue pendente.
    expect((await contractRow(c.respondFar)).extension_status).toBe('pending');
  });

  it('4. pedido pendente sem hora de resposta: 48 h de dia, o limite da data pedida no fuso do cliente, ou a hora da rodada', async () => {
    // Data longe: 48 h depois da rodada (meio-dia + 48 h cai de dia em Noronha).
    const far = await contractRow(c.respondFar);
    expect(iso(far.extension_respond_by)).toBe(new Date(t.getTime() + 48 * HOUR).toISOString());
    expect(iso(far.extension_respond_by)).toBe(
      iso(
        extensionRespondBy({
          requestedAt: t,
          proposed: new Date(far.extension_deadline_at!),
          zone: NORONHA,
        }),
      ),
    );

    // Data pedida às 14:00 de Brasília de depois de amanhã: 12 h antes são 03:00 em Noronha, e o
    // último instante de dia antes disso é 20:29:59 de amanhã em Noronha (22:29:59 UTC). Em
    // Brasília seria uma hora depois: o fuso é o do cliente.
    const near = await contractRow(c.respondNear);
    const proposed = new Date(near.extension_deadline_at!);
    expect(iso(near.extension_respond_by)).toBe(fromNoon(31 * HOUR + 29 * MIN + 59_000));
    expect(iso(near.extension_respond_by)).toBe(
      iso(extensionRespondBy({ requestedAt: t, proposed, zone: NORONHA })),
    );
    expect(iso(near.extension_respond_by)).not.toBe(
      iso(extensionRespondBy({ requestedAt: t, proposed, zone: BRASILIA })),
    );
    expect(near.extension_requests).toBe(1);

    // Data pedida passada ou a menos de 18 h: não dá para decidir, expira na próxima rodada.
    for (const id of [c.respondPast, c.respondSoon]) {
      const r = await contractRow(id);
      expect(r).toMatchObject({ extension_status: 'pending', extension_requests: 1 });
      expect(iso(r.extension_respond_by)).toBe(floorSecond(t).toISOString());
    }
  });

  it('5. aviso dado sem fim da carência: aviso + 24 h de dia no fuso do freelancer; revisão fica de fora', async () => {
    // 19:40 em Manaus + 24 h = 19:40 do dia seguinte, ainda de dia lá (em Brasília seriam 20:40,
    // e a carência iria para as 9h de 12/03).
    const manaus = await contractRow(c.noticeManaus);
    expect(iso(manaus.grace_ends_at)).toBe('2026-03-11T23:40:00.000Z');
    expect(iso(manaus.grace_ends_at)).toBe(iso(graceEndFrom(NOTICE_MANAUS, 24, MANAUS)));

    // Aviso às 21:00 de ontem em Noronha: + 24 h cai às 21:00 de hoje, e vai para as 9h de amanhã.
    const inProgress = await contractRow(c.noticeInProgress);
    expect(inProgress.status).toBe('in_progress');
    expect(iso(inProgress.grace_ends_at)).toBe(fromNoon(20 * HOUR));
    expect(iso(inProgress.grace_ends_at)).toBe(
      iso(graceEndFrom(new Date(inProgress.overdue_notified_at!), 24, NORONHA)),
    );

    const revision = await contractRow(c.noticeRevision);
    expect(revision.status).toBe('revision_requested');
    expect(revision.overdue_notified_at).not.toBeNull();
    expect(revision.grace_ends_at).toBeNull();
  });

  it('6. proposta sem validade: criação + 72 h de dia no fuso do freelancer, nunca depois do último instante de dia antes do prazo', async () => {
    // 20:15 de 10/03 em Manaus + 72 h = 20:15 de 13/03, antes das 20:30 (em Brasília seriam 21:15).
    const old = await contractRow(c.proposalOld);
    expect(old.status).toBe('pending');
    expect(iso(old.proposal_expires_at)).toBe('2026-03-14T00:15:00.000Z');
    expect(iso(old.proposal_expires_at)).toBe(
      iso(floorSecond(humanize(new Date(PROPOSAL_CREATED.getTime() + 72 * HOUR), MANAUS))),
    );

    // Prazo às 07:00 de amanhã em Manaus: a proposta vale até 20:29:59 de hoje em Manaus.
    const near = await contractRow(c.proposalNearDeadline);
    expect(iso(near.proposal_expires_at)).toBe(fromNoon(9 * HOUR + 29 * MIN + 59_000));
    expect(iso(near.proposal_expires_at)).toBe(
      iso(floorSecond(lastHumanAtOrBefore(new Date(near.deadline_at!), MANAUS))),
    );
  });

  it('7. entrega única sem hora da aprovação tácita: última entrega do histórico + 5 dias de dia no fuso do cliente', async () => {
    // 20:50 de 10/03 em Brasília + 5 dias = 20:50 de 15/03: vai para as 9h de 16/03 (o cliente
    // está em Brasília; no fuso do freelancer, Manaus, seriam 19:50 e ficaria).
    const r = await contractRow(c.deliveredOld);
    expect(r.status).toBe('delivered');
    expect(iso(r.approval_due_at)).toBe('2026-03-16T12:00:00.000Z');
    expect(iso(r.approval_due_at)).toBe(
      iso(floorSecond(humanize(new Date(LAST_DELIVERY.getTime() + 5 * DAY), BRASILIA))),
    );
  });

  it('8. marco entregue sem hora da aprovação tácita: entrega do marco + 5 dias de dia no fuso do cliente', async () => {
    const m = await milestoneRow(milestoneId);
    expect(m.status).toBe('delivered');
    const deliveredAt = new Date(m.delivered_at!);
    // Entregue às 19:00 em Rio Branco: 5 dias depois ainda é de dia lá, sem mudar a hora.
    expect(iso(m.approval_due_at)).toBe(new Date(deliveredAt.getTime() + 5 * DAY).toISOString());
    expect(iso(m.approval_due_at)).toBe(
      iso(floorSecond(humanize(new Date(deliveredAt.getTime() + 5 * DAY), RIO_BRANCO))),
    );
    // No fuso do freelancer (Brasília) seriam 21:00, e a hora iria para as 9h.
    expect(iso(m.approval_due_at)).not.toBe(
      iso(floorSecond(humanize(new Date(deliveredAt.getTime() + 5 * DAY), BRASILIA))),
    );
  });

  it('10. contratação em revisão sem a hora do pedido: a do último pedido no histórico (depois da última entrega), ou a da rodada sem histórico; a gravada pela API fica', async () => {
    const old = await contractRow(c.revisionOld);
    expect(old.status).toBe('revision_requested');
    // O último pedido veio depois da última entrega: é ele, e não a entrega, que vale.
    expect(iso(old.revision_requested_at)).toBe(LAST_REVISION.toISOString());

    const noHistory = await contractRow(c.revisionNoHistory);
    expect(noHistory.status).toBe('revision_requested');
    expect(iso(noHistory.revision_requested_at)).toBe(t.toISOString());

    const control = await contractRow(c.noticeRevision);
    expect(iso(control.revision_requested_at)).toBe(apiRevisionAt.toISOString());
  });

  it('11. marco em revisão sem a hora do pedido: a da nota da linha do tempo se o título é único na contratação; com título repetido, a hora da rodada', async () => {
    const unique = await milestoneRow(revisionMilestoneId);
    expect(unique.status).toBe('funded');
    expect(iso(unique.delivered_at)).toBe(MILESTONE_DELIVERED.toISOString());
    expect(iso(unique.revision_requested_at)).toBe(MILESTONE_REVISION.toISOString());

    // Os dois «Ajustes» têm o mesmo título: a nota não diz de qual marco é.
    const repeated = await milestoneRow(repeatedMilestoneId);
    expect(repeated.status).toBe('funded');
    expect(repeated.delivered_at).not.toBeNull();
    expect(iso(repeated.revision_requested_at)).toBe(t.toISOString());
    const [notes] = await pool.query<RowDataPacket[]>(
      `SELECT note FROM contract_status_history
        WHERE contract_id = :id AND note LIKE 'Revisão pedida no marco%' ORDER BY id`,
      { id: c.milestoneRevisionContract },
    );
    expect(notes.map((n) => n.note)).toEqual([
      'Revisão pedida no marco «Rascunho»: Trocar a fonte do rascunho',
      'Revisão pedida no marco «Ajustes»: Trocar a fonte do rascunho',
    ]);

    // O marco entregue do caso 8 não está em revisão: fica sem a hora.
    expect((await milestoneRow(milestoneId)).revision_requested_at).toBeNull();
  });

  it('volta da 1.40: revisão pedida de novo sem gravar a hora (ficou a do ciclo anterior, antes da última entrega) recebe a do último pedido, na contratação e no marco', async () => {
    // A hora gravada (a do 1º pedido) era anterior à última entrega: o reparo a troca pela do 2º.
    const contract = await contractRow(c.revisionReturn);
    expect(contract.status).toBe('revision_requested');
    expect(iso(contract.revision_requested_at)).toBe(RETURN_REVISIONS[1]!.toISOString());

    const m = await milestoneRow(returnMilestoneId);
    expect(m.status).toBe('funded');
    expect(iso(m.delivered_at)).toBe(RETURN_MILESTONE_DELIVERED.toISOString());
    expect(iso(m.revision_requested_at)).toBe(RETURN_MILESTONE_REVISIONS[1]!.toISOString());
    // A segunda rodada (caso 12) não muda nada: a hora já não é anterior à última entrega.
  });

  it('12. rodar de novo não muda nada (nem as horas consertadas da volta da 1.40)', async () => {
    const ids = Object.values(c);
    const milestoneIdsToCheck = [
      milestoneId,
      revisionMilestoneId,
      repeatedMilestoneId,
      returnMilestoneId,
    ];
    const snapshot = async () => {
      const [contracts] = await pool.query<ContractCols[]>(
        `SELECT ${COLS} FROM contracts WHERE id IN (:ids) ORDER BY id`,
        { ids },
      );
      return {
        contracts,
        milestones: await Promise.all(milestoneIdsToCheck.map((id) => milestoneRow(id))),
      };
    };
    const before = await snapshot();
    expect(before.contracts).toHaveLength(ids.length);
    expect(
      iso(before.contracts.find((r) => r.id === c.revisionReturn)?.revision_requested_at),
    ).toBe(RETURN_REVISIONS[1]!.toISOString());

    const again = await runRepairDeadlines(now());
    expect(again).toEqual({
      graceWithoutNotice: 0,
      requestCounters: 0,
      closedExtensions: 0,
      respondBy: 0,
      graceEnds: 0,
      proposalExpiry: 0,
      approvalDue: 0,
      milestoneApprovalDue: 0,
      revisionRequested: 0,
      milestoneRevisionRequested: 0,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('13. depois do reparo, a sanção sai na rodada seguinte dos jobs, na hora reparada', async () => {
    // Fase 0: os pedidos com a hora da rodada expiram; os de resposta futura seguem.
    // Fase 2: a carência reparada (março) venceu, e a plataforma abre a disputa.
    const overdue = await runOverdueContracts(now());
    expect(overdue.failed).toEqual([]);
    expect(overdue.expired).toEqual(expect.arrayContaining([c.respondPast, c.respondSoon]));
    expect(overdue.expired).not.toContain(c.respondFar);
    expect(overdue.expired).not.toContain(c.respondNear);
    expect(overdue.disputed).toContain(c.noticeManaus);
    expect(overdue.disputed).not.toContain(c.noticeInProgress);
    expect(overdue.disputed).not.toContain(c.graceWithNotice);

    for (const id of [c.respondPast, c.respondSoon]) {
      expect((await contractRow(id)).extension_status).toBe('expired');
    }
    expect((await contractRow(c.respondFar)).extension_status).toBe('pending');
    expect((await contractRow(c.noticeManaus)).status).toBe('disputed');
    const [disputes] = await pool.query<RowDataPacket[]>(
      'SELECT reason FROM disputes WHERE contract_id = :id',
      { id: c.noticeManaus },
    );
    expect(disputes.map((d) => d.reason)).toEqual(['deadline']);
    expect((await contractRow(c.noticeInProgress)).status).toBe('in_progress');

    // Aprovação tácita na hora reparada: a entrega única e o marco.
    const tacit = await runTacitApproval(now());
    expect(tacit.failed).toEqual([]);
    expect(tacit.approved).toContain(c.deliveredOld);
    expect(tacit.approved).not.toContain(c.pendingDelivered);
    expect(tacit.milestones).toContain(milestoneId);
    expect((await contractRow(c.deliveredOld)).status).toBe('completed');
    expect((await milestoneRow(milestoneId)).status).toBe('released');

    // Proposta com a validade reparada em março expira; a do prazo de amanhã ainda não.
    const proposals = await runExpireProposals(now());
    expect(proposals.failed).toEqual([]);
    expect(proposals.expired).toContain(c.proposalOld);
    expect(proposals.expired).not.toContain(c.proposalNearDeadline);
    expect((await contractRow(c.proposalOld)).status).toBe('cancelled');
    expect((await contractRow(c.proposalNearDeadline)).status).toBe('pending');
  });
});
