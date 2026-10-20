import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { usageRepository } from './usage.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

const FROM = new Date('2025-08-25T03:00:00Z');
const TO = new Date('2025-09-01T03:00:00Z');

/**
 * Repository do uso (RF-081) sem banco: de onde sai cada contagem, quem conta como ativo e como o
 * snapshot é gravado uma vez só. Se o SQL bate com o MySQL real é assunto da integração.
 */
describe('usageRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('countsByBucket: cadastros sem admin e contratações criadas, concluídas e canceladas, cada uma pela própria data', async () => {
    const rows = [{ bucket: '2025-08-25', new_users: '2' }];
    fakeDb.reply(rows);

    expect(await usageRepository.countsByBucket(FROM, TO, 'week')).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain("SUM(e.kind = 'user') AS new_users");
    expect(sql).toContain(
      "'user' AS kind FROM users WHERE role <> 'admin' AND created_at >= :from AND created_at < :to",
    );
    expect(sql).toContain(
      "'created' FROM contracts WHERE created_at >= :from AND created_at < :to",
    );
    expect(sql).toContain(
      "'completed' FROM contracts WHERE status = 'completed' AND completed_at >= :from AND completed_at < :to",
    );
    expect(sql).toContain(
      "'cancelled' FROM contracts WHERE status = 'cancelled' AND cancelled_at >= :from AND cancelled_at < :to",
    );
    // Semana: a segunda-feira de Brasília de cada data.
    expect(sql).toContain("INTERVAL WEEKDAY(CONVERT_TZ(cancelled_at, '+00:00', '-03:00')) DAY");
    expect(sql).toContain('GROUP BY e.bucket ORDER BY e.bucket ASC');
    expect(params).toEqual({ format: '%Y-%m-%d', from: FROM, to: TO });
  });

  it('activeByBucket: sessões, mensagens (sem as de sistema) e mudanças de status humanas, sem admin', async () => {
    fakeDb.reply([]);
    await usageRepository.activeByBucket(FROM, TO, 'month');

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain('SELECT a.bucket, COUNT(DISTINCT a.user_id) AS active_users');
    expect(sql).toContain(
      "SELECT s.user_id AS user_id, DATE_FORMAT(CONVERT_TZ(s.created_at, '+00:00', '-03:00'), :format) AS bucket FROM user_sessions s WHERE s.created_at >= :from AND s.created_at < :to",
    );
    expect(sql).toContain(
      "FROM messages m WHERE m.created_at >= :from AND m.created_at < :to AND m.type <> 'system'",
    );
    expect(sql).toContain(
      "FROM contract_status_history h WHERE h.created_at >= :from AND h.created_at < :to AND h.source = 'user'",
    );
    expect(sql).toContain("JOIN users u ON u.id = a.user_id AND u.role <> 'admin'");
    expect(params).toEqual({ format: '%Y-%m', from: FROM, to: TO });
  });

  it('activeTotal: as mesmas fontes, sem balde, cada pessoa uma vez; sem linha é zero', async () => {
    fakeDb.reply([{ active_users: '7' }], []);
    expect(await usageRepository.activeTotal(FROM, TO)).toBe(7);
    expect(await usageRepository.activeTotal(FROM, TO)).toBe(0);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'SELECT COUNT(DISTINCT a.user_id) AS active_users FROM (SELECT s.user_id AS user_id FROM user_sessions s',
    );
    expect(sql).not.toContain('bucket');
    expect(params).toEqual({ from: FROM, to: TO });
  });

  it('as mudanças automáticas ficam de fora pela origem gravada, não pelo texto da nota', async () => {
    fakeDb.reply([], [{ active_users: '0' }]);
    await usageRepository.activeByBucket(FROM, TO, 'day');
    await usageRepository.activeTotal(FROM, TO);

    expect(fakeDb.calls).toHaveLength(2);
    for (const { sql } of fakeDb.calls) {
      // Só a linha que a própria pessoa gravou (source = 'user', migration 0048) é atividade.
      expect(sql).toContain('FROM contract_status_history h WHERE h.created_at >= :from');
      expect(sql).toContain("AND h.source = 'user'");
      // Nem a nota, nem a descrição da disputa: a origem não é mais adivinhada pelo texto.
      expect(sql).not.toMatch(/h\.note|LIKE|FROM disputes/);
    }
  });

  it('reviews: quantas e a média; sem avaliação, zero', async () => {
    fakeDb.reply([{ reviews: '3', avg_rating: '4.3333' }], [{ reviews: 0, avg_rating: '0' }]);
    expect(await usageRepository.reviews(FROM, TO)).toEqual({ count: 3, avg: 4.3333 });
    expect(await usageRepository.reviews(FROM, TO)).toEqual({ count: 0, avg: 0 });
    expect(fakeDb.calls[0]!.sql).toContain(
      'FROM reviews WHERE created_at >= :from AND created_at < :to',
    );
  });

  it('snapshots: do tipo pedido, pelo dia de início, com as datas em texto', async () => {
    const rows = [{ period_start: '2025-08-25', period_end: '2025-08-31' }];
    fakeDb.reply(rows);
    expect(await usageRepository.snapshots('weekly', '2025-08-25', '2025-09-08')).toBe(rows);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain("DATE_FORMAT(period_start, '%Y-%m-%d') AS period_start");
    expect(sql).toContain(
      'FROM report_snapshots WHERE period_type = :type AND period_start >= :fromDay AND period_start <= :toDay ORDER BY period_start ASC',
    );
    expect(params).toEqual({ type: 'weekly', fromDay: '2025-08-25', toDay: '2025-09-08' });
  });

  it('existing: o que já está gravado desde o dia, como "tipo:início"', async () => {
    fakeDb.reply([
      { period_type: 'daily', period_start: '2025-08-31' },
      { period_type: 'monthly', period_start: '2025-08-01' },
    ]);
    const done = await usageRepository.existing('2025-08-01');
    expect([...done]).toEqual(['daily:2025-08-31', 'monthly:2025-08-01']);
    expect(fakeDb.calls[0]!.params).toEqual({ sinceDay: '2025-08-01' });
  });

  it('insert: grava uma vez só (a chave única segura a segunda) e diz se foi esta chamada', async () => {
    const generatedAt = new Date('2025-09-01T03:20:00Z');
    const input = {
      type: 'daily' as const,
      start: '2025-08-31',
      end: '2025-08-31',
      newUsers: 2,
      newContracts: 3,
      completedContracts: 1,
      cancelledContracts: 0,
      activeUsers: 5,
      platformFees: 30,
      totalRevenue: 200,
      avgRating: 4.5,
      payload: { version: 1, deposits: 300 },
      generatedAt,
    };
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

    expect(await usageRepository.insert(input)).toBe(true);
    expect(await usageRepository.insert(input)).toBe(false);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain('INSERT INTO report_snapshots');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE id = id');
    expect(params).toEqual({ ...input, payload: '{"version":1,"deposits":300}' });
  });

  it('a falha do banco sobe para quem chamou', async () => {
    const boom = new Error('ER_QUERY_TIMEOUT');
    fakeDb.reply(boom);
    await expect(usageRepository.activeByBucket(FROM, TO, 'day')).rejects.toBe(boom);
  });
});
