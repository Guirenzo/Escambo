import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminUsageReport } from '@escambo/types';
import mysql, { type Connection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runExpireProposals } from '../../src/jobs/expire-proposals';
import { runOverdueContracts } from '../../src/jobs/overdue-contracts';
import { runTacitApproval } from '../../src/jobs/tacit-approval';
import { DAY, fromNow, HOUR, isoFromNow, now, startDaytimeClock, stopClock } from './clock.helpers';
import { fundWallet } from './wallet.helpers';
import { confirmEmail } from './mail.helpers';

/**
 * Origem de cada mudança de status (coluna contract_status_history.source, migration 0048, ADR 63)
 * contra o MySQL real. A plataforma grava mudanças em nome do cliente (aprovação tácita de entrega e
 * de marco, proposta expirada, disputa aberta por prazo); elas saem com source = 'system', e o que a
 * pessoa faz (proposta, aceite, entrega, aprovação, cancelamento) com 'user'. O relatório de uso
 * (RF-081) conta como ativo só quem tem linha 'user', sem olhar o texto da nota. Por fim, a 0048:
 * o backfill das linhas antigas pelo texto que o relatório usava, a migration rodando de novo sem
 * reclassificar nada e retomando depois de uma queda no meio.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const MIGRATION = readFileSync(
  join(__dirname, '../../db/migrations/0048_origem_historico_status.sql'),
  'utf8',
);

/** Quarta 13/03/2024 em Brasília (das 03:00 UTC do dia 13 às 03:00 do dia 14): nenhum outro arquivo usa. */
const REPORT_DAY = '2024-03-13';
const REPORT_NOON = new Date('2024-03-13T15:00:00Z');

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
  domain = 'escambo.test',
): Promise<Actor> {
  const email = `int_origem_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  await confirmEmail(app, login.body.user.id);
  return { id: login.body.user.id as number, token: login.body.accessToken as string };
}

/** Cliente com saldo e freelancer novos: cada fluxo tem a sua dupla (RN-020). */
async function pair(): Promise<{ client: Actor; freelancer: Actor }> {
  const client = await registerAndLogin('client');
  const freelancer = await registerAndLogin('freelancer');
  await fundWallet(app, client.token, 300);
  return { client, freelancer };
}

async function propose(
  client: Actor,
  freelancer: Actor,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: 'Identidade visual',
      description: 'Logo, paleta e manual de marca da loja',
      price: 200,
      ...extra,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

async function act(path: string, who: Actor, body: Record<string, unknown> = {}): Promise<void> {
  const res = await request(app).post(path).set(auth(who.token)).send(body);
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
}

/** Proposta aceita e entregue (entrega única). */
async function delivered(client: Actor, freelancer: Actor): Promise<number> {
  const id = await propose(client, freelancer);
  await act(`/api/contracts/${id}/accept`, freelancer);
  await act(`/api/contracts/${id}/deliver`, freelancer, { message: 'Arquivos finais no chat.' });
  return id;
}

interface Line {
  id: number;
  by: number;
  from: string | null;
  to: string;
  note: string | null;
  source: string;
}

async function historyOf(contractId: number): Promise<Line[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, changed_by, old_status, new_status, note, source
       FROM contract_status_history WHERE contract_id = :contractId ORDER BY id`,
    { contractId },
  );
  return rows.map((r) => ({
    id: Number(r.id),
    by: Number(r.changed_by),
    from: r.old_status as string | null,
    to: r.new_status as string,
    note: r.note as string | null,
    source: r.source as string,
  }));
}

const brief = (lines: Line[]) => lines.map((l) => [l.by, l.from, l.to, l.source]);

/** As linhas que o relatório vai ler no dia do teste, com o autor e a origem de cada uma. */
const forReport: { line: Line; label: string }[] = [];

