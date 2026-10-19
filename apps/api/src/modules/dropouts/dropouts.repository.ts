import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { inTransaction, pool } from '../../config/db';
import { clock } from '../../utils/clock';
import { lockWalletUsers } from '../wallet/wallet.locks';
import { reportsRepository } from '../reports/reports.repository';
import {
  notificationsService,
  type NotifyInput,
  type SavedNotification,
} from '../notifications/notifications.service';
import { canAgree, canAppeal, dropoutSince, dropoutSummary, type DropoutRow } from './dropouts';

export interface FullDropoutRow extends RowDataPacket, DropoutRow {
  id: number;
  contract_id: number;
  freelancer_id: number;
  client_id: number;
  contract_title: string;
  freelancer_ulid: string;
  freelancer_name: string | null;
  freelancer_timezone: string | null;
  appeal_text: string | null;
  decided_by: number | null;
  decided_at: Date | null;
  decision_note: string | null;
  review_checked_at: Date | null;
}

const COLS = `d.*, c.client_id, c.title AS contract_title,
  u.ulid AS freelancer_ulid, pf.full_name AS freelancer_name,
  u.timezone AS freelancer_timezone`;
const JOINS = `JOIN contracts c ON c.id = d.contract_id
  JOIN users u ON u.id = d.freelancer_id
  LEFT JOIN profiles_freelancer pf ON pf.user_id = u.id`;
const bounded = (n: number): number => Math.max(1, Math.min(500, Math.trunc(n) || 1));

async function lockUser(conn: PoolConnection, uid: number): Promise<RowDataPacket | undefined> {
  const [rows] = await conn.query<RowDataPacket[]>(
    'SELECT id, deleted_at FROM users WHERE id = :uid FOR UPDATE',
    { uid },
  );
  return rows[0];
}

async function lockedById(conn: PoolConnection, id: number): Promise<FullDropoutRow | undefined> {
  // FOR UPDATE só na desistência: travar o JOIN da contratação inverteria a ordem contratação → usuário.
  const [locked] = await conn.query<FullDropoutRow[]>(
    'SELECT * FROM freelancer_dropouts WHERE id = :id FOR UPDATE',
    { id },
  );
  if (!locked[0]) return undefined;
  const [rows] = await conn.query<FullDropoutRow[]>(
    `SELECT ${COLS} FROM freelancer_dropouts d ${JOINS} WHERE d.id = :id`,
    { id },
  );
  return rows[0] ? { ...rows[0], ...locked[0] } : undefined;
}

export type DropoutMutation =
  { row: FullDropoutRow; now: Date } | { refused: 'not_found' | 'closed' | 'appeal_required' };

