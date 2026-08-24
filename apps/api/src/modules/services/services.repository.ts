import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface ServiceRow extends RowDataPacket {
  id: number;
  user_id: number;
  category_id: number;
  title: string;
  description: string;
  price_type: 'fixed' | 'hourly' | 'negotiable';
  price: string | null; // DECIMAL chega como string no mysql2
  delivery_days: number | null;
  is_remote: number;
  is_active: number;
  views_count: number;
  created_at: Date;
  deleted_at: Date | null;
}

export interface ServiceListFilters {
  categoryId?: number;
  q?: string;
  isRemote?: boolean;
  limit: number;
  offset: number;
}

export const servicesRepository = {
  async create(data: {
    userId: number;
    categoryId: number;
    title: string;
    description: string;
    priceType: string;
    price: number | null;
    deliveryDays: number | null;
    isRemote: boolean;
  }): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO services (user_id, category_id, title, description, price_type, price, delivery_days, is_remote)
       VALUES (:userId, :categoryId, :title, :description, :priceType, :price, :deliveryDays, :isRemote)`,
      { ...data, isRemote: data.isRemote ? 1 : 0 },
    );
    return res.insertId;
  },

  async findById(id: number): Promise<ServiceRow | undefined> {
    const [rows] = await pool.query<ServiceRow[]>(
      `SELECT * FROM services WHERE id = :id AND deleted_at IS NULL LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async list(filters: ServiceListFilters): Promise<ServiceRow[]> {
    const where: string[] = ['deleted_at IS NULL', 'is_active = 1'];
    const params: Record<string, string | number> = {};

    if (filters.categoryId !== undefined) {
      where.push('category_id = :categoryId');
      params.categoryId = filters.categoryId;
    }
    if (filters.isRemote !== undefined) {
      where.push('is_remote = :isRemote');
      params.isRemote = filters.isRemote ? 1 : 0;
    }
    if (filters.q) {
      where.push('(title LIKE :q OR description LIKE :q)');
      params.q = `%${filters.q}%`;
    }

    // limit/offset são inteiros validados (Zod) — seguros para interpolar.
    const [rows] = await pool.query<ServiceRow[]>(
      `SELECT * FROM services
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ${filters.limit} OFFSET ${filters.offset}`,
      params,
    );
    return rows;
  },

  async update(id: number, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    // As chaves vêm de um mapeamento fixo no service (nunca do usuário) — sem risco de injeção.
    const setClause = keys.map((k) => `${k} = :${k}`).join(', ');
    await pool.query<ResultSetHeader>(`UPDATE services SET ${setClause} WHERE id = :id`, {
      ...fields,
      id,
    });
  },

  async softDelete(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE services SET deleted_at = NOW(), is_active = 0 WHERE id = :id`,
      { id },
    );
  },
};
