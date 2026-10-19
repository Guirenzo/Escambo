import { createHash } from 'node:crypto';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appliedMigrations,
  ensureMigrationsTable,
  loadMigrations,
  migrate,
  seedReferenceIfEmpty,
} from '../../src/scripts/migrate-core';

/**
 * Runner no banco vazio e no upgrade com dados até 0030: ordem, idempotência,
 * preservação do legado e das configurações do admin, e restrições reais do MySQL.
 */

const cfg = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? 'escambo_root',
};
// Banco próprio, derivado do banco da suíte: duas suítes com TEST_DB_NAME diferentes podem rodar
// ao mesmo tempo na mesma máquina sem uma derrubar o banco da outra.
const DB = `${process.env.DB_NAME ?? 'escambo_test'}_migtest`;

/** Prazos de dia (ADR 57): as duas migrations e o que cada uma cria. */
const DEADLINE_MIGRATIONS = ['0027_prazos_contratos', '0028_prazos_marcos'];
/** Lembretes antes de cada vencimento (ADR 58). */
const REMINDER_MIGRATIONS = ['0029_lembretes_prazos', '0030_lembretes_marcos'];
const RULE_MIGRATIONS = [
  '0031_negociacao_revisoes_desistencias',
  '0032_revisoes_marcos',
  '0033_lembrete_contraproposta',
  '0034_suporte_sla',
];

/**
 * As migrations esperadas, em ordem, seguidas só de posteriores a elas: uma migration nova (de
 * outra frente) entra no upgrade sem quebrar o que estes testes conferem.
 */
function expectAppliedFrom(applied: string[], expected: string[]): void {
  expect(applied.slice(0, expected.length)).toEqual(expected);
  const last = expected[expected.length - 1]!;
  expect(applied.slice(expected.length).filter((name) => name <= last)).toEqual([]);
}

let conn: Connection;

async function dropDb(database = DB): Promise<void> {
  const admin = await mysql.createConnection(cfg);
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.end();
}

/** Fixture válida também no schema anterior à ADR 61, sem depender da API atual. */
async function createLegacyFixture(database: Connection): Promise<void> {
  await database.query(
    `INSERT INTO users (id, ulid, email, role, status) VALUES
       (61, 'migration-client', 'migration-client@test.invalid', 'client', 'active'),
       (62, 'migration-freelancer', 'migration-freelancer@test.invalid', 'freelancer', 'active'),
       (63, 'migration-admin', 'migration-admin@test.invalid', 'admin', 'active')`,
  );
  await database.query(
    `INSERT INTO contracts
       (id, ulid, client_id, freelancer_id, title, description, price, platform_fee,
        freelancer_net, status, deadline_at, accepted_at, approval_due_at, revision_requested_at)
     VALUES (101, 'migration-contract', 61, 62, 'Contrato legado', 'Não perder estes termos',
             10.01, 1.50, 8.51, 'revision_requested', '2026-10-08 15:00:00',
             '2026-10-01 12:00:00', '2026-10-12 15:00:00', '2026-10-05 12:00:00')`,
  );
  await database.query(
    `INSERT INTO contract_milestones
       (id, contract_id, title, amount, freelancer_net, status, due_at, delivered_at,
        approval_due_at, revision_requested_at)
     VALUES (201, 101, 'Marco legado', 10.01, 8.51, 'funded', '2026-10-08 15:00:00',
             '2026-10-04 12:00:00', '2026-10-12 15:00:00', '2026-10-05 12:00:00')`,
  );
}

beforeAll(async () => {
  await dropDb();
  const admin = await mysql.createConnection(cfg);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();
  conn = await mysql.createConnection({ ...cfg, database: DB, multipleStatements: true });
});

afterAll(async () => {
  await conn.end();
  await dropDb();
});

