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
  /** Janela de silêncio dos avisos no navegador (ADR 54), horas no fuso da conta; null = desligado. */
  push_quiet_start?: number | null;
  push_quiet_end?: number | null;
  /** Marca d'água do resumo ao fim do silêncio: retidos até este id já foram tratados. */
  push_quiet_summary_id?: number | null;
}

/** Camada de acesso a dados da tabela `users`. */
export const authRepository = {
  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, ulid, email, password_hash, role, status, deleted_at, email_verified_at, email_frequency, digest_hour, timezone, push_quiet_start, push_quiet_end, push_quiet_summary_id FROM users WHERE email = :email LIMIT 1',
      { email },
    );
    return rows[0];
  },

  async findByUlid(ulid: string): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, ulid, email, password_hash, role, status, deleted_at, email_verified_at, email_frequency, digest_hour, timezone, push_quiet_start, push_quiet_end, push_quiet_summary_id FROM users WHERE ulid = :ulid LIMIT 1',
      { ulid },
    );
    return rows[0];
  },

  async findById(id: number): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      'SELECT id, ulid, email, password_hash, role, status, deleted_at, email_verified_at, email_frequency, digest_hour, timezone, push_quiet_start, push_quiet_end, push_quiet_summary_id FROM users WHERE id = :id LIMIT 1',
      { id },
    );
    return rows[0];
  },

  async create(data: {
    ulid: string;
    email: string;
    passwordHash: string;
    role: string;
    /** Fuso do aparelho no cadastro (ADR 51); null = padrão de Brasília, sem escolha. */
    timezone?: string | null;
  }): Promise<number> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (ulid, email, password_hash, role, status, timezone)
       VALUES (:ulid, :email, :passwordHash, :role, 'pending_verification', :timezone)`,
      { ...data, timezone: data.timezone ?? null },
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
      /** Janela inteira ou null (desliga); nunca meia janela (ADR 54). */
      quietHours?: { start: number; end: number } | null;
    },
  ): Promise<void> {
    const sets: string[] = [];
    if (change.emailFrequency !== undefined) sets.push('email_frequency = :emailFrequency');
    if (change.digestHour !== undefined) sets.push('digest_hour = :digestHour');
    if (change.timezone !== undefined) sets.push('timezone = :timezone');
    if (change.quietHours !== undefined) {
      sets.push('push_quiet_start = :quietStart, push_quiet_end = :quietEnd');
      // Desligar descarta o que ficou retido: nada bate retroativamente (a pessoa está no app).
      // Trocar as horas ou o fuso não mexe na marca: o já retido continua valendo para o resumo.
      if (change.quietHours === null) {
        sets.push(
          'push_quiet_summary_id = (SELECT COALESCE(MAX(n.id), 0) FROM notifications n WHERE n.user_id = users.id)',
        );
      }
    }
    if (sets.length === 0) return;
    await pool.query<ResultSetHeader>(`UPDATE users SET ${sets.join(', ')} WHERE id = :id`, {
      id,
      emailFrequency: change.emailFrequency ?? null,
      digestHour: change.digestHour ?? null,
      timezone: change.timezone ?? null,
      quietStart: change.quietHours?.start ?? null,
      quietEnd: change.quietHours?.end ?? null,
    });
  },

  /**
   * Quem recebe avisos ao papel de admin (ADR 55): quem consegue entrar como admin — o mesmo corte
   * de assertActive. Inclui quem ainda não confirmou o e-mail, que é o estado do primeiro admin de
   * todo deploy. Sem LIMIT: admins são poucos por natureza.
   */
  async listAdmins(): Promise<{ id: number; email: string }[]> {
    const [rows] = await pool.query<(RowDataPacket & { id: number; email: string })[]>(
      `SELECT id, email FROM users
        WHERE role = 'admin' AND deleted_at IS NULL AND status NOT IN ('suspended', 'banned')
        ORDER BY id`,
    );
    return rows.map((r) => ({ id: r.id, email: r.email }));
  },

  async updateRole(id: number, role: string): Promise<void> {
    await pool.query<ResultSetHeader>(`UPDATE users SET role = :role WHERE id = :id`, { id, role });
  },
};
