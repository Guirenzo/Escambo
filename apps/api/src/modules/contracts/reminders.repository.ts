import type { BrazilTimezone } from '@escambo/types';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../config/db';
import {
  REMINDER_MAX_AHEAD_MS,
  REMINDER_MIN_AGE_MS,
  REMINDER_MIN_LEFT_MS,
} from '../../utils/human-hours';
import { REVISION_STALL_DAYS } from './deadline-grace';
import { candidatesSql, claimSql, type ReminderKind } from './reminders-sql';

/** Uma linha que pode ser lembrada, com o que o slot e o portão precisam. */
export interface ReminderCandidate extends RowDataPacket {
  contract_id: number;
  /** contracts.id, ou contract_milestones.id nos tipos de marco. */
  entity_id: number;
  due_at: Date;
  seq: number;
  start_at: Date | null;
  client_id: number;
  freelancer_id: number;
  client_timezone: string | null;
  freelancer_timezone: string | null;
}

const H = 3_600_000;

/** O livro dos lembretes (ADR 58): candidatas, trava da contratação e a trava do lembrete. */
export const remindersRepository = {
  /** Uma página de candidatas; sem fuso de dia, nem consulta. */
  async candidates(
    kind: ReminderKind,
    p: { now: Date; zones: BrazilTimezone[]; after: { due: Date; id: number } },
  ): Promise<ReminderCandidate[]> {
    if (p.zones.length === 0) return [];
    const now = p.now.getTime();
    const [rows] = await pool.query<ReminderCandidate[]>(candidatesSql(kind), {
      zones: p.zones,
      minDue: new Date(now + REMINDER_MIN_LEFT_MS),
      maxDue: new Date(now + REMINDER_MAX_AHEAD_MS),
      aged: new Date(now - REMINDER_MIN_AGE_MS),
      staleBefore: new Date(now - REVISION_STALL_DAYS * 24 * H),
      afterDue: p.after.due,
      afterId: p.after.id,
    });
    return rows;
  },

  /**
   * Trava compartilhada na contratação: o mutex do agregado. Entregar, aprovar, pedir revisão ou
   * decidir um pedido começam por uma trava exclusiva nessa linha e esperam o lembrete terminar.
   */
  async lockContract(conn: PoolConnection, contractId: number): Promise<boolean> {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM contracts WHERE id = :contractId FOR SHARE`,
      { contractId },
    );
    return rows.length > 0;
  },

  /** true = ganhou; false = o estado mudou (0 linhas) ou outra instância ganhou (ER_DUP_ENTRY). */
  async claim(
    conn: PoolConnection,
    kind: ReminderKind,
    p: {
      contractId: number;
      entityId: number;
      due: Date;
      seq: number;
      /** O início que a candidata trouxe (null nos tipos sem início). */
      start: Date | null;
      now: Date;
    },
  ): Promise<boolean> {
    try {
      const [res] = await conn.query<ResultSetHeader>(claimSql(kind), {
        contractId: p.contractId,
        entityId: p.entityId,
        due: p.due,
        seq: p.seq,
        start: p.start,
        now: p.now,
      });
      return res.affectedRows === 1;
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  },
};