describe('runner de migrations', () => {
  // Baseline + 34 migrations num banco vazio: com o MySQL dividido entre suítes, passa dos 30 s do
  // padrão, e o teste seguinte rodaria o runner por cima deste, ainda em andamento.
  it('aplica o baseline num banco vazio e registra em schema_migrations', async () => {
    const result = await migrate(conn);

    expect(result.applied).toContain('0000_baseline');
    expect(result.applied).toEqual(expect.arrayContaining(DEADLINE_MIGRATIONS));
    expect(result.applied).toEqual(expect.arrayContaining(REMINDER_MIGRATIONS));
    expect(result.applied).toEqual(expect.arrayContaining(RULE_MIGRATIONS));
    // Em ordem: a 0030 depois da 0029, as duas depois da 0028.
    const at = (name: string): number => result.applied.indexOf(name);
    expect(at('0028_prazos_marcos')).toBeLessThan(at('0029_lembretes_prazos'));
    expect(at('0029_lembretes_prazos')).toBeLessThan(at('0030_lembretes_marcos'));
    expect(at('0030_lembretes_marcos')).toBeLessThan(at(RULE_MIGRATIONS[0]!));
    expect(at(RULE_MIGRATIONS[0]!)).toBeLessThan(at(RULE_MIGRATIONS[1]!));
    expect(at(RULE_MIGRATIONS[1]!)).toBeLessThan(at(RULE_MIGRATIONS[2]!));

    const [tables] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = ? AND table_name = 'users'`,
      [DB],
    );
    expect(tables[0]!.n).toBe(1);

    const done = await appliedMigrations(conn);
    expect(done.has('0000_baseline')).toBe(true);
  }, 120_000);

  it('é idempotente: rodar de novo não reaplica nada', async () => {
    const result = await migrate(conn);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain('0000_baseline');
    expect(result.skipped).toEqual(expect.arrayContaining(DEADLINE_MIGRATIONS));
    expect(result.skipped).toEqual(expect.arrayContaining(REMINDER_MIGRATIONS));
    expect(result.skipped).toEqual(expect.arrayContaining(RULE_MIGRATIONS));
  });

  it('0027 e 0028 (prazos de dia, ADR 57): pedido com "closed" no ENUM e as colunas novas', async () => {
    const done = await appliedMigrations(conn);
    for (const name of DEADLINE_MIGRATIONS) expect(done.has(name), name).toBe(true);

    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT table_name AS tbl, column_name AS col, column_type AS type,
              is_nullable AS nullable, column_default AS def
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name IN ('contracts', 'contract_milestones')`,
      [DB],
    );
    const column = (tbl: string, col: string) =>
      rows.find((r) => r.tbl === tbl && r.col === col) as
        { type: string; nullable: string; def: string | null } | undefined;

    // Membros novos no fim do ENUM: os antigos mantêm a posição.
    expect(column('contracts', 'extension_status')).toMatchObject({
      type: "enum('none','pending','accepted','declined','expired','closed')",
      nullable: 'NO',
      def: 'none',
    });
    // Contador de pedidos (RN-028): zero nas linhas antigas; o reparo acerta o que precisa.
    expect(column('contracts', 'extension_requests')).toMatchObject({ nullable: 'NO', def: '0' });
    expect(column('contracts', 'extension_requests')?.type).toMatch(/^tinyint(\(\d+\))? unsigned$/);
    // Instantes gravados: nulos nas linhas antigas, preenchidos pelo reparo.
    for (const [tbl, col] of [
      ['contracts', 'extension_respond_by'],
      ['contracts', 'grace_ends_at'],
      ['contracts', 'approval_due_at'],
      ['contracts', 'proposal_expires_at'],
      ['contract_milestones', 'approval_due_at'],
    ] as const) {
      expect(column(tbl, col), `${tbl}.${col}`).toMatchObject({
        type: 'datetime',
        nullable: 'YES',
        def: null,
      });
    }

    // Os índices que os jobs usam para achar o que venceu.
    const [indexes] = await conn.query<RowDataPacket[]>(
      `SELECT DISTINCT table_name AS tbl, index_name AS idx
         FROM information_schema.statistics
        WHERE table_schema = ? AND table_name IN ('contracts', 'contract_milestones')`,
      [DB],
    );
    const names = indexes.map((r) => `${r.tbl}.${r.idx}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'contracts.idx_contract_status_grace',
        'contracts.idx_contract_status_approval',
        'contracts.idx_contract_status_proposal',
        'contracts.idx_contract_extension_respond',
        'contract_milestones.idx_milestone_status_approval',
      ]),
    );
  });

  it('0029 e 0030 (lembretes, ADR 58): o livro deadline_reminders com UNIQUE de 4 colunas e a hora do pedido de revisão', async () => {
    const done = await appliedMigrations(conn);
    for (const name of REMINDER_MIGRATIONS) expect(done.has(name), name).toBe(true);

    const [cols] = await conn.query<RowDataPacket[]>(
      `SELECT column_name AS col, column_type AS type, is_nullable AS nullable,
              column_default AS def, extra AS extra
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = 'deadline_reminders'
        ORDER BY ordinal_position`,
      [DB],
    );
    // Sem user_id e sem dado pessoal: quem foi avisado está em notifications.
    expect(cols.map((r) => r.col)).toEqual(['id', 'kind', 'entity_id', 'due_at', 'seq', 'sent_at']);
    const col = (name: string) => cols.find((r) => r.col === name);
    expect(col('id')).toMatchObject({
      type: 'bigint unsigned',
      nullable: 'NO',
      extra: 'auto_increment',
    });
    expect(col('kind')).toMatchObject({
      type: "enum('proposal','delivery','approval','milestone_approval','extension','revision','milestone_revision','counter_offer')",
      nullable: 'NO',
    });
    expect(col('entity_id')).toMatchObject({ type: 'bigint unsigned', nullable: 'NO' });
    expect(col('due_at')).toMatchObject({ type: 'datetime', nullable: 'NO' });
    expect(col('seq')?.type).toMatch(/^tinyint(\(\d+\))? unsigned$/);
    expect(col('seq')).toMatchObject({ nullable: 'NO', def: '0' });
    expect(col('sent_at')).toMatchObject({ type: 'datetime', nullable: 'NO' });

    // Os índices, coluna a coluna e na ordem.
    const [stats] = await conn.query<RowDataPacket[]>(
      `SELECT table_name AS tbl, index_name AS idx, non_unique AS nonUnique,
              seq_in_index AS pos, column_name AS col
         FROM information_schema.statistics
        WHERE table_schema = ?
          AND table_name IN ('deadline_reminders', 'contracts', 'contract_milestones')
        ORDER BY table_name, index_name, seq_in_index`,
      [DB],
    );
    const index = (tbl: string, idx: string) => {
      const rows = stats.filter((r) => r.tbl === tbl && r.idx === idx);
      return {
        unique: rows.length > 0 && rows.every((r) => Number(r.nonUnique) === 0),
        cols: rows.map((r) => r.col as string),
      };
    };
    expect(index('deadline_reminders', 'uq_deadline_reminder')).toEqual({
      unique: true,
      cols: ['kind', 'entity_id', 'due_at', 'seq'],
    });
    expect(index('deadline_reminders', 'PRIMARY')).toEqual({ unique: true, cols: ['id'] });
    expect(index('contracts', 'idx_contract_status_revision')).toEqual({
      unique: false,
      cols: ['status', 'revision_requested_at'],
    });
    expect(index('contract_milestones', 'idx_milestone_status_revision')).toEqual({
      unique: false,
      cols: ['status', 'revision_requested_at'],
    });

    // A hora do pedido de revisão: nula nas linhas antigas (o reparo preenche), logo depois das
    // colunas dos prazos.
    const [revision] = await conn.query<RowDataPacket[]>(
      `SELECT c.table_name AS tbl, c.column_type AS type, c.is_nullable AS nullable,
              c.column_default AS def, prev.column_name AS after
         FROM information_schema.columns c
         JOIN information_schema.columns prev
           ON prev.table_schema = c.table_schema AND prev.table_name = c.table_name
          AND prev.ordinal_position = c.ordinal_position - 1
        WHERE c.table_schema = ? AND c.column_name = 'revision_requested_at'
        ORDER BY c.table_name`,
      [DB],
    );
    expect(revision).toEqual([
      {
        tbl: 'contract_milestones',
        type: 'datetime',
        nullable: 'YES',
        def: null,
        after: 'approval_due_at',
      },
      {
        tbl: 'contracts',
        type: 'datetime',
        nullable: 'YES',
        def: null,
        after: 'offer_seq',
      },
    ]);
  });

  it('o UNIQUE do livro barra o mesmo lembrete duas vezes; outra armação (seq) ou outro vencimento é chave nova', async () => {
    const insert = (kind: string, entityId: number, dueAt: string, seq: number) =>
      conn.query(
        `INSERT INTO deadline_reminders (kind, entity_id, due_at, seq, sent_at)
         VALUES (?, ?, ?, ?, '2026-10-01 12:00:00')`,
        [kind, entityId, dueAt, seq],
      );
    await insert('extension', 41, '2026-10-05 12:00:00', 1);
    await expect(insert('extension', 41, '2026-10-05 12:00:00', 1)).rejects.toMatchObject({
      code: 'ER_DUP_ENTRY',
    });
    // O 2º pedido para a mesma data, com a mesma hora de resposta: seq 2, lembrete próprio.
    await insert('extension', 41, '2026-10-05 12:00:00', 2);
    // Novo vencimento (extensão aceita, nova entrega): chave nova, nada para zerar.
    await insert('extension', 41, '2026-10-06 12:00:00', 1);
    // O mesmo id em outro tipo (marco × contratação) não colide.
    await insert('delivery', 41, '2026-10-05 12:00:00', 1);
    await expect(insert('extension', 41, '2026-10-05 12:00:00', 7)).resolves.toBeDefined();
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT kind, seq FROM deadline_reminders WHERE entity_id = 41 ORDER BY id',
    );
    expect(rows.map((r) => [r.kind, Number(r.seq)])).toEqual([
      ['extension', 1],
      ['extension', 2],
      ['extension', 1],
      ['delivery', 1],
      ['extension', 7],
    ]);
  });

  it('carrega o seed de referência só quando o catálogo está vazio', async () => {
    const [newSettings] = await conn.query<RowDataPacket[]>(
      `SELECT key_name, value, type FROM platform_settings
        WHERE key_name IN ('counter_offer_response_hours', 'extension_response_hours')
        ORDER BY key_name`,
    );
    expect(newSettings).toEqual([
      { key_name: 'counter_offer_response_hours', value: '48', type: 'integer' },
      { key_name: 'extension_response_hours', value: '48', type: 'integer' },
    ]);
    // A migration já criou as settings; o seed ainda não rodou. Mesmo na primeira
    // carga do catálogo, o grupo novo preserva alterações anteriores do admin.
    await conn.query(
      `UPDATE platform_settings SET value = '96'
        WHERE key_name = 'counter_offer_response_hours'`,
    );
    await conn.query(
      `UPDATE platform_settings SET value = '72' WHERE key_name = 'extension_response_hours'`,
    );
    expect(await seedReferenceIfEmpty(conn)).toBe(true);
    const [cats] = await conn.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM service_categories',
    );
    expect(Number(cats[0]!.n)).toBeGreaterThan(0);
    const [settings] = await conn.query<RowDataPacket[]>(
      "SELECT value FROM platform_settings WHERE key_name = 'platform_fee_percentage'",
    );
    expect(settings[0]!.value).toBe('15');
    const [preserved] = await conn.query<RowDataPacket[]>(
      `SELECT key_name, value FROM platform_settings
        WHERE key_name IN ('counter_offer_response_hours', 'extension_response_hours')
        ORDER BY key_name`,
    );
    expect(preserved).toEqual([
      { key_name: 'counter_offer_response_hours', value: '96' },
      { key_name: 'extension_response_hours', value: '72' },
    ]);

    // Segunda chamada não reaplica (não sobrescreve o que o admin tenha alterado).
    await conn.query(
      "UPDATE platform_settings SET value = '12' WHERE key_name = 'platform_fee_percentage'",
    );
    expect(await seedReferenceIfEmpty(conn)).toBe(false);
    const [after] = await conn.query<RowDataPacket[]>(
      "SELECT value FROM platform_settings WHERE key_name = 'platform_fee_percentage'",
    );
    expect(after[0]!.value).toBe('12');
  });

  it('0031–0033: tabelas, snapshots nulos e contadores INT UNSIGNED', async () => {
    const [cols] = await conn.query<RowDataPacket[]>(
      `SELECT table_name AS tbl, column_name AS col, column_type AS type,
              is_nullable AS nullable, column_default AS def
         FROM information_schema.columns
        WHERE table_schema = ?
          AND table_name IN ('contracts', 'contract_milestones', 'contract_offers', 'freelancer_dropouts')
        ORDER BY table_name, ordinal_position`,
      [DB],
    );
    const column = (table: string, name: string) =>
      cols.find((r) => r.tbl === table && r.col === name);
    expect(column('contracts', 'fee_percentage')).toMatchObject({
      type: 'decimal(5,2)',
      nullable: 'YES',
      def: null,
    });
    expect(column('contracts', 'offer_seq')).toMatchObject({ nullable: 'NO', def: '1' });
    expect(column('contracts', 'offer_seq')?.type).toMatch(/^tinyint(\(\d+\))? unsigned$/);
    for (const table of ['contracts', 'contract_milestones']) {
      expect(column(table, 'revision_limit')).toMatchObject({
        type: 'int unsigned',
        nullable: 'YES',
        def: null,
      });
      expect(column(table, 'revisions_used')).toMatchObject({
        type: 'int unsigned',
        nullable: 'NO',
        def: '0',
      });
    }
    for (const [table, name] of [
      ['contracts', 'first_delivery_at'],
      ['contracts', 'delivery_dispute_opens_at'],
      ['contract_milestones', 'dispute_opens_at'],
      ['freelancer_dropouts', 'review_checked_at'],
    ]) {
      expect(column(table!, name!)).toMatchObject({
        type: 'datetime',
        nullable: 'YES',
        def: null,
      });
    }
    expect(cols.filter((r) => r.tbl === 'contract_offers').map((r) => r.col)).toEqual([
      'id',
      'contract_id',
      'seq',
      'made_by',
      'price',
      'platform_fee',
      'freelancer_net',
      'deadline_at',
      'milestones',
      'message',
      'respond_by',
      'outcome',
      'created_at',
      'resolved_at',
    ]);
    expect(column('contract_offers', 'milestones')).toMatchObject({
      type: 'json',
      nullable: 'YES',
    });
    expect(column('contract_offers', 'outcome')).toMatchObject({
      type: "enum('open','countered','accepted','declined','withdrawn','expired','closed')",
      nullable: 'NO',
      def: 'open',
    });
    expect(cols.filter((r) => r.tbl === 'freelancer_dropouts').map((r) => r.col)).toEqual([
      'id',
      'contract_id',
      'freelancer_id',
      'dropped_at',
      'client_agreed_at',
      'appeal_text',
      'appealed_at',
      'decision',
      'decided_by',
      'decided_at',
      'decision_note',
      'review_checked_at',
    ]);
    const [stats] = await conn.query<RowDataPacket[]>(
      `SELECT table_name AS tbl, index_name AS idx, non_unique AS nonUnique, column_name AS col
         FROM information_schema.statistics
        WHERE table_schema = ? AND table_name IN ('contract_offers', 'freelancer_dropouts')
        ORDER BY table_name, index_name, seq_in_index`,
      [DB],
    );
    const index = (table: string, name: string) =>
      stats.filter((r) => r.tbl === table && r.idx === name);
    for (const [table, name, columns] of [
      ['contract_offers', 'uq_offer_seq', ['contract_id', 'seq']],
      ['freelancer_dropouts', 'uq_dropout_contract', ['contract_id']],
    ] as const) {
      expect(index(table, name).map((r) => r.col)).toEqual(columns);
      expect(index(table, name).every((r) => Number(r.nonUnique) === 0)).toBe(true);
    }
    expect(index('freelancer_dropouts', 'idx_dropout_freelancer').map((r) => r.col)).toEqual([
      'freelancer_id',
      'dropped_at',
    ]);
    expect(index('freelancer_dropouts', 'idx_dropout_appeal').map((r) => r.col)).toEqual([
      'appealed_at',
      'decided_at',
    ]);
    expect(index('freelancer_dropouts', 'idx_dropout_review_pending').map((r) => r.col)).toEqual([
      'review_checked_at',
      'id',
    ]);
  });

  it('a sequência aceita 1 e 5, barra 0 e 6; ofertas preservam termos e têm UNIQUE/FK reais', async () => {
    await createLegacyFixture(conn);
    for (const seq of [0, 6]) {
      await expect(
        conn.query('UPDATE contracts SET offer_seq = ? WHERE id = 101', [seq]),
      ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    }
    await conn.query('UPDATE contracts SET offer_seq = 5 WHERE id = 101');
    await conn.query('UPDATE contracts SET offer_seq = 1 WHERE id = 101');
    const insert = (contract: number, seq: number) =>
      conn.query(
        `INSERT INTO contract_offers
           (contract_id, seq, made_by, price, platform_fee, freelancer_net, milestones, created_at)
         VALUES (?, ?, 'client', 10.01, 1.50, 8.51, ?, '2026-10-01 12:00:00')`,
        [
          contract,
          seq,
          JSON.stringify([{ id: 201, amount: 10.01, freelancerNet: 8.51, dueAt: null }]),
        ],
      );
    for (const seq of [0, 6]) {
      await expect(insert(101, seq)).rejects.toMatchObject({
        code: 'ER_CHECK_CONSTRAINT_VIOLATED',
      });
    }
    await insert(101, 1);
    await insert(101, 5);
    await expect(insert(101, 1)).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(insert(999, 1)).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    const [offers] = await conn.query<RowDataPacket[]>(
      `SELECT seq, price, platform_fee, freelancer_net, milestones, outcome
         FROM contract_offers WHERE contract_id = 101 ORDER BY seq`,
    );
    expect(
      offers.map((r) => [r.seq, r.price, r.platform_fee, r.freelancer_net, r.outcome]),
    ).toEqual([
      [1, '10.01', '1.50', '8.51', 'open'],
      [5, '10.01', '1.50', '8.51', 'open'],
    ]);
    const saved = offers[0]!.milestones;
    expect(typeof saved === 'string' ? JSON.parse(saved) : saved).toEqual([
      { id: 201, amount: 10.01, freelancerNet: 8.51, dueAt: null },
    ]);
    await conn.query(
      `INSERT INTO deadline_reminders (kind, entity_id, due_at, seq, sent_at)
       VALUES ('counter_offer', 101, '2026-10-03 12:00:00', 2, '2026-10-02 12:00:00')`,
    );
    const [reminders] = await conn.query<RowDataPacket[]>(
      `SELECT kind, kind + 0 AS ordinal FROM deadline_reminders WHERE entity_id = 101`,
    );
    expect(reminders).toEqual([{ kind: 'counter_offer', ordinal: 8 }]);
  });

  it('desistência única tem marcador durável, FKs, SET NULL do decisor e CASCADE do contrato', async () => {
    const insert = (contract: number, freelancer: number, decider: number | null) =>
      conn.query(
        `INSERT INTO freelancer_dropouts (contract_id, freelancer_id, dropped_at, decided_by)
         VALUES (?, ?, '2026-10-05 12:00:00', ?)`,
        [contract, freelancer, decider],
      );
    await insert(101, 62, 63);
    await expect(insert(101, 62, null)).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(insert(999, 62, null)).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    await conn.query(
      `INSERT INTO contracts
         (id, ulid, client_id, freelancer_id, title, description, price, platform_fee, freelancer_net)
       VALUES (102, 'migration-contract-2', 61, 62, 'Segundo', 'Fixture', 10, 1.50, 8.50)`,
    );
    await expect(insert(102, 999, null)).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    await expect(insert(102, 62, 999)).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    const [pending] = await conn.query<RowDataPacket[]>(
      'SELECT review_checked_at FROM freelancer_dropouts WHERE contract_id = 101',
    );
    expect(pending).toEqual([{ review_checked_at: null }]);
    await conn.query('DELETE FROM users WHERE id = 63');
    const [decisions] = await conn.query<RowDataPacket[]>(
      'SELECT decided_by FROM freelancer_dropouts WHERE contract_id = 101',
    );
    expect(decisions).toEqual([{ decided_by: null }]);
    await conn.query(
      `UPDATE freelancer_dropouts SET review_checked_at = '2026-10-05 12:30:00'
        WHERE contract_id = 101`,
    );
    const [checked] = await conn.query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(review_checked_at, '%Y-%m-%d %H:%i:%s') AS checked
         FROM freelancer_dropouts WHERE contract_id = 101`,
    );
    expect(checked).toEqual([{ checked: '2026-10-05 12:30:00' }]);
    await insert(102, 62, null);
    await conn.query(
      `INSERT INTO contract_offers
         (contract_id, seq, made_by, price, platform_fee, freelancer_net, created_at)
       VALUES (102, 1, 'client', 10, 1.50, 8.50, '2026-10-01 12:00:00')`,
    );
    await conn.query('DELETE FROM contracts WHERE id = 102');
    for (const table of ['contract_offers', 'freelancer_dropouts']) {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE contract_id = 102`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
    }
  });

  it('grava snapshots e a revisão 256 tanto no legado ilimitado como após liberação', async () => {
    for (const [table, id] of [
      ['contracts', 101],
      ['contract_milestones', 201],
    ] as const) {
      await conn.query(`UPDATE ${table} SET revisions_used = 256 WHERE id = ?`, [id]);
      const [legacy] = await conn.query<RowDataPacket[]>(
        `SELECT revision_limit, revisions_used FROM ${table} WHERE id = ?`,
        [id],
      );
      expect(legacy).toEqual([{ revision_limit: null, revisions_used: 256 }]);
      await conn.query(`UPDATE ${table} SET revision_limit = 256 WHERE id = ?`, [id]);
      const [granted] = await conn.query<RowDataPacket[]>(
        `SELECT revision_limit, revisions_used FROM ${table} WHERE id = ?`,
        [id],
      );
      expect(granted).toEqual([{ revision_limit: 256, revisions_used: 256 }]);
    }
    await conn.query(
      `UPDATE contracts SET fee_percentage = 15.00, first_delivery_at = '2026-10-04 12:00:00',
         delivery_dispute_opens_at = '2026-10-06 12:00:00' WHERE id = 101`,
    );
    await conn.query(
      `UPDATE contract_milestones SET dispute_opens_at = '2026-10-06 12:00:00' WHERE id = 201`,
    );
    const [contract] = await conn.query<RowDataPacket[]>(
      `SELECT fee_percentage, DATE_FORMAT(first_delivery_at, '%Y-%m-%d %H:%i:%s') AS first,
              DATE_FORMAT(delivery_dispute_opens_at, '%Y-%m-%d %H:%i:%s') AS opens,
              DATE_FORMAT(approval_due_at, '%Y-%m-%d %H:%i:%s') AS approval
         FROM contracts WHERE id = 101`,
    );
    expect(contract).toEqual([
      {
        fee_percentage: '15.00',
        first: '2026-10-04 12:00:00',
        opens: '2026-10-06 12:00:00',
        approval: '2026-10-12 15:00:00',
      },
    ]);
    const [milestone] = await conn.query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(dispute_opens_at, '%Y-%m-%d %H:%i:%s') AS opens,
              DATE_FORMAT(approval_due_at, '%Y-%m-%d %H:%i:%s') AS approval
         FROM contract_milestones WHERE id = 201`,
    );
    expect(milestone).toEqual([
      {
        opens: '2026-10-06 12:00:00',
        approval: '2026-10-12 15:00:00',
      },
    ]);
  });
});

