import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface SettingRow extends RowDataPacket {
  key_name: string;
  value: string;
  type: string;
  updated_at: Date | null;
  updated_by_email: string | null;
}

/**
 * Configurações globais da plataforma (`platform_settings`, carregadas pelo seed):
 * taxa, mínimos, dias de aprovação tácita, raio do ranking etc.
 * Leitura simples com fallback — a plataforma nunca deve parar por falta de uma chave.
 */
export const settingsRepository = {
  async get(key: string): Promise<string | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT value FROM platform_settings WHERE key_name = :key LIMIT 1`,
      { key },
    );
    return rows[0] ? String(rows[0].value) : null;
  },

  async getNumber(key: string, fallback: number): Promise<number> {
    const raw = await this.get(key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  },

  /** Grava (ou cria) uma chave — usado por jobs para guardar estado que sobrevive a reinícios. */
  async set(
    key: string,
    value: string,
    type: 'string' | 'integer' | 'decimal' | 'boolean' | 'json' = 'string',
    updatedBy: number | null = null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO platform_settings (key_name, value, type, updated_by)
       VALUES (:key, :value, :type, :updatedBy)
       ON DUPLICATE KEY UPDATE value = :value, updated_by = :updatedBy`,
      { key, value, type, updatedBy },
    );
  },

  /**
   * Grava só se o valor atual for `expected` (null = a chave não existe): a trava de jobs que podem
   * rodar em duas instâncias (ADR 54 e 55). Devolve se esta chamada foi a que gravou.
   */
  async setIf(
    key: string,
    value: string,
    expected: string | null,
    type: 'string' | 'integer' | 'decimal' | 'boolean' | 'json' = 'json',
  ): Promise<boolean> {
    if (expected === null) {
      // INSERT puro: a chave duplicada é a outra instância que chegou antes. ON DUPLICATE KEY
      // UPDATE não serve aqui: com o CLIENT_FOUND_ROWS que o mysql2 liga por padrão, a linha que já
      // existia também conta 1 em affectedRows, e as duas instâncias achariam que ganharam.
      try {
        await pool.query(
          `INSERT INTO platform_settings (key_name, value, type) VALUES (:key, :value, :type)`,
          { key, value, type },
        );
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === 'ER_DUP_ENTRY') return false;
        throw err;
      }
    }
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE platform_settings SET value = :value WHERE key_name = :key AND value = :expected`,
      { key, value, expected },
    );
    return res.affectedRows > 0;
  },

  /** Linhas de várias chaves, com o e-mail de quem mudou por último (painel admin). */
  async list(keys: string[]): Promise<SettingRow[]> {
    if (keys.length === 0) return [];
    const [rows] = await pool.query<SettingRow[]>(
      `SELECT s.key_name, s.value, s.type, s.updated_at, u.email AS updated_by_email
         FROM platform_settings s
         LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.key_name IN (${keys.map(() => '?').join(', ')})`,
      keys,
    );
    return rows;
  },
};
