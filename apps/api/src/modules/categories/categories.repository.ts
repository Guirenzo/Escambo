import type { RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface CategoryRow extends RowDataPacket {
  id: number;
  parent_id: number | null;
  name: string;
  slug: string;
  icon_url: string | null;
}

export const categoriesRepository = {
  async listActive(): Promise<CategoryRow[]> {
    const [rows] = await pool.query<CategoryRow[]>(
      `SELECT id, parent_id, name, slug, icon_url
         FROM service_categories
        WHERE is_active = 1
        ORDER BY sort_order ASC, name ASC`,
    );
    return rows;
  },
};