describe('upgrade ADR 61 com dados até 0030', () => {
  it('preserva dados/configurações, retoma o prefixo da 0031 e não inventa desistências históricas', async () => {
    const database = `${DB}_upgrade`;
    await dropDb(database);
    const admin = await mysql.createConnection(cfg);
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await admin.end();
    const old = await mysql.createConnection({ ...cfg, database, multipleStatements: true });
    try {
      await ensureMigrationsTable(old);
      const legacy = loadMigrations().filter((step) => Number(step.name.slice(0, 4)) <= 30);
      for (const step of legacy) {
        await old.query(step.sql);
        await old.query('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [
          step.name,
          createHash('sha256').update(step.sql).digest('hex'),
        ]);
      }
      await createLegacyFixture(old);
      await old.query(
        `INSERT INTO platform_settings (key_name, value, type, description) VALUES
           ('counter_offer_response_hours', '96', 'integer', 'Descrição antiga'),
           ('extension_response_hours', '72', 'integer', 'Descrição antiga')`,
      );
      await old.query(
        `INSERT INTO deadline_reminders (kind, entity_id, due_at, seq, sent_at)
         VALUES ('extension', 101, '2026-10-08 15:00:00', 2, '2026-10-07 15:00:00')`,
      );
      const [before] = await old.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM information_schema.columns
          WHERE table_schema = ? AND table_name = 'contracts' AND column_name = 'offer_seq'`,
        [database],
      );
      expect(Number(before[0]!.n)).toBe(0);

      // Simula interrupção antes do ALTER atômico: os CREATE IF NOT EXISTS e o
      // INSERT com atualização só da descrição são retomados sem duplicar dados.
      const first = loadMigrations().find((step) => step.name === RULE_MIGRATIONS[0])!;
      const prefix = first.sql.split(/\bALTER TABLE contracts\b/)[0]!;
      await old.query(prefix);
      await old.query(prefix);
      const upgraded = await migrate(old);
      expectAppliedFrom(upgraded.applied, RULE_MIGRATIONS);
      expect(upgraded.skipped).toEqual(legacy.map((step) => step.name));
      const [contracts] = await old.query<RowDataPacket[]>(
        `SELECT title, description, price, platform_fee, freelancer_net, status, offer_seq,
                fee_percentage, revision_limit, revisions_used, first_delivery_at,
                delivery_dispute_opens_at,
                DATE_FORMAT(approval_due_at, '%Y-%m-%d %H:%i:%s') AS approval
           FROM contracts WHERE id = 101`,
      );
      expect(contracts).toEqual([
        {
          title: 'Contrato legado',
          description: 'Não perder estes termos',
          price: '10.01',
          platform_fee: '1.50',
          freelancer_net: '8.51',
          status: 'revision_requested',
          offer_seq: 1,
          fee_percentage: null,
          revision_limit: null,
          revisions_used: 0,
          first_delivery_at: null,
          delivery_dispute_opens_at: null,
          approval: '2026-10-12 15:00:00',
        },
      ]);
      const [milestones] = await old.query<RowDataPacket[]>(
        `SELECT title, amount, freelancer_net, status, revision_limit, revisions_used,
                dispute_opens_at, DATE_FORMAT(delivered_at, '%Y-%m-%d %H:%i:%s') AS delivered,
                DATE_FORMAT(approval_due_at, '%Y-%m-%d %H:%i:%s') AS approval
           FROM contract_milestones WHERE id = 201`,
      );
      expect(milestones).toEqual([
        {
          title: 'Marco legado',
          amount: '10.01',
          freelancer_net: '8.51',
          status: 'funded',
          revision_limit: null,
          revisions_used: 0,
          dispute_opens_at: null,
          delivered: '2026-10-04 12:00:00',
          approval: '2026-10-12 15:00:00',
        },
      ]);
      for (const table of ['contract_offers', 'freelancer_dropouts']) {
        const [rows] = await old.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
        expect(Number(rows[0]!.n)).toBe(0);
      }
      const [settings] = await old.query<RowDataPacket[]>(
        `SELECT key_name, value, description FROM platform_settings
          WHERE key_name IN ('counter_offer_response_hours', 'extension_response_hours')
          ORDER BY key_name`,
      );
      expect(settings.map((r) => [r.key_name, r.value])).toEqual([
        ['counter_offer_response_hours', '96'],
        ['extension_response_hours', '72'],
      ]);
      for (const row of settings) expect(row.description).toContain('ADR 61');
      const [reminders] = await old.query<RowDataPacket[]>(
        'SELECT kind, kind + 0 AS ordinal, entity_id, seq FROM deadline_reminders',
      );
      expect(reminders).toEqual([{ kind: 'extension', ordinal: 5, entity_id: 101, seq: 2 }]);

      expect((await migrate(old)).applied).toEqual([]);
      const [after] = await old.query<RowDataPacket[]>(
        `SELECT offer_seq, revision_limit, revisions_used, price FROM contracts WHERE id = 101`,
      );
      expect(after).toEqual([
        { offer_seq: 1, revision_limit: null, revisions_used: 0, price: '10.01' },
      ]);
      for (const [table, id] of [
        ['contracts', 101],
        ['contract_milestones', 201],
      ] as const) {
        await old.query(`UPDATE ${table} SET revisions_used = 256 WHERE id = ?`, [id]);
        const [rows] = await old.query<RowDataPacket[]>(
          `SELECT revision_limit, revisions_used FROM ${table} WHERE id = ?`,
          [id],
        );
        expect(rows).toEqual([{ revision_limit: null, revisions_used: 256 }]);
      }
    } finally {
      await old.end();
      await dropDb(database);
    }
  }, 120_000);
});

describe('upgrade do suporte com chamados legados até 0033', () => {
  it('preenche SLA pela criação/prioridade e primeira resposta pública alheia ao titular sem alterar o histórico', async () => {
    const database = `${DB}_support`;
    await dropDb(database);
    const admin = await mysql.createConnection(cfg);
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await admin.end();
    const old = await mysql.createConnection({ ...cfg, database, multipleStatements: true });
    try {
      await ensureMigrationsTable(old);
      for (const step of loadMigrations().filter((s) => Number(s.name.slice(0, 4)) <= 33)) {
        await old.query(step.sql);
        await old.query('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [
          step.name,
          createHash('sha256').update(step.sql).digest('hex'),
        ]);
      }
      await createLegacyFixture(old);
      await old.query(`INSERT INTO support_tickets (id, ulid, user_id, category, subject, status, priority, resolved_at, created_at)
        VALUES (301,'legacy-low',61,'account','Baixa','open','low',NULL,'2026-10-01 12:00:00'),
        (302,'legacy-medium',61,'account','Média','waiting_user','medium',NULL,'2026-10-01 12:00:00'),
        (303,'legacy-high',61,'payment','Alta','resolved','high','2026-10-02 15:00:00','2026-10-01 12:00:00'),
        (304,'legacy-critical',61,'fraud','Crítica','closed','critical',NULL,'2026-10-01 12:00:00')`);
      await old.query(`INSERT INTO support_ticket_messages (ticket_id,sender_id,message,is_internal,created_at) VALUES
        (301,63,'Nota interna não responde',1,'2026-10-01 12:05:00'),
        (301,61,'O próprio titular não responde',0,'2026-10-01 12:10:00'),
        (302,63,'Primeira resposta pública',0,'2026-10-01 13:00:00'),
        (302,63,'Resposta posterior',0,'2026-10-01 14:00:00')`);
      const step = loadMigrations().find((s) => s.name === '0034_suporte_sla')!;
      // Interrupção depois de parte do DDL: conserva o que já existe e só acrescenta o restante.
      await old.query('ALTER TABLE support_tickets ADD COLUMN first_response_at DATETIME NULL');
      const prefix = step.sql.split(/\bUPDATE support_tickets t\b/)[0]!;
      await old.query(prefix);
      await old.query(prefix);
      // Simula backfill já concluído e um dos índices criado, mas migration ainda sem registro.
      await old.query(`UPDATE support_tickets SET first_response_at='2026-10-01 13:05:00',
        sla_due_at='2026-10-01 14:05:00' WHERE id=304`);
      await old.query(
        'CREATE INDEX idx_st_sla ON support_tickets(first_response_at,sla_alerted_at,sla_due_at)',
      );
      await old.query("UPDATE support_tickets SET updated_at='2026-10-01 12:00:00'");
      expectAppliedFrom((await migrate(old)).applied, ['0034_suporte_sla']);
      const [tickets] = await old.query<RowDataPacket[]>(`SELECT id,subject,status,priority,
        DATE_FORMAT(first_response_at,'%Y-%m-%d %H:%i:%s') AS first_response,
        DATE_FORMAT(sla_due_at,'%Y-%m-%d %H:%i:%s') AS due,
        DATE_FORMAT(resolved_at,'%Y-%m-%d %H:%i:%s') AS resolved, sla_alerted_at
        FROM support_tickets ORDER BY id`);
      expect(
        tickets.map((t) => [
          t.id,
          t.subject,
          t.status,
          t.priority,
          t.first_response,
          t.due,
          t.resolved,
          t.sla_alerted_at,
        ]),
      ).toEqual([
        [301, 'Baixa', 'open', 'low', null, '2026-10-04 12:00:00', null, null],
        [
          302,
          'Média',
          'waiting_user',
          'medium',
          '2026-10-01 13:00:00',
          '2026-10-02 12:00:00',
          null,
          null,
        ],
        [303, 'Alta', 'resolved', 'high', null, '2026-10-01 20:00:00', '2026-10-02 15:00:00', null],
        [
          304,
          'Crítica',
          'closed',
          'critical',
          '2026-10-01 13:05:00',
          '2026-10-01 14:05:00',
          null,
          null,
        ],
      ]);
      const [indexes] = await old.query<RowDataPacket[]>(
        `SELECT index_name AS name FROM information_schema.statistics
        WHERE table_schema=? AND table_name='support_tickets' AND index_name IN ('idx_st_sla','idx_st_resolved') GROUP BY index_name`,
        [database],
      );
      expect(indexes.map((r) => r.name).sort()).toEqual(['idx_st_resolved', 'idx_st_sla']);
      expect((await migrate(old)).applied).toEqual([]);
      const [messages] = await old.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM support_ticket_messages',
      );
      expect(Number(messages[0]!.n)).toBe(4);
    } finally {
      await old.end();
      await dropDb(database);
    }
  }, 120_000);
});
