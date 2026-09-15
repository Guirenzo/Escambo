import type { RowDataPacket } from 'mysql2';
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
