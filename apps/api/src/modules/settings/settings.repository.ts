import type { RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

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
    type: 'string' | 'integer' | 'json' = 'string',
  ): Promise<void> {
    await pool.query(
      `INSERT INTO platform_settings (key_name, value, type) VALUES (:key, :value, :type)
       ON DUPLICATE KEY UPDATE value = :value`,
      { key, value, type },
    );
  },
};
