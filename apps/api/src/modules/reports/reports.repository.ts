import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { inTransaction, pool } from '../../config/db';
import { mediaBlocklist } from '../media/media.blocklist';
import type { ImageFingerprint } from '../media/media.image';
import { mediaRepository } from '../media/media.repository';
import { messagingRepository } from '../messaging/messaging.repository';
import { reviewsRepository } from '../reviews/reviews.repository';
import { contentRemovalsRepository } from './content-removals.repository';
import type { ImageTarget, TextTarget } from './reports.schema';

export interface ContentReportRow extends RowDataPacket {
  id: number;
  reporter_id: number;
  target_type: string;
  target_id: number;
  /** Imagem denunciada como estava na hora (ADR 39); null para alvos que não são imagem. */
  image_url: string | null;
  reason: string;
  description: string | null;
  status: string;
  reviewed_at: Date | null;
  resolution_note: string | null;
  created_at: Date;
}

export interface ImageTargetRow extends RowDataPacket {
  owner_id: number;
  image_url: string | null;
  title: string | null;
}

/** Autor e texto de uma avaliação ou mensagem denunciada (ADR 44). */
export interface TextTargetRow extends RowDataPacket {
  owner_id: number;
  text: string | null;
  rating: number | null;
  file_name: string | null;
  removed_at: Date | null;
}

/** O que a fila mostra de um alvo: dono, título ou trecho e a imagem no ar agora. */
export interface TargetInfoRow extends RowDataPacket {
  id: number;
  owner_id: number | null;
  owner_ulid: string | null;
  owner_name: string | null;
  title: string | null;
  image_url: string | null;
}

/** Um grupo de denúncias: mesmo alvo e mesma imagem. */
export interface GroupRef {
  targetType: string;
  targetId: number;
  imageUrl: string | null;
  adminId: number;
  note: string | null;
}

const COLS = `id, reporter_id, target_type, target_id, image_url, reason, description, status,
              reviewed_at, resolution_note, created_at`;

/** Dono e nome de exibição: perfil de freelancer, senão o de cliente. */
const OWNER = `u.id AS owner_id, u.ulid AS owner_ulid, COALESCE(pf.full_name, pc.full_name) AS owner_name`;
const OWNER_JOINS = `LEFT JOIN profiles_freelancer pf ON pf.user_id = u.id
                     LEFT JOIN profiles_client pc ON pc.user_id = u.id`;

/** Fecha as denúncias abertas do grupo; todas ganham o mesmo reviewed_at e a mesma nota. */
async function closeOpen(
  conn: PoolConnection,
  g: GroupRef & { status: 'actioned' | 'dismissed' },
): Promise<number> {
  const [res] = await conn.query<ResultSetHeader>(
    `UPDATE content_reports
        SET status = :status, reviewed_by = :adminId, reviewed_at = NOW(), resolution_note = :note
      WHERE target_type = :targetType AND target_id = :targetId AND image_url <=> :imageUrl
        AND status IN ('pending', 'reviewing')`,
    {
      status: g.status,
      adminId: g.adminId,
      note: g.note,
      targetType: g.targetType,
      targetId: g.targetId,
      imageUrl: g.imageUrl,
    },
  );
  return res.affectedRows;
}