beforeAll(async () => {
  expect(process.env.DB_NAME).toMatch(/_test$/);
  startDaytimeClock();
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('cada caminho declara a origem da mudança de status', () => {
  it('aprovação manual: proposta, aceite, entrega e aprovação são ações da pessoa', async () => {
    const { client, freelancer } = await pair();
    const id = await delivered(client, freelancer);
    await act(`/api/contracts/${id}/approve`, client);

    const lines = await historyOf(id);
    expect(brief(lines)).toEqual([
      [client.id, null, 'pending', 'user'],
      [freelancer.id, 'pending', 'accepted', 'user'],
      [freelancer.id, 'accepted', 'delivered', 'user'],
      [client.id, 'delivered', 'completed', 'user'],
    ]);
    forReport.push({ line: lines.at(-1)!, label: 'aprovação manual' });
  });

  it('aprovação tácita da entrega (job): em nome do cliente, feita pela plataforma', async () => {
    const { client, freelancer } = await pair();
    const id = await delivered(client, freelancer);
    await pool.query('UPDATE contracts SET approval_due_at = :due WHERE id = :id', {
      id,
      due: fromNow(-HOUR),
    });

    expect((await runTacitApproval(now())).approved).toContain(id);

    const lines = await historyOf(id);
    expect(brief(lines)).toEqual([
      [client.id, null, 'pending', 'user'],
      [freelancer.id, 'pending', 'accepted', 'user'],
      [freelancer.id, 'accepted', 'delivered', 'user'],
      [client.id, 'delivered', 'completed', 'system'],
    ]);
    expect(lines.at(-1)!.note).toMatch(/^Aprovação tácita/);
    forReport.push({ line: lines.at(-1)!, label: 'tácita da entrega' });
  });

  it('aprovação tácita do marco (job): a entrega do marco é da pessoa, a aprovação é da plataforma', async () => {
    const { client, freelancer } = await pair();
    const id = await propose(client, freelancer, {
      milestones: [
        { title: 'Rascunho', amount: 100 },
        { title: 'Arte final', amount: 100 },
      ],
    });
    await act(`/api/contracts/${id}/accept`, freelancer);
    const shown = await request(app).get(`/api/contracts/${id}`).set(auth(client.token));
    const [m1] = (shown.body.milestones as { id: number }[]).map((m) => m.id);
    await act(`/api/contracts/${id}/milestones/${m1}/deliver`, freelancer, {
      message: 'Rascunho no chat.',
    });
    await pool.query('UPDATE contract_milestones SET approval_due_at = :due WHERE id = :id', {
      id: m1,
      due: fromNow(-HOUR),
    });

    expect((await runTacitApproval(now())).milestones).toContain(m1);

    const lines = await historyOf(id);
    expect(brief(lines)).toEqual([
      [client.id, null, 'pending', 'user'],
      [freelancer.id, 'pending', 'accepted', 'user'],
      [freelancer.id, 'accepted', 'in_progress', 'user'],
      [client.id, 'in_progress', 'in_progress', 'system'],
    ]);
    expect(lines.at(-1)!.note).toMatch(/^Aprovação tácita: .* · Marco «Rascunho» aprovado/);
    forReport.push({ line: lines.at(-1)!, label: 'tácita do marco' });
  });

  it('proposta expirada (job): a reserva volta ao cliente e a linha é da plataforma', async () => {
    const { client, freelancer } = await pair();
    const id = await propose(client, freelancer);
    await pool.query('UPDATE contracts SET proposal_expires_at = :at WHERE id = :id', {
      id,
      at: fromNow(-HOUR),
    });

    expect((await runExpireProposals(now())).expired).toContain(id);

    const lines = await historyOf(id);
    expect(brief(lines)).toEqual([
      [client.id, null, 'pending', 'user'],
      [client.id, 'pending', 'cancelled', 'system'],
    ]);
    expect(lines.at(-1)!.note).toContain('expirada: sem resposta');
    forReport.push({ line: lines.at(-1)!, label: 'proposta expirada' });
  });

  it('disputa aberta por prazo (job): em nome do cliente, feita pela plataforma', async () => {
    const { client, freelancer } = await pair();
    const id = await propose(client, freelancer, { deadlineAt: isoFromNow(5 * DAY) });
    await act(`/api/contracts/${id}/accept`, freelancer);
    // Prazo vencido sem entrega, aviso dado e carência terminada (RN-029, fase 2).
    await pool.query(
      `UPDATE contracts SET deadline_at = :deadline, overdue_notified_at = :notice,
              grace_ends_at = :grace WHERE id = :id`,
      { id, deadline: fromNow(-30 * HOUR), notice: fromNow(-25 * HOUR), grace: fromNow(-HOUR) },
    );

    expect((await runOverdueContracts(now())).disputed).toContain(id);

    const lines = await historyOf(id);
    expect(brief(lines)).toEqual([
      [client.id, null, 'pending', 'user'],
      [freelancer.id, 'pending', 'accepted', 'user'],
      [client.id, 'accepted', 'disputed', 'system'],
    ]);
    forReport.push({ line: lines.at(-1)!, label: 'disputa por prazo' });
  });

  it('cancelamento pelo cliente antes do aceite: ação da pessoa', async () => {
    const { client, freelancer } = await pair();
    const id = await propose(client, freelancer);
    await act(`/api/contracts/${id}/cancel`, client);

    const lines = await historyOf(id);
    expect(brief(lines)).toEqual([
      [client.id, null, 'pending', 'user'],
      [client.id, 'pending', 'cancelled', 'user'],
    ]);
    forReport.push({ line: lines.at(-1)!, label: 'cancelamento' });
  });
});

describe('RF-081: o relatório de uso conta só as mudanças feitas pela pessoa', () => {
  const usage = async (admin: Actor): Promise<AdminUsageReport> => {
    const res = await request(app)
      .get(`/api/admin/usage?from=${REPORT_DAY}&to=${REPORT_DAY}&granularity=day`)
      .set(auth(admin.token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as AdminUsageReport;
  };
  /** Leva as linhas para o dia do relatório (as sessões e mensagens dessas pessoas ficam hoje). */
  const moveToReportDay = async (ids: number[]): Promise<void> => {
    await pool.query('UPDATE contract_status_history SET created_at = :at WHERE id IN (:ids)', {
      at: REPORT_NOON,
      ids,
    });
  };

  it('as linhas da plataforma não fazem ninguém ativo; as da pessoa, sim', async () => {
    expect(forReport.map((r) => r.label)).toEqual([
      'aprovação manual',
      'tácita da entrega',
      'tácita do marco',
      'proposta expirada',
      'disputa por prazo',
      'cancelamento',
    ]);
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    expect((await usage(admin)).totals.activeUsers).toBe(0);

    // Só as quatro mudanças da plataforma no dia: todas em nome de clientes, nenhuma é uso.
    const system = forReport.filter((r) => r.line.source === 'system');
    expect(system.map((r) => r.label)).toEqual([
      'tácita da entrega',
      'tácita do marco',
      'proposta expirada',
      'disputa por prazo',
    ]);
    await moveToReportDay(system.map((r) => r.line.id));
    let r = await usage(admin);
    expect(r.series).toEqual([expect.objectContaining({ bucket: REPORT_DAY, activeUsers: 0 })]);
    expect(r.totals.activeUsers).toBe(0);

    // A aprovação manual e o cancelamento, feitos pelos clientes: dois ativos.
    const person = forReport.filter((x) => x.line.source === 'user');
    expect(person.map((x) => x.label)).toEqual(['aprovação manual', 'cancelamento']);
    await moveToReportDay(person.map((x) => x.line.id));
    r = await usage(admin);
    expect(r.series[0]).toMatchObject({ bucket: REPORT_DAY, source: 'live', activeUsers: 2 });
    expect(r.totals.activeUsers).toBe(2);
  });

  it('o texto da nota não decide mais: vale a origem gravada', async () => {
    const admin = await registerAndLogin('client', 'admin.escambo.test');
    const before = (await usage(admin)).totals.activeUsers;
    const [actsWithTacitText, platformPlain, freelancer] = [
      await registerAndLogin('client'),
      await registerAndLogin('client'),
      await registerAndLogin('freelancer'),
    ];
    for (const [who, note, source] of [
      // A pessoa escreveu algo que parece a nota da tácita: continua sendo ação dela.
      [actsWithTacitText, 'Aprovação tácita: era o que a nota antiga reconhecia', 'user'],
      // A plataforma agiu com uma nota qualquer: continua não sendo uso.
      [platformPlain, 'Mudança feita pela plataforma', 'system'],
    ] as const) {
      const [c] = await pool.query<ResultSetHeader>(
        `INSERT INTO contracts (ulid, client_id, freelancer_id, title, description, price,
           platform_fee, freelancer_net, payment_mode, status)
         VALUES (:key, :clientId, :freelancerId, 'Origem no relatório', 'Contrato da integração',
           100, 15, 85, 'cash', 'in_progress')`,
        { key: ulid(), clientId: who.id, freelancerId: freelancer.id },
      );
      await pool.query(
        `INSERT INTO contract_status_history
           (contract_id, changed_by, old_status, new_status, note, source, created_at)
         VALUES (:contractId, :by, 'accepted', 'in_progress', :note, :source, :at)`,
        { contractId: c.insertId, by: who.id, note, source, at: REPORT_NOON },
      );
    }

    expect((await usage(admin)).totals.activeUsers).toBe(before + 1);
  });
});

describe('migration 0048: a origem das linhas antigas e a migration rodando de novo', () => {
  let conn: Connection;
  let n = 0;

  beforeAll(async () => {
    expect(MIGRATION).not.toMatch(/\bUSE\s+\w+\s*;/i);
    conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      multipleStatements: true,
      namedPlaceholders: true,
    });
  });

  afterAll(async () => {
    // Seja qual for o resultado, o banco da suíte fica com a coluna como a 0048 deixa.
    await conn.query(MIGRATION);
    await conn.end();
  });

  async function column(): Promise<RowDataPacket | undefined> {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'contract_status_history'
          AND column_name = 'source'`,
    );
    return rows[0];
  }

  async function user(role: 'client' | 'freelancer'): Promise<number> {
    const [res] = await conn.query<ResultSetHeader>(
      `INSERT INTO users (ulid, email, password_hash, role, status, email_verified_at)
       VALUES (:key, :email, 'x', :role, 'active', NOW())`,
      { key: ulid(), email: `int_origem_mig_${Date.now()}_${n++}@escambo.test`, role },
    );
    return res.insertId;
  }

  async function contract(clientId: number, freelancerId: number, status: string): Promise<number> {
    const [res] = await conn.query<ResultSetHeader>(
      `INSERT INTO contracts (ulid, client_id, freelancer_id, title, description, price,
         platform_fee, freelancer_net, payment_mode, status)
       VALUES (:key, :clientId, :freelancerId, 'Contrato legado', 'Linha antiga do histórico',
         100, 15, 85, 'cash', :status)`,
      { key: ulid(), clientId, freelancerId, status },
    );
    return res.insertId;
  }

  /** Grava como a API antiga gravava: sem a coluna source. */
  async function legacy(
    contractId: number,
    by: number,
    from: string | null,
    to: string,
    note: string | null,
  ): Promise<number> {
    const [res] = await conn.query<ResultSetHeader>(
      `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
       VALUES (:contractId, :by, :from, :to, :note)`,
      { contractId, by, from, to, note },
    );
    return res.insertId;
  }

  async function sources(ids: number[]): Promise<Record<number, string | null>> {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT id, source FROM contract_status_history WHERE id IN (:ids)',
      { ids },
    );
    return Object.fromEntries(rows.map((r) => [Number(r.id), r.source as string | null]));
  }

  const expected: { id: number; source: 'user' | 'system'; why: string }[] = [];

  it('contract_status_history não tem trigger: o UPDATE do backfill passa (a 0046 não a tranca)', async () => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT trigger_name FROM information_schema.triggers
        WHERE event_object_schema = DATABASE() AND event_object_table = 'contract_status_history'`,
    );
    expect(rows).toEqual([]);
  });

  it('linhas antigas: as notas que a plataforma gravava viram system, o resto fica user', async () => {
    // O banco como ficava antes da 0048.
    if (await column()) await conn.query('ALTER TABLE contract_status_history DROP COLUMN source');
    expect(await column()).toBeUndefined();

    const client = await user('client');
    const freelancer = await user('freelancer');
    const plain = await contract(client, freelancer, 'completed');
    const auto = await contract(client, freelancer, 'disputed');
    const manual = await contract(client, freelancer, 'disputed');
    await conn.query(
      `INSERT INTO disputes (ulid, contract_id, opened_by, reason, description)
       VALUES (:a, :auto, :client, 'deadline', :autoText), (:m, :manual, :client, 'quality', :manualText)`,
      {
        a: ulid(),
        m: ulid(),
        auto,
        manual,
        client,
        autoText: 'Aberta automaticamente pela plataforma (RN-029): o prazo venceu sem entrega.',
        manualText: 'A entrega veio incompleta',
      },
    );

    const add = async (
      source: 'user' | 'system',
      why: string,
      ...line: Parameters<typeof legacy>
    ): Promise<void> => {
      expected.push({ id: await legacy(...line), source, why });
    };
    await add('user', 'proposta', plain, client, null, 'pending', 'Proposta enviada');
    await add('user', 'aceite', plain, freelancer, 'pending', 'accepted', null);
    await add('user', 'entrega', plain, freelancer, 'accepted', 'delivered', null);
    // As tácitas, nas duas redações que já existiram, e a do marco.
    await add(
      'system',
      'tácita (até a 1.3)',
      plain,
      client,
      'delivered',
      'completed',
      'Aprovação tácita: sem resposta do cliente em 5 dias',
    );
    await add(
      'system',
      'tácita',
      plain,
      client,
      'delivered',
      'completed',
      'Aprovação tácita: sem resposta do cliente até 06/10/2026 às 11:00 (horário de Brasília, RN-024)',
    );
    await add(
      'system',
      'tácita do marco',
      plain,
      client,
      'in_progress',
      'in_progress',
      'Aprovação tácita: sem resposta do cliente até 06/10/2026 às 18:20 (horário de Brasília) · Marco «Layout» aprovado: R$ 283,33 liberados',
    );
    // As expirações, da proposta e de uma oferta da negociação, nas duas redações.
    await add(
      'system',
      'proposta expirada (até a 1.3)',
      plain,
      client,
      'pending',
      'cancelled',
      'Proposta expirada: sem resposta do freelancer em 72h (RN-021)',
    );
    await add(
      'system',
      'oferta expirada',
      plain,
      client,
      'pending',
      'cancelled',
      'Oferta 2 expirada: sem resposta do cliente até 06/10/2026 às 11:00 (horário de Brasília, RN-030)',
    );
    // A 0002 encerrou propostas em nome do cliente.
    await add(
      'system',
      'encerrada pela 0002',
      plain,
      client,
      'pending',
      'cancelled',
      'Encerrada na migração para a carteira pré-paga (proposta sem valor reservado)',
    );
    // A disputa: aberta pela plataforma (descrição "Aberta automaticamente") ou pela parte.
    await add(
      'system',
      'disputa por prazo',
      auto,
      client,
      'accepted',
      'disputed',
      'Disputa aberta',
    );
    await add(
      'user',
      'disputa da parte',
      manual,
      client,
      'delivered',
      'disputed',
      'Disputa aberta',
    );
    await add(
      'user',
      'decisão do admin',
      manual,
      client,
      'disputed',
      'cancelled',
      'Disputa resolvida: refund_client',
    );

    await conn.query(MIGRATION);

    const got = await sources(expected.map((e) => e.id));
    expect(expected.map((e) => [e.why, got[e.id]])).toEqual(expected.map((e) => [e.why, e.source]));
    // Nenhuma linha ficou sem origem, e a coluna é a definitiva.
    const [nulls] = await conn.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM contract_status_history WHERE source IS NULL',
    );
    expect(Number(nulls[0]!.n)).toBe(0);
    expect(await column()).toMatchObject({
      type: "enum('user','system')",
      nullable: 'NO',
      def: 'user',
    });
  });

  it('roda de novo sem erro e sem reclassificar nada; INSERT sem origem é da pessoa', async () => {
    const before = await sources(expected.map((e) => e.id));

    // Uma linha nova, gravada sem dizer a origem (à mão), com texto que parece o da tácita.
    const [c] = await conn.query<RowDataPacket[]>(
      'SELECT contract_id FROM contract_status_history WHERE id = :id',
      { id: expected[0]!.id },
    );
    const [row] = await conn.query<ResultSetHeader>(
      `INSERT INTO contract_status_history (contract_id, changed_by, old_status, new_status, note)
       SELECT :contractId, changed_by, 'completed', 'completed',
              'Aprovação tácita: texto digitado depois da 0048'
         FROM contract_status_history WHERE id = :id`,
      { contractId: Number(c[0]!.contract_id), id: expected[0]!.id },
    );
    expect(await sources([row.insertId])).toEqual({ [row.insertId]: 'user' });

    await conn.query(MIGRATION);
    await conn.query(MIGRATION);

    expect(await sources(expected.map((e) => e.id))).toEqual(before);
    // O texto não reclassifica mais nada: a linha nova continua da pessoa.
    expect(await sources([row.insertId])).toEqual({ [row.insertId]: 'user' });
    expect(await column()).toMatchObject({ nullable: 'NO', def: 'user' });
  });

  it('retoma depois de cair entre o ADD e o NOT NULL: classifica o que ficou sem origem e termina', async () => {
    const tacit = expected.find((e) => e.why === 'tácita')!;
    const offer = expected.find((e) => e.why === 'oferta expirada')!;
    const proposal = expected.find((e) => e.why === 'proposta')!;
    // O estado de uma execução que caiu no meio: coluna ainda NULL e linhas sem origem.
    await conn.query(
      "ALTER TABLE contract_status_history MODIFY COLUMN source ENUM('user', 'system') NULL",
    );
    await conn.query('UPDATE contract_status_history SET source = NULL WHERE id IN (:ids)', {
      ids: [tacit.id, offer.id, proposal.id],
    });
    expect(await column()).toMatchObject({ nullable: 'YES' });

    await conn.query(MIGRATION);

    expect(await sources([tacit.id, offer.id, proposal.id])).toEqual({
      [tacit.id]: 'system',
      [offer.id]: 'system',
      [proposal.id]: 'user',
    });
    expect(await column()).toMatchObject({ nullable: 'NO', def: 'user' });
  });
});
