import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../config/db';
import { PERCEPTUAL_MATCH_BITS, type ImageFingerprint } from './media.image';

/**
 * Lista de bloqueio das imagens removidas pela moderação (ADR 39). Bate pela assinatura exata do
 * arquivo ou, quando as duas imagens têm detalhe suficiente, por até PERCEPTUAL_MATCH_BITS bits de
 * diferença na impressão perceptual. A comparação perceptual varre a tabela (BIT_COUNT não usa
 * índice): serve enquanto a lista tiver milhares de linhas, não milhões. Remoção revertida numa
 * contestação (ADR 41) tira a linha.
 */
export const mediaBlocklist = {
  async add(
    conn: PoolConnection,
    d: { print: ImageFingerprint; reportId: number; adminId: number },
  ): Promise<number> {
    const [res] = await conn.query<ResultSetHeader>(
      `INSERT INTO media_blocklist (sha256, dhash, report_id, created_by)
       VALUES (:sha256, :dhash, :reportId, :adminId)`,
      {
        sha256: d.print.sha256,
        dhash: d.print.dhash === null ? null : d.print.dhash.toString(),
        reportId: d.reportId,
        adminId: d.adminId,
      },
    );
    return res.insertId;
  },

  async remove(conn: PoolConnection, id: number): Promise<void> {
    await conn.query<ResultSetHeader>(`DELETE FROM media_blocklist WHERE id = :id`, { id });
  },

  async matches(print: ImageFingerprint): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM media_blocklist
        WHERE sha256 = :sha256
           OR (:dhash IS NOT NULL AND dhash IS NOT NULL
               AND BIT_COUNT(dhash ^ CAST(:dhash AS UNSIGNED)) <= :maxBits)
        LIMIT 1`,
      {
        sha256: print.sha256,
        dhash: print.dhash === null ? null : print.dhash.toString(),
        maxBits: PERCEPTUAL_MATCH_BITS,
      },
    );
    return rows.length > 0;
  },
};