export const reportsRepository = {
  async create(d: {
    reporterId: number;
    targetType: string;
    targetId: number;
    imageUrl: string | null;
    reason: string;
    description: string | null;
  }): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO content_reports (reporter_id, target_type, target_id, image_url, reason, description)
       VALUES (:reporterId, :targetType, :targetId, :imageUrl, :reason, :description)`,
      d,
    );
    return res.insertId;
  },

  async listForReporter(reporterId: number): Promise<ContentReportRow[]> {
    const [rows] = await pool.query<ContentReportRow[]>(
      `SELECT ${COLS} FROM content_reports WHERE reporter_id = :reporterId ORDER BY id DESC`,
      { reporterId },
    );
    return rows;
  },

  async findById(id: number): Promise<ContentReportRow | undefined> {
    const [rows] = await pool.query<ContentReportRow[]>(
      `SELECT ${COLS} FROM content_reports WHERE id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  /** Dono e imagem no ar de um alvo de imagem: a foto do perfil ou um trabalho do portfólio. */
  async imageTarget(type: ImageTarget, id: number): Promise<ImageTargetRow | undefined> {
    const sql =
      type === 'avatar'
        ? `SELECT u.id AS owner_id, COALESCE(pf.avatar_url, pc.avatar_url) AS image_url, NULL AS title
             FROM users u ${OWNER_JOINS}
            WHERE u.id = :id AND u.deleted_at IS NULL
            LIMIT 1`
        : `SELECT item_owner.user_id AS owner_id, i.image_url, i.title
             FROM freelancer_portfolio_items i
             JOIN profiles_freelancer item_owner ON item_owner.id = i.freelancer_id
            WHERE i.id = :id
            LIMIT 1`;
    const [rows] = await pool.query<ImageTargetRow[]>(sql, { id });
    return rows[0];
  },

  /** Já existe denúncia aberta desta pessoa para o mesmo alvo e a mesma imagem? */
  async hasPending(
    reporterId: number,
    targetType: string,
    targetId: number,
    imageUrl: string | null,
  ): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT 1 FROM content_reports
        WHERE reporter_id = :reporterId AND target_type = :targetType AND target_id = :targetId
          AND image_url <=> :imageUrl AND status IN ('pending', 'reviewing')
        LIMIT 1`,
      { reporterId, targetType, targetId, imageUrl },
    );
    return rows.length > 0;
  },

  /** Denúncias da fila, das mais recentes para as mais antigas. limit é constante do serviço. */
  async listForModeration(
    scope: 'pending' | 'resolved',
    limit: number,
  ): Promise<ContentReportRow[]> {
    const where =
      scope === 'pending'
        ? `status IN ('pending', 'reviewing')`
        : `status IN ('actioned', 'dismissed')`;
    const [rows] = await pool.query<ContentReportRow[]>(
      `SELECT ${COLS} FROM content_reports WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ${Math.trunc(limit)}`,
    );
    return rows;
  },

  async usersByIds(ids: number[]): Promise<TargetInfoRow[]> {
    if (ids.length === 0) return [];
    const [rows] = await pool.query<TargetInfoRow[]>(
      `SELECT u.id, ${OWNER}, NULL AS title, COALESCE(pf.avatar_url, pc.avatar_url) AS image_url
         FROM users u ${OWNER_JOINS}
        WHERE u.id IN (:ids)`,
      { ids },
    );
    return rows;
  },

  async portfolioByIds(ids: number[]): Promise<TargetInfoRow[]> {
    if (ids.length === 0) return [];
    const [rows] = await pool.query<TargetInfoRow[]>(
      `SELECT i.id, ${OWNER}, i.title, i.image_url
         FROM freelancer_portfolio_items i
         JOIN profiles_freelancer item_owner ON item_owner.id = i.freelancer_id
         JOIN users u ON u.id = item_owner.user_id
         ${OWNER_JOINS}
        WHERE i.id IN (:ids)`,
      { ids },
    );
    return rows;
  },

  async servicesByIds(ids: number[]): Promise<TargetInfoRow[]> {
    if (ids.length === 0) return [];
    const [rows] = await pool.query<TargetInfoRow[]>(
      `SELECT s.id, ${OWNER}, s.title, NULL AS image_url
         FROM services s JOIN users u ON u.id = s.user_id ${OWNER_JOINS}
        WHERE s.id IN (:ids)`,
      { ids },
    );
    return rows;
  },

  /** Avaliação: o dono é quem escreveu, e o trecho é o comentário. */
  async reviewsByIds(ids: number[]): Promise<TargetInfoRow[]> {
    if (ids.length === 0) return [];
    const [rows] = await pool.query<TargetInfoRow[]>(
      `SELECT r.id, ${OWNER}, r.comment AS title, NULL AS image_url
         FROM reviews r JOIN users u ON u.id = r.reviewer_id ${OWNER_JOINS}
        WHERE r.id IN (:ids)`,
      { ids },
    );
    return rows;
  },

  /** Mensagem: o dono é quem enviou, e o trecho é o texto. */
  async messagesByIds(ids: number[]): Promise<TargetInfoRow[]> {
    if (ids.length === 0) return [];
    const [rows] = await pool.query<TargetInfoRow[]>(
      `SELECT m.id, ${OWNER}, m.content AS title, NULL AS image_url
         FROM messages m JOIN users u ON u.id = m.sender_id ${OWNER_JOINS}
        WHERE m.id IN (:ids)`,
      { ids },
    );
    return rows;
  },

  /** Autor e texto de uma avaliação ou mensagem, e se ela já saiu do ar (ADR 44). */
  async textTarget(type: TextTarget, id: number): Promise<TextTargetRow | undefined> {
    const sql =
      type === 'review'
        ? `SELECT reviewer_id AS owner_id, comment AS text, rating, NULL AS file_name, removed_at
             FROM reviews WHERE id = :id LIMIT 1`
        : `SELECT sender_id AS owner_id, content AS text, NULL AS rating, file_name, removed_at
             FROM messages WHERE id = :id LIMIT 1`;
    const [rows] = await pool.query<TextTargetRow[]>(sql, { id });
    return rows[0];
  },

  /**
   * Remoção de avaliação ou mensagem numa transação só (ADR 44): tira o conteúdo do ar (a avaliação
   * sai da nota média), fecha as denúncias abertas do grupo e, quando há autor, registra a remoção
   * contestável com uma cópia do texto.
   */
  async removeContentAndClose(
    g: GroupRef & {
      targetType: TextTarget;
      reportId: number;
      reason: string;
      author: { id: number; snapshot: string } | null;
    },
  ): Promise<{ reports: number; removalId: number | null }> {
    return inTransaction(async (conn) => {
      const hidden =
        g.targetType === 'review'
          ? await reviewsRepository.setRemoved(conn, g.targetId, true)
          : await messagingRepository.setRemoved(conn, g.targetId, true);
      const reports = await closeOpen(conn, { ...g, status: 'actioned' });
      const removalId =
        g.author && hidden
          ? await contentRemovalsRepository.insert(conn, {
              reportId: g.reportId,
              ownerId: g.author.id,
              targetType: g.targetType,
              targetId: g.targetId,
              imageUrl: null,
              snapshot: g.author.snapshot,
              reason: g.reason,
              note: g.note,
              refs: null,
              blocklistId: null,
              adminId: g.adminId,
            })
          : null;
      return { reports, removalId };
    });
  },

  /** Revisão de conta por reincidência (ADR 41) ainda aberta: evita abrir outra a cada remoção. */
  async hasOpenAccountReview(userId: number): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT 1 FROM content_reports
        WHERE target_type = 'user' AND target_id = :userId AND status IN ('pending', 'reviewing')
          AND description LIKE 'Reincidência:%'
        LIMIT 1`,
      { userId },
    );
    return rows.length > 0;
  },

  /** Dispensa ou resolve o grupo, sem mexer no conteúdo. Devolve quantas denúncias fechou. */
  async closeGroup(g: GroupRef & { status: 'actioned' | 'dismissed' }): Promise<number> {
    return inTransaction((conn) => closeOpen(conn, g));
  },

  /**
   * Remoção de imagem numa transação só (ADR 39 e 41): anota de onde a imagem sai, tira a URL de
   * todo perfil e trabalho que a mostra, fecha as denúncias abertas do grupo, bloqueia o reenvio se
   * houver impressão do arquivo e, quando a imagem tem dono, registra a remoção contestável.
   */
  async removeImageAndClose(
    g: GroupRef & {
      url: string;
      print: ImageFingerprint | null;
      reportId: number;
      ownerId: number | null;
      reason: string;
    },
  ): Promise<{ cleared: number; reports: number; removalId: number | null }> {
    return inTransaction(async (conn) => {
      const refs = await mediaRepository.referencesTo(conn, g.url);
      const cleared = await mediaRepository.clearReferences(conn, g.url);
      const reports = await closeOpen(conn, { ...g, status: 'actioned' });
      const blocklistId = g.print
        ? await mediaBlocklist.add(conn, {
            print: g.print,
            reportId: g.reportId,
            adminId: g.adminId,
          })
        : null;
      const removalId =
        g.ownerId === null
          ? null
          : await contentRemovalsRepository.insert(conn, {
              reportId: g.reportId,
              ownerId: g.ownerId,
              targetType: g.targetType as ImageTarget,
              targetId: g.targetId,
              imageUrl: g.url,
              snapshot: null,
              reason: g.reason,
              note: g.note,
              refs,
              blocklistId,
              adminId: g.adminId,
            });
      return { cleared, reports, removalId };
    });
  },
};
