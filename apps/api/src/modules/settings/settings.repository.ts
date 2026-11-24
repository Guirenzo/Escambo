/**
 * Repository dos parâmetros da plataforma (camada de repository): o único arquivo do módulo que
 * escreve SQL. Fala com a tabela `platform_settings`, que tem uma linha por chave (key_name único),
 * o valor em texto, o tipo, quem mudou por último (updated_by) e quando (updated_at, que o próprio
 * MySQL atualiza a cada mudança).
 * Quem chama: o settingsService (com cache) e a settingsFacade (leitura na hora, para os jobs).
 * Dentro: get (valor cru), getNumber (número com padrão), set (grava ou cria), setIf (grava só se
 * o valor atual for o esperado, a trava dos jobs) e list (várias chaves com o e-mail do autor).
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { parseNumberSetting } from './settings.parse';

// Uma linha de platform_settings, mais o e-mail do autor que vem do JOIN com users no list().
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
  /** Valor cru (texto) de uma chave, ou null se a linha não existe. Não converte nem usa cache. */
  async get(key: string): Promise<string | null> {
    // Busca a linha pela chave (key_name é único, então no máximo uma).
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT value FROM platform_settings WHERE key_name = :key LIMIT 1`,
      { key },
    );
    return rows[0] ? String(rows[0].value) : null;
  },

  /**
   * Número de uma chave, ou o `fallback` de quem pergunta quando falta ou não é número. A conversão
   * é a mesma do settingsService (settings.parse), para o job e a tela verem o mesmo valor.
   */
  async getNumber(key: string, fallback: number): Promise<number> {
    return parseNumberSetting(await this.get(key), fallback, key);
  },

  /** Grava (ou cria) uma chave — usado por jobs para guardar estado que sobrevive a reinícios. */
  async set(
    key: string,
    value: string,
    type: 'string' | 'integer' | 'decimal' | 'boolean' | 'json' = 'string',
    updatedBy: number | null = null,
  ): Promise<void> {
    // Um comando só faz as duas coisas: cria a linha se a chave é nova e, se a chave já existe
    // (chave única duplicada), só troca o valor e o autor. Também é o que o painel do admin usa.
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
    // Chave que já existe: troca o valor só se ele ainda for o esperado. Se outra instância mudou
    // antes, o filtro não acha a linha, nada muda e affectedRows vem 0 (esta chamada perdeu).
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE platform_settings SET value = :value WHERE key_name = :key AND value = :expected`,
      { key, value, expected },
    );
    return res.affectedRows > 0;
  },

  /** Linhas de várias chaves, com o e-mail de quem mudou por último (painel admin). */
  async list(keys: string[]): Promise<SettingRow[]> {
    // Lista vazia não vai ao banco (o filtro de lista vazia seria SQL inválido).
    if (keys.length === 0) return [];
    // Um `?` por chave no filtro, com as chaves passadas como parâmetros (nada colado no SQL).
    // O LEFT JOIN traz o e-mail do admin que mudou; chave nunca mudada pelo painel vem com null.
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