export const dropoutsRepository = {
  /** Aviso depois da decisão: a trava impede repor notas em conta já anonimizada. */
  async saveDecisionNotification(
    uid: number,
    params: NotifyInput,
  ): Promise<SavedNotification | null> {
    return inTransaction(async (conn) => {
      const owner = await lockUser(conn, uid);
      if (!owner || owner.deleted_at != null) return null;
      return notificationsService.persist(uid, params, conn);
    });
  },
  async findById(id: number, conn?: PoolConnection): Promise<FullDropoutRow | undefined> {
    const [rows] = await (conn ?? pool).query<FullDropoutRow[]>(
      `SELECT ${COLS} FROM freelancer_dropouts d ${JOINS} WHERE d.id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async findByContractId(
    contractId: number,
    conn?: PoolConnection,
  ): Promise<FullDropoutRow | undefined> {
    const [rows] = await (conn ?? pool).query<FullDropoutRow[]>(
      `SELECT ${COLS} FROM freelancer_dropouts d ${JOINS}
       WHERE d.contract_id = :contractId LIMIT 1`,
      { contractId },
    );
    return rows[0];
  },

  async listCounting(uid: number, now: Date, conn?: PoolConnection): Promise<FullDropoutRow[]> {
    const [rows] = await (conn ?? pool).query<FullDropoutRow[]>(
      `SELECT ${COLS} FROM freelancer_dropouts d ${JOINS}
       WHERE d.freelancer_id = :uid AND d.dropped_at >= :since AND d.dropped_at <= :now
         AND d.client_agreed_at IS NULL AND (d.decision IS NULL OR d.decision = 'upheld')
       ORDER BY d.dropped_at ASC, d.id ASC`,
      { uid, since: dropoutSince(now), now },
    );
    return rows;
  },

  async listMine(uid: number): Promise<FullDropoutRow[]> {
    const [rows] = await pool.query<FullDropoutRow[]>(
      `SELECT ${COLS} FROM freelancer_dropouts d ${JOINS}
       WHERE d.freelancer_id = :uid ORDER BY d.dropped_at DESC, d.id DESC`,
      { uid },
    );
    return rows;
  },

  async listAppealed(): Promise<FullDropoutRow[]> {
    const [rows] = await pool.query<FullDropoutRow[]>(
      `SELECT ${COLS} FROM freelancer_dropouts d ${JOINS}
       WHERE d.appealed_at IS NOT NULL AND d.decision IS NULL AND d.decided_at IS NULL
         AND d.client_agreed_at IS NULL AND u.deleted_at IS NULL
       ORDER BY d.appealed_at ASC, d.id ASC LIMIT 200`,
    );
    return rows;
  },

  async userIdByUlid(ulid: string): Promise<number | undefined> {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM users WHERE ulid = :ulid', {
      ulid,
    });
    return rows[0]?.id as number | undefined;
  },

  async acceptedInWindow(uid: number, now: Date, conn?: PoolConnection): Promise<number> {
    const [rows] = await (conn ?? pool).query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT c.id) AS total FROM contracts c
       WHERE c.freelancer_id = :uid AND (
         (c.accepted_at >= :since AND c.accepted_at <= :now)
         OR EXISTS (SELECT 1 FROM freelancer_dropouts d WHERE d.contract_id = c.id
           AND d.dropped_at >= :since AND d.dropped_at <= :now))`,
      { uid, since: dropoutSince(now), now },
    );
    return Number(rows[0]?.total ?? 0);
  },

  async findReviewPending(limit: number): Promise<FullDropoutRow[]> {
    const [rows] = await pool.query<FullDropoutRow[]>(
      `SELECT ${COLS} FROM freelancer_dropouts d ${JOINS}
       WHERE d.review_checked_at IS NULL ORDER BY d.id ASC LIMIT ${bounded(limit)}`,
    );
    return rows;
  },

  /** Cliente: contratação → usuário → desistência. Nenhuma carteira é tocada. */
  async agree(contractId: number, clientId: number): Promise<DropoutMutation> {
    return inTransaction(async (conn) => {
      const [contracts] = await conn.query<RowDataPacket[]>(
        'SELECT id, client_id, freelancer_id FROM contracts WHERE id = :contractId FOR UPDATE',
        { contractId },
      );
      const contract = contracts[0];
      if (!contract || contract.client_id !== clientId) return { refused: 'not_found' };
      // O histórico referencia o cliente. Inclua essa trava compartilhada antes
      // da exclusiva do freelancer para não inverter uma desistência recíproca.
      await lockWalletUsers(conn, [clientId], [Number(contract.freelancer_id)]);
      const owner = await lockUser(conn, Number(contract.freelancer_id));
      if (!owner || owner.deleted_at != null) return { refused: 'not_found' };
      const [rows] = await conn.query<FullDropoutRow[]>(
        'SELECT id FROM freelancer_dropouts WHERE contract_id = :contractId',
        { contractId },
      );
      const row = rows[0] && (await lockedById(conn, rows[0].id));
      if (!row) return { refused: 'not_found' };
      const now = clock.now();
      if (!canAgree(row, now)) return { refused: 'closed' };
      await conn.query<ResultSetHeader>(
        'UPDATE freelancer_dropouts SET client_agreed_at = :now WHERE id = :id',
        { id: row.id, now },
      );
      await conn.query<ResultSetHeader>(
        `INSERT INTO contract_status_history
          (contract_id, changed_by, old_status, new_status, note, created_at)
         VALUES (:contractId, :clientId, 'cancelled', 'cancelled', :note, :now)`,
        {
          contractId,
          clientId,
          now,
          note: 'O cliente confirmou que a desistência foi combinada (RN-026)',
        },
      );
      return { row: { ...row, client_agreed_at: now }, now };
    });
  },

  async appeal(uid: number, id: number, text: string): Promise<DropoutMutation> {
    return inTransaction(async (conn) => {
      const owner = await lockUser(conn, uid);
      if (!owner || owner.deleted_at != null) return { refused: 'not_found' };
      const row = await lockedById(conn, id);
      if (!row || row.freelancer_id !== uid) return { refused: 'not_found' };
      const now = clock.now();
      if (!canAppeal(row, now)) return { refused: 'closed' };
      await conn.query<ResultSetHeader>(
        'UPDATE freelancer_dropouts SET appeal_text = :text, appealed_at = :now WHERE id = :id',
        { id, text, now },
      );
      return { row: { ...row, appeal_text: text, appealed_at: now }, now };
    });
  },

  async decide(
    adminId: number,
    id: number,
    decision: 'excuse' | 'uphold',
    note: string,
    ip: string | null,
  ): Promise<DropoutMutation> {
    // Esta leitura só descobre o usuário a travar. A permissão e o estado são relidos sob trava.
    const candidate = await this.findById(id);
    if (!candidate) return { refused: 'not_found' };
    return inTransaction(async (conn) => {
      const owner = await lockUser(conn, candidate.freelancer_id);
      if (!owner || owner.deleted_at != null) return { refused: 'not_found' };
      const row = await lockedById(conn, id);
      if (!row) return { refused: 'not_found' };
      const now = clock.now();
      if (row.decision !== null || row.client_agreed_at !== null) return { refused: 'closed' };
      if (decision === 'uphold' && row.appealed_at === null) return { refused: 'appeal_required' };
      const stored = decision === 'excuse' ? 'excused' : 'upheld';
      await conn.query<ResultSetHeader>(
        `UPDATE freelancer_dropouts SET decision = :stored, decided_by = :adminId,
          decided_at = :now, decision_note = :note WHERE id = :id`,
        { id, stored, adminId, now, note },
      );
      await conn.query<ResultSetHeader>(
        `INSERT INTO admin_actions (admin_id, action, target_type, target_id, description, ip_address)
         VALUES (:adminId, :action, 'dropout', :id, :note, :ip)`,
        {
          adminId,
          action: decision === 'excuse' ? 'dropout_excused' : 'dropout_upheld',
          id,
          note,
          ip,
        },
      );
      return {
        row: {
          ...row,
          decision: stored,
          decided_by: adminId,
          decided_at: now,
          decision_note: note,
        },
        now,
      };
    });
  },

  /** O marcador e a eventual revisão são um único COMMIT. Erros deixam o trabalho pendente. */
  async reconcileReviews(
    uid: number,
    limit = 100,
  ): Promise<{ checked: number; reviewOpened: boolean }> {
    return inTransaction(async (conn) => {
      const owner = await lockUser(conn, uid);
      if (!owner) return { checked: 0, reviewOpened: false };
      const [pending] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM freelancer_dropouts WHERE freelancer_id = :uid AND review_checked_at IS NULL
         ORDER BY id ASC LIMIT ${bounded(limit)} FOR UPDATE`,
        { uid },
      );
      if (!pending.length) return { checked: 0, reviewOpened: false };
      const now = clock.now();
      const rows = owner.deleted_at != null ? [] : await this.listCounting(uid, now, conn);
      const { count, alert } = dropoutSummary(rows, now);
      let reviewOpened = false;
      if (alert) {
        const latest = rows.at(-1)!;
        reviewOpened = await reportsRepository.openAccountReview(
          {
            userId: uid,
            prefix: 'Desistências:',
            description: `Desistências: ${count} desistências de contratação depois do aceite nos últimos 60 dias (a mais recente na contratação #${latest.contract_id}). Revise a conta.`,
          },
          conn,
        );
      }
      for (const row of pending) {
        await conn.query<ResultSetHeader>(
          `UPDATE freelancer_dropouts SET review_checked_at = :now
           WHERE id = :id AND freelancer_id = :uid AND review_checked_at IS NULL`,
          { id: row.id, uid, now },
        );
      }
      return { checked: pending.length, reviewOpened };
    });
  },
};
