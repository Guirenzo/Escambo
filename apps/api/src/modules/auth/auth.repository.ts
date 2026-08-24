import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface UserRow extends RowDataPacket {
  id: number;
  ulid: string;
  email: string;
  password_hash: string | null;
  role: string;
  status: string;
}

/** Camada de acesso a dados da tabela `users`. */
export const authRepository = {
  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, ulid, email, password_hash, role, status FROM users WHERE email = :email LIMIT 1',
      { email },
    );
    return rows[0];
  },

  async findByUlid(ulid: string): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, ulid, email, password_hash, role, status FROM users WHERE ulid = :ulid LIMIT 1',
      { ulid },
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
};
