import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface UserRow extends RowDataPacket {
  id: number;
  ulid: string;
  email: string;
  password_hash: string | null;
  role: string;
  status: string;
  deleted_at?: Date | null;
  email_verified_at?: Date | null;
}

/** Camada de acesso a dados da tabela `users`. */
export const authRepository = {
  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, ulid, email, password_hash, role, status, deleted_at, email_verified_at FROM users WHERE email = :email LIMIT 1',
      { email },
    );
    return rows[0];
  },

  async findByUlid(ulid: string): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, ulid, email, password_hash, role, status, deleted_at, email_verified_at FROM users WHERE ulid = :ulid LIMIT 1',
      { ulid },
    );
    return rows[0];
  },

  async findById(id: number): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, ulid, email, password_hash, role, status, deleted_at, email_verified_at FROM users WHERE id = :id LIMIT 1',
      { id },
    );
    return rows[0];
  },

  async create(data: {
    ulid: string;
    email: string;
    passwordHash: string;
    role: string;
  }): Promise<number> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (ulid, email, password_hash, role, status)
       VALUES (:ulid, :email, :passwordHash, :role, 'pending_verification')`,
      data,
    );
    return result.insertId;
  },

  async updatePassword(id: number, passwordHash: string): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE users SET password_hash = :passwordHash WHERE id = :id`,
      { id, passwordHash },
    );
  },

  /** Marca o e-mail como confirmado; conta 'pending_verification' passa a 'active'. */
  async markEmailVerified(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE users
          SET email_verified_at = COALESCE(email_verified_at, NOW()),
              status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END
        WHERE id = :id`,
      { id },
    );
  },

  async updateRole(id: number, role: string): Promise<void> {
    await pool.query<ResultSetHeader>(`UPDATE users SET role = :role WHERE id = :id`, { id, role });
  },
};
