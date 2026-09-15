import type { RemovalTarget } from '@escambo/types';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { inTransaction, pool } from '../../config/db';
import { mediaBlocklist } from '../media/media.blocklist';
import { mediaRepository, type ImageRef } from '../media/media.repository';
import { messagingRepository } from '../messaging/messaging.repository';
import { reviewsRepository } from '../reviews/reviews.repository';

export type RemovalStatus = 'removed' | 'appealed' | 'upheld' | 'overturned';

export interface ContentRemovalRow extends RowDataPacket {
  id: number;
  report_id: number | null;
  owner_id: number;
  target_type: RemovalTarget;
  target_id: number;
  image_url: string | null;
  /** Texto removido de avaliação ou mensagem (ADR 44). */
  content_snapshot: string | null;
  reason: string;
  note: string | null;
  cleared_refs: string | ImageRef[] | null;
  quarantine_file: string | null;
  blocklist_id: number | null;
  removed_by: number | null;
  removed_at: Date;
  status: RemovalStatus;
  appeal_text: string | null;
  appealed_at: Date | null;
  decided_by: number | null;
  decided_at: Date | null;
  decision_note: string | null;
  file_purged_at: Date | null;
  /** Título do trabalho do portfólio, enquanto o trabalho existe. */
  work_title: string | null;
}

export interface AppealRow extends ContentRemovalRow {
  owner_ulid: string;
  owner_name: string | null;
}

const COLS = `r.id, r.report_id, r.owner_id, r.target_type, r.target_id, r.image_url, r.content_snapshot,
              r.reason, r.note,
              r.cleared_refs, r.quarantine_file, r.blocklist_id, r.removed_by, r.removed_at, r.status,
              r.appeal_text, r.appealed_at, r.decided_by, r.decided_at, r.decision_note,
              r.file_purged_at, pi.title AS work_title`;
const WORK_JOIN = `LEFT JOIN freelancer_portfolio_items pi
                     ON r.target_type = 'portfolio_item' AND pi.id = r.target_id`;

