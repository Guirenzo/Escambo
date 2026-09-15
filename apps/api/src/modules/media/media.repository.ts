import type { RowDataPacket } from 'mysql2';
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
};
