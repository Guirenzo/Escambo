import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import type { StoredRecoveryCode } from './recovery-codes';

/** Erros de código seguidos que travam a 2FA da conta, e por quanto tempo (ADR 66). */
export const MFA_MAX_ATTEMPTS = 5;
export const MFA_LOCK_MINUTES = 15;

export interface MfaRow extends RowDataPacket {
  id: number;
  user_id: number;
  /** VARBINARY: o mysql2 devolve Buffer. Sempre o texto `enc:v1:...` do field-crypto. */
  secret: Buffer | string | null;
  is_enabled: number;
  confirmed_at: Date | null;
  /** JSON: o mysql2 devolve o array já lido. */
  recovery_codes: unknown;
  last_used_step: number | string | null;
  failed_attempts: number;
  locked_until: Date | null;
  /** 1 enquanto locked_until está no futuro do `now` de quem leu. */
  locked: number;
}

/**
 * Acesso a dados de `user_mfa` (a linha 'totp' da conta). O instante vem do Node (`now`, ADR 57):
 * a trava compara com o mesmo relógio que a grava. As gravações que dependem do que foi lido
 * (último passo aceito, código de recuperação ainda livre) vão condicionadas no WHERE: duas
 * requisições com o mesmo código, ao mesmo tempo, não saem as duas aceitas.
 */
export const mfaRepository = {
  async findByUser(userId: number, now: Date): Promise<MfaRow | undefined> {
    const [rows] = await pool.query<MfaRow[]>(
      `SELECT id, user_id, secret, is_enabled, confirmed_at, recovery_codes, last_used_step,
              failed_attempts, locked_until,
              (locked_until IS NOT NULL AND locked_until > :now) AS locked
         FROM user_mfa
        WHERE user_id = :userId AND method = 'totp'
        LIMIT 1`,
      { userId, now },
    );
    return rows[0];
  },

  /** A consulta leve do login e do painel: a 2FA está ativa? */
  async isEnabled(userId: number): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT 1 AS enabled FROM user_mfa
        WHERE user_id = :userId AND method = 'totp' AND is_enabled = 1
        LIMIT 1`,
      { userId },
    );
    return rows.length > 0;
  },

  /**
   * Grava (ou troca) o segredo pendente, ainda não ativo. Linha que ficou ativa no meio do caminho
   * não é tocada (o IF de cada coluna). A trava e o contador de erros ficam como estão: refazer o
   * começo não destrava. Sem retorno: o mysql2 conta linha "encontrada" como afetada (FOUND_ROWS),
   * então quem chama confere a linha antes.
   */
  async savePending(userId: number, sealedSecret: string): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO user_mfa (user_id, method, secret, is_enabled)
       VALUES (:userId, 'totp', :secret, 0)
       ON DUPLICATE KEY UPDATE
         last_used_step = IF(is_enabled = 0, NULL, last_used_step),
         confirmed_at = IF(is_enabled = 0, NULL, confirmed_at),
         recovery_codes = IF(is_enabled = 0, NULL, recovery_codes),
         secret = IF(is_enabled = 0, :secret, secret)`,
      { userId, secret: sealedSecret },
    );
  },

  /**
   * Ativa a linha pendente com o passo do código que confirmou e os códigos de recuperação. Só
   * se ela ainda é a mesma que foi conferida (o segredo não foi trocado no meio) e o passo é novo.
   */
  async enable(
    id: number,
    data: {
      sealedSecret: Buffer | string;
      step: number;
      recoveryCodes: StoredRecoveryCode[];
      now: Date;
    },
  ): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE user_mfa
          SET is_enabled = 1, confirmed_at = :now, last_used_step = :step,
              recovery_codes = :codes, failed_attempts = 0, locked_until = NULL
        WHERE id = :id AND is_enabled = 0 AND secret = :secret
          AND (last_used_step IS NULL OR last_used_step < :step)`,
      {
        id,
        now: data.now,
        step: data.step,
        codes: JSON.stringify(data.recoveryCodes),
        secret: data.sealedSecret,
      },
    );
    return res.affectedRows > 0;
  },

  /** Aceita o passo do TOTP (anti-reuso) e zera os erros. false: o passo já não é novo. */
  async acceptStep(id: number, step: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE user_mfa
          SET last_used_step = :step, failed_attempts = 0, locked_until = NULL
        WHERE id = :id AND is_enabled = 1
          AND (last_used_step IS NULL OR last_used_step < :step)`,
      { id, step },
    );
    return res.affectedRows > 0;
  },

  /**
   * Marca como usado o código de recuperação daquela posição, se ainda é o mesmo hash e ainda está
   * livre (outra requisição pode ter usado, ou a lista ter sido trocada), e zera os erros.
   */
  async useRecoveryCode(id: number, index: number, hash: string, now: Date): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE user_mfa
          SET recovery_codes = JSON_SET(recovery_codes, :usedPath, :usedAt),
              failed_attempts = 0, locked_until = NULL
        WHERE id = :id AND is_enabled = 1
          AND JSON_UNQUOTE(JSON_EXTRACT(recovery_codes, :hashPath)) = :hash
          AND JSON_TYPE(JSON_EXTRACT(recovery_codes, :usedPath)) = 'NULL'`,
      {
        id,
        hash,
        usedPath: `$[${index}].usedAt`,
        hashPath: `$[${index}].h`,
        usedAt: now.toISOString(),
      },
    );
    return res.affectedRows > 0;
  },

  /**
   * Conta um erro de código. No MFA_MAX_ATTEMPTS-ésimo, trava até `now` + MFA_LOCK_MINUTES e zera
   * o contador (o MySQL aplica o SET em ordem: locked_until lê o contador antes de ele mudar).
   * Devolve se a conta ficou travada com este erro.
   */
  async registerFailure(id: number, now: Date): Promise<boolean> {
    const lockUntil = new Date(now.getTime() + MFA_LOCK_MINUTES * 60_000);
    await pool.query<ResultSetHeader>(
      `UPDATE user_mfa
          SET locked_until = IF(failed_attempts + 1 >= :max, :lockUntil, locked_until),
              failed_attempts = IF(failed_attempts + 1 >= :max, 0, failed_attempts + 1)
        WHERE id = :id`,
      { id, max: MFA_MAX_ATTEMPTS, lockUntil },
    );
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT (locked_until IS NOT NULL AND locked_until > :now) AS locked
         FROM user_mfa WHERE id = :id`,
      { id, now },
    );
    return Number(rows[0]?.locked ?? 0) === 1;
  },

  /** Troca os códigos de recuperação (os anteriores deixam de valer). Só na 2FA ativa. */
  async replaceRecoveryCodes(id: number, recoveryCodes: StoredRecoveryCode[]): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE user_mfa SET recovery_codes = :codes WHERE id = :id AND is_enabled = 1`,
      { id, codes: JSON.stringify(recoveryCodes) },
    );
    return res.affectedRows > 0;
  },

  /** Apaga a 2FA da conta (desativar, ou o reset pelo atendimento). Devolve quantas linhas saíram. */
  async deleteForUser(userId: number): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `DELETE FROM user_mfa WHERE user_id = :userId`,
      { userId },
    );
    return res.affectedRows;
  },
};
