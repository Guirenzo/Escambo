import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../config/db';

export const mediaRepository = {
  /** URLs de mídia própria em uso (ADR 36): avatares de freelancer e de cliente e o portfólio. */
  async listReferencedUrls(): Promise<string[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT avatar_url AS url FROM profiles_freelancer WHERE avatar_url LIKE '/api/media/%'
       UNION
       SELECT avatar_url FROM profiles_client WHERE avatar_url LIKE '/api/media/%'
       UNION
       SELECT image_url FROM freelancer_portfolio_items WHERE image_url LIKE '/api/media/%'`,
    );
    return rows.map((r) => String(r.url));
  },

  /**
   * Tira uma imagem de todo lugar que a mostra (ADR 39): avatar de freelancer e de cliente e imagem
   * de trabalho do portfólio. O endereço é público e qualquer um pode colá-lo no próprio perfil,
   * então a limpeza é pela URL, não pelo dono. O trabalho continua, só sem a imagem.
   */
  async clearReferences(conn: PoolConnection, url: string): Promise<number> {
    let cleared = 0;
    for (const sql of [
      `UPDATE profiles_freelancer SET avatar_url = NULL WHERE avatar_url = :url`,
      `UPDATE profiles_client SET avatar_url = NULL WHERE avatar_url = :url`,
      `UPDATE freelancer_portfolio_items SET image_url = NULL WHERE image_url = :url`,
    ]) {
      const [res] = await conn.query<ResultSetHeader>(sql, { url });
      cleared += res.affectedRows;
    }
    return cleared;
  },
};
