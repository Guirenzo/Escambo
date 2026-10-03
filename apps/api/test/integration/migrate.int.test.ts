import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appliedMigrations, migrate, seedReferenceIfEmpty } from '../../src/scripts/migrate-core';

/**
 * Runner de migrations num banco vazio: baseline, migrations em ordem (com as dos prazos de dia,
 * 0027 e 0028, e as dos lembretes, 0029 e 0030), idempotência e o seed de referência carregado uma
 * vez só.
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

let conn: Connection;

async function dropDb(): Promise<void> {
  const admin = await mysql.createConnection(cfg);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.end();
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
  // Baseline + 30 migrations num banco vazio: com o MySQL dividido entre suítes, passa dos 30 s do
  // padrão, e o teste seguinte rodaria o runner por cima deste, ainda em andamento.
  it('aplica o baseline num banco vazio e registra em schema_migrations', async () => {
    const result = await migrate(conn);

    expect(result.applied).toContain('0000_baseline');
    expect(result.applied).toEqual(expect.arrayContaining(DEADLINE_MIGRATIONS));
    expect(result.applied).toEqual(expect.arrayContaining(REMINDER_MIGRATIONS));
    // Em ordem: a 0030 depois da 0029, as duas depois da 0028.
    const at = (name: string): number => result.applied.indexOf(name);
    expect(at('0028_prazos_marcos')).toBeLessThan(at('0029_lembretes_prazos'));
    expect(at('0029_lembretes_prazos')).toBeLessThan(at('0030_lembretes_marcos'));

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
      type: "enum('proposal','delivery','approval','milestone_approval','extension','revision','milestone_revision')",
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
        after: 'proposal_expires_at',
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
    expect(await seedReferenceIfEmpty(conn)).toBe(true);
    const [cats] = await conn.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM service_categories',
    );
    expect(Number(cats[0]!.n)).toBeGreaterThan(0);
    const [settings] = await conn.query<RowDataPacket[]>(
      "SELECT value FROM platform_settings WHERE key_name = 'platform_fee_percentage'",
    );
    expect(settings[0]!.value).toBe('15');

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
});
