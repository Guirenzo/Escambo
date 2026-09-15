import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../config/db';

/** Tabelas e colunas que podem mostrar uma imagem (lista fechada: os nomes vão para o SQL). */
export const IMAGE_COLUMNS = {
  profiles_freelancer: 'avatar_url',
  profiles_client: 'avatar_url',
  freelancer_portfolio_items: 'image_url',
} as const;
export type ImageTable = keyof typeof IMAGE_COLUMNS;

/** Uma linha que mostrava a imagem antes da remoção (ADR 41), para recolocar se a remoção cair. */
export interface ImageRef {
  table: ImageTable;
  id: number;
}

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

  /** Quais linhas mostram a URL agora (antes de limpar, para a remoção poder ser desfeita). */
  async referencesTo(conn: PoolConnection, url: string): Promise<ImageRef[]> {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT 'profiles_freelancer' AS tbl, id FROM profiles_freelancer WHERE avatar_url = :url
       UNION ALL
       SELECT 'profiles_client', id FROM profiles_client WHERE avatar_url = :url
       UNION ALL
       SELECT 'freelancer_portfolio_items', id FROM freelancer_portfolio_items WHERE image_url = :url`,
      { url },
    );
    return rows.map((r) => ({ table: r.tbl as ImageTable, id: Number(r.id) }));
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

  /**
   * Recoloca a imagem nas linhas de onde ela saiu (remoção revertida, ADR 41), só onde o campo
   * continua vazio: se a pessoa já pôs outra foto, a nova fica.
   */
  async restoreReferences(conn: PoolConnection, url: string, refs: ImageRef[]): Promise<number> {
    let restored = 0;
    for (const ref of refs) {
      const column = IMAGE_COLUMNS[ref.table];
      if (!column) continue;
      const [res] = await conn.query<ResultSetHeader>(
        `UPDATE ${ref.table} SET ${column} = :url WHERE id = :id AND ${column} IS NULL`,
        { url, id: ref.id },
      );
      restored += res.affectedRows;
    }
    return restored;
  },
};
