import type { QuietPassCategory } from '@escambo/types';
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
  /** O SET como o mysql2 devolve ('deadline', ''); NULL = nunca escolheu (ADR 56). */
  push_quiet_pass?: string | null;
  /** Marca d'água do resumo ao fim do silêncio: retidos até este id já foram tratados. */
  push_quiet_summary_id?: number | null;
}

/** As colunas da conta que o login e o resto da API leem (UserRow), sem as da 2FA nem do Google. */
export const USER_COLUMNS =
  'id, ulid, email, password_hash, role, status, deleted_at, email_verified_at, email_frequency, digest_hour, timezone, push_quiet_start, push_quiet_end, push_quiet_pass, push_quiet_summary_id';

/** A conta como o atendimento a vê (ADR 66): sem senha nem contato além do e-mail buscado. */
export interface AccountLookupRow extends RowDataPacket {
  id: number;
  ulid: string;
  email: string;
  role: string;
  status: string;
  created_at: Date;
  /** 1 se a verificação em duas etapas está ativa. */
  mfa_enabled: number;
}

/** O contato e as formas de entrar da conta, para o próprio titular (GET /auth/contact). */
export interface ContactRow extends RowDataPacket {
  email: string;
  email_verified_at: Date | null;
  phone: string | null;
  /** 1 se a conta tem senha (a conta criada pelo Google nasce sem). */
  has_password: number;
  /** 1 se a conta tem conta Google vinculada (RF-002). */
  google_linked: number;
}

/** Camada de acesso a dados da tabela `users`. */
export const authRepository = {
  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      `SELECT ${USER_COLUMNS} FROM users WHERE email = :email LIMIT 1`,
      { email },
    );
    return rows[0];
  },

  async findByUlid(ulid: string): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      `SELECT ${USER_COLUMNS} FROM users WHERE ulid = :ulid LIMIT 1`,
      { ulid },
    );
    return rows[0];
  },

  async findById(id: number): Promise<UserRow | undefined> {
    const [rows] = await pool.query<UserRow[]>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = :id LIMIT 1`,
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
      /** O conjunto inteiro do que sai no silêncio (ADR 56); o servidor nunca inventa o padrão. */
      quietPass?: QuietPassCategory[];
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
    // Ligar ou desligar a janela não mexe na escolha do que sai durante ela (ADR 56).
    if (change.quietPass !== undefined) sets.push('push_quiet_pass = :quietPass');
    if (sets.length === 0) return;
    await pool.query<ResultSetHeader>(`UPDATE users SET ${sets.join(', ')} WHERE id = :id`, {
      id,
      emailFrequency: change.emailFrequency ?? null,
      digestHour: change.digestHour ?? null,
      timezone: change.timezone ?? null,
      quietStart: change.quietHours?.start ?? null,
      quietEnd: change.quietHours?.end ?? null,
      quietPass: change.quietPass?.join(',') ?? null,
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

  /**
   * O contato da conta (RF-017), que só o titular vê: e-mail, se está confirmado e o telefone. E
   * como ela entra (RF-002): se tem senha e se tem conta Google vinculada (nunca o hash nem o sub).
   */
  async findContact(id: number): Promise<ContactRow | undefined> {
    const [rows] = await pool.query<ContactRow[]>(
      `SELECT email, email_verified_at, phone, password_hash IS NOT NULL AS has_password,
              google_sub IS NOT NULL AS google_linked
         FROM users WHERE id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  /**
   * Grava o telefone (E.164) ou o apaga (null). A confirmação do número antigo não passa para um
   * número novo: phone_verified_at é calculado antes de phone mudar (o MySQL aplica o SET em ordem).
   */
  async updatePhone(id: number, phone: string | null): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE users
          SET phone_verified_at = IF(phone <=> :phone, phone_verified_at, NULL), phone = :phone
        WHERE id = :id`,
      { id, phone },
    );
  },

  /** Busca do atendimento pelo e-mail exato (a collation já ignora maiúsculas), com a 2FA ativa ou não. */
  async findAccountByEmail(email: string): Promise<AccountLookupRow | undefined> {
    const [rows] = await pool.query<AccountLookupRow[]>(
      `SELECT u.id, u.ulid, u.email, u.role, u.status, u.created_at,
              EXISTS (SELECT 1 FROM user_mfa m
                       WHERE m.user_id = u.id AND m.method = 'totp' AND m.is_enabled = 1) AS mfa_enabled
         FROM users u
        WHERE u.email = :email
        LIMIT 1`,
      { email },
    );
    return rows[0];
  },

  /**
   * Desfaz uma conta que acabou de nascer e não pôde ser concluída (o CNPJ da empresa entrou em outra
   * conta no meio do cadastro, RF-018). Só a recém-criada: ainda sem confirmação de e-mail nem login.
   */
  async deleteUnfinished(id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
      `DELETE FROM users WHERE id = :id AND last_login_at IS NULL AND email_verified_at IS NULL`,
      { id },
    );
  },

  async updateRole(id: number, role: string): Promise<void> {
    await pool.query<ResultSetHeader>(`UPDATE users SET role = :role WHERE id = :id`, { id, role });
  },
};