/** Conteúdo removido pela moderação e contestações (ADR 41 e 44). */
export const contentRemovalsRepository = {
  async insert(
    conn: PoolConnection,
    d: {
      reportId: number;
      ownerId: number;
      targetType: RemovalTarget;
      targetId: number;
      imageUrl: string | null;
      snapshot: string | null;
      reason: string;
      note: string | null;
      refs: ImageRef[] | null;
      blocklistId: number | null;
      adminId: number;
    },
  ): Promise<number> {
    const [res] = await conn.query<ResultSetHeader>(
      `INSERT INTO content_removals
         (report_id, owner_id, target_type, target_id, image_url, content_snapshot, reason, note,
          cleared_refs, blocklist_id, removed_by)
       VALUES (:reportId, :ownerId, :targetType, :targetId, :imageUrl, :snapshot, :reason, :note,
               :refs, :blocklistId, :adminId)`,
      { ...d, refs: d.refs === null ? null : JSON.stringify(d.refs) },
    );
    return res.insertId;
  },

  async setQuarantineFile(id: number, file: string): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE content_removals SET quarantine_file = :file WHERE id = :id`,
      { id, file },
    );
  },

  async findById(id: number): Promise<ContentRemovalRow | undefined> {
    const [rows] = await pool.query<ContentRemovalRow[]>(
      `SELECT ${COLS} FROM content_removals r ${WORK_JOIN} WHERE r.id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async listForOwner(ownerId: number): Promise<ContentRemovalRow[]> {
    const [rows] = await pool.query<ContentRemovalRow[]>(
      `SELECT ${COLS} FROM content_removals r ${WORK_JOIN}
        WHERE r.owner_id = :ownerId
        ORDER BY r.removed_at DESC, r.id DESC`,
      { ownerId },
    );
    return rows;
  },

  /**
   * Ocorrências desde `since`: remoções não revertidas de qualquer conteúdo (revisão da conta) e só
   * as de imagem, com a mais recente delas (bloqueio de envio, ADR 44).
   */
  async strikeStats(
    ownerId: number,
    since: Date,
  ): Promise<{ strikes: number; imageStrikes: number; lastImage: Date | null }> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS strikes,
              COALESCE(SUM(target_type IN ('avatar', 'portfolio_item')), 0) AS image_strikes,
              MAX(CASE WHEN target_type IN ('avatar', 'portfolio_item') THEN removed_at END)
                AS last_image
         FROM content_removals
        WHERE owner_id = :ownerId AND status IN ('removed', 'appealed', 'upheld')
          AND removed_at >= :since`,
      { ownerId, since },
    );
    const row = rows[0];
    return {
      strikes: Number(row?.strikes ?? 0),
      imageStrikes: Number(row?.image_strikes ?? 0),
      lastImage: row?.last_image ? new Date(row.last_image) : null,
    };
  },

  /** Registra a contestação; só vale uma vez, e só do dono. */
  async appeal(id: number, ownerId: number, text: string): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE content_removals
          SET status = 'appealed', appeal_text = :text, appealed_at = NOW()
        WHERE id = :id AND owner_id = :ownerId AND status = 'removed'`,
      { id, ownerId, text },
    );
    return res.affectedRows > 0;
  },

  /** Contestações para o admin: pendentes das mais antigas, decididas das mais recentes. */
  async listAppeals(scope: 'pending' | 'decided', limit: number): Promise<AppealRow[]> {
    const where =
      scope === 'pending'
        ? `r.status = 'appealed'`
        : `r.status IN ('upheld', 'overturned') AND r.appealed_at IS NOT NULL`;
    const order = scope === 'pending' ? 'r.appealed_at ASC' : 'r.decided_at DESC';
    const [rows] = await pool.query<AppealRow[]>(
      `SELECT ${COLS}, u.ulid AS owner_ulid, COALESCE(pf.full_name, pc.full_name) AS owner_name
         FROM content_removals r ${WORK_JOIN}
         JOIN users u ON u.id = r.owner_id
         LEFT JOIN profiles_freelancer pf ON pf.user_id = u.id
         LEFT JOIN profiles_client pc ON pc.user_id = u.id
        WHERE ${where}
        ORDER BY ${order}, r.id ASC
        LIMIT ${Math.trunc(limit)}`,
    );
    return rows;
  },

  async uphold(id: number, adminId: number, note: string | null): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE content_removals
          SET status = 'upheld', decided_by = :adminId, decided_at = NOW(), decision_note = :note
        WHERE id = :id AND status = 'appealed'`,
      { id, adminId, note },
    );
    return res.affectedRows > 0;
  },

  /**
   * Reverte a remoção numa transação: decide a contestação, tira a imagem da lista de bloqueio e,
   * se o arquivo voltou (ou era link externo), recoloca a imagem onde ela estava.
   */
  async overturn(d: {
    id: number;
    adminId: number;
    note: string | null;
    url: string;
    refs: ImageRef[];
    blocklistId: number | null;
    restoreRefs: boolean;
    fileBack: boolean;
  }): Promise<{ decided: boolean; restored: number }> {
    return inTransaction(async (conn) => {
      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE content_removals
            SET status = 'overturned', decided_by = :adminId, decided_at = NOW(),
                decision_note = :note,
                quarantine_file = IF(:fileBack, NULL, quarantine_file)
          WHERE id = :id AND status = 'appealed'`,
        { id: d.id, adminId: d.adminId, note: d.note, fileBack: d.fileBack ? 1 : 0 },
      );
      if (res.affectedRows === 0) return { decided: false, restored: 0 };
      if (d.blocklistId !== null) await mediaBlocklist.remove(conn, d.blocklistId);
      const restored = d.restoreRefs
        ? await mediaRepository.restoreReferences(conn, d.url, d.refs)
        : 0;
      return { decided: true, restored };
    });
  },

  /**
   * Reverte a remoção de avaliação ou mensagem numa transação (ADR 44): decide a contestação e
   * devolve o conteúdo ao ar; a avaliação volta para a nota média.
   */
  async overturnContent(d: {
    id: number;
    adminId: number;
    note: string | null;
    targetType: 'review' | 'message';
    targetId: number;
  }): Promise<{ decided: boolean; restored: number }> {
    return inTransaction(async (conn) => {
      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE content_removals
            SET status = 'overturned', decided_by = :adminId, decided_at = NOW(),
                decision_note = :note
          WHERE id = :id AND status = 'appealed'`,
        { id: d.id, adminId: d.adminId, note: d.note },
      );
      if (res.affectedRows === 0) return { decided: false, restored: 0 };
      const back =
        d.targetType === 'review'
          ? await reviewsRepository.setRemoved(conn, d.targetId, false)
          : await messagingRepository.setRemoved(conn, d.targetId, false);
      return { decided: true, restored: back ? 1 : 0 };
    });
  },

  async markFilePurged(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE content_removals SET file_purged_at = NOW() WHERE id = :id`,
      { id },
    );
  },

  /**
   * Arquivos de quarentena que já podem sair: remoção mantida, ou sem contestação depois do prazo.
   * Contestação pendente segura o arquivo até a decisão.
   */
  async listQuarantineToPurge(appealCutoff: Date, limit: number): Promise<ContentRemovalRow[]> {
    const [rows] = await pool.query<ContentRemovalRow[]>(
      `SELECT ${COLS} FROM content_removals r ${WORK_JOIN}
        WHERE r.quarantine_file IS NOT NULL AND r.file_purged_at IS NULL
          AND (r.status = 'upheld' OR (r.status = 'removed' AND r.removed_at < :appealCutoff))
        ORDER BY r.id ASC
        LIMIT ${Math.trunc(limit)}`,
      { appealCutoff },
    );
    return rows;
  },

  /** Arquivos ainda em quarentena de um titular (anonimização LGPD). */
  async listQuarantinedForOwner(ownerId: number): Promise<ContentRemovalRow[]> {
    const [rows] = await pool.query<ContentRemovalRow[]>(
      `SELECT ${COLS} FROM content_removals r ${WORK_JOIN}
        WHERE r.owner_id = :ownerId AND r.quarantine_file IS NOT NULL AND r.file_purged_at IS NULL`,
      { ownerId },
    );
    return rows;
  },
};
