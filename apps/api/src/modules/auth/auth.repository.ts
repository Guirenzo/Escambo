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
  email_frequency?: 'instant' | 'daily' | 'off';
  /** Hora do resumo do dia (ADR 42); null segue DIGEST_HOUR. */
  digest_hour?: number | null;
  /** Fuso da conta (ADR 46); null segue Brasília. */
  timezone?: string | null;
}

/** Camada de acesso a dados da tabela `users`. */
export const authRepository = {
  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, ulid, email, password_hash, role, status, deleted_at, email_verified_at, email_frequency, digest_hour, timezone FROM users WHERE email = :email LIMIT 1',
      { email },
    );
    return rows[0];
  },

  async findByUlid(ulid: string): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, ulid, email, password_hash, role, status, deleted_at, email_verified_at, email_frequency, digest_hour, timezone FROM users WHERE ulid = :ulid LIMIT 1',
      { ulid },
    );
    return rows[0];
  },

  async findById(id: number): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, ulid, email, password_hash, role, status, deleted_at, email_verified_at, email_frequency, digest_hour, timezone FROM users WHERE id = :id LIMIT 1',
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

  /** Frequência dos e-mails, hora do resumo e fuso (ADR 27, 42 e 46); só muda o que vier. */
  async setEmailPreference(
    id: number,
    change: {
      emailFrequency?: 'instant' | 'daily' | 'off';
      digestHour?: number | null;
      timezone?: string | null;
    },
  ): Promise<void> {
    const sets: string[] = [];
    if (change.emailFrequency !== undefined) sets.push('email_frequency = :emailFrequency');
    if (change.digestHour !== undefined) sets.push('digest_hour = :digestHour');
    if (change.timezone !== undefined) sets.push('timezone = :timezone');
    if (sets.length === 0) return;
    await pool.query<ResultSetHeader>(`UPDATE users SET ${sets.join(', ')} WHERE id = :id`, {
      id,
      emailFrequency: change.emailFrequency ?? null,
      digestHour: change.digestHour ?? null,
      timezone: change.timezone ?? null,
    });
  },

  async updateRole(id: number, role: string): Promise<void> {
    await pool.query<ResultSetHeader>(`UPDATE users SET role = :role WHERE id = :id`, { id, role });
  },
};
