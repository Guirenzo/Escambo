import type { SavedSearchAlertFrequency } from '@escambo/types';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface SavedSearchRow extends RowDataPacket {
  id: number;
  user_id: number;
  name: string | null;
  query: string | null;
  filters: string | Record<string, unknown> | null;
  alert_enabled: number;
  /** Quando avisar (ADR 37). Desligar o alerta não apaga a escolha. */
  alert_frequency: SavedSearchAlertFrequency;
  /** Cursor do alerta (ADR 35): serviços criados a partir daqui entram no próximo aviso. */
  last_alert_at: Date | null;
  created_at: Date;
}

/** Até onde o cursor precisa ter ficado, por frequência, para a busca entrar na rodada (ADR 37). */
export interface AlertDueThresholds {
  instant: Date;
  hourly: Date;
  /**
   * Diária (ADR 42): o limite depende da hora do resumo de cada dono, então vão o começo do dia de
   * Brasília da janela, a hora da janela e a hora padrão, e a consulta calcula o de cada um.
   */
  daily: { dayStart: Date; hourNow: number; defaultHour: number };
}

const COLS =
  'id, user_id, name, query, filters, alert_enabled, alert_frequency, last_alert_at, created_at';

export const savedSearchesRepository = {
  /** Com alerta ligado, o cursor começa agora: o primeiro aviso não despeja o catálogo antigo. */
  async create(d: {
    userId: number;
    name: string | null;
    query: string | null;
    filters: string | null;
    alertEnabled: boolean;
    alertFrequency: SavedSearchAlertFrequency;
  }): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO saved_searches
         (user_id, name, query, filters, alert_enabled, alert_frequency, last_alert_at)
       VALUES (:userId, :name, :query, :filters, :alertEnabled, :alertFrequency,
               IF(:alertEnabled, NOW(), NULL))`,
      d,
    );
    return res.insertId;
  },

  async countForUser(userId: number): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM saved_searches WHERE user_id = :userId`,
      { userId },
    );
    return Number(rows[0]?.n ?? 0);
  },

  async findForUser(id: number, userId: number): Promise<SavedSearchRow | undefined> {
    const [rows] = await pool.query<SavedSearchRow[]>(
      `SELECT ${COLS} FROM saved_searches WHERE id = :id AND user_id = :userId LIMIT 1`,
      { id, userId },
    );
    return rows[0];
  },

  async listForUser(userId: number): Promise<SavedSearchRow[]> {
    const [rows] = await pool.query<SavedSearchRow[]>(
      `SELECT ${COLS} FROM saved_searches WHERE user_id = :userId ORDER BY id DESC`,
      { userId },
    );
    return rows;
  },

  /**
   * Renomeia (null volta a mostrar o texto buscado), liga/desliga o alerta e troca a frequência.
   * Ligar (de desligado) reinicia o cursor em agora. Trocar só a frequência mantém o cursor: a
   * próxima rodada da frequência nova cobre desde o último aviso, sem buraco nem repetição.
   */
  async update(
    id: number,
    userId: number,
    d: {
      name?: string | null;
      alertEnabled?: boolean;
      alertFrequency?: SavedSearchAlertFrequency;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { id, userId };
    if (d.name !== undefined) {
      sets.push('name = :name');
      params.name = d.name?.trim() || null;
    }
    if (d.alertEnabled !== undefined) {
      // O MySQL avalia da esquerda para a direita: o cursor ainda enxerga o alert_enabled antigo.
      sets.push(
        'last_alert_at = IF(:alertEnabled = 1 AND alert_enabled = 0, NOW(), last_alert_at)',
        'alert_enabled = :alertEnabled',
      );
      params.alertEnabled = d.alertEnabled ? 1 : 0;
    }
    if (d.alertFrequency !== undefined) {
      sets.push('alert_frequency = :alertFrequency');
      params.alertFrequency = d.alertFrequency;
    }
    if (sets.length === 0) return;
    await pool.query<ResultSetHeader>(
      `UPDATE saved_searches SET ${sets.join(', ')} WHERE id = :id AND user_id = :userId`,
      params,
    );
  },

  async remove(id: number, userId: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `DELETE FROM saved_searches WHERE id = :id AND user_id = :userId`,
      { id, userId },
    );
    return res.affectedRows > 0;
  },

  /**
   * Buscas com alerta cujo cursor ficou até o limite da sua frequência (ADR 37), das contas que
   * podem receber aviso: fora suspensas, banidas e excluídas. As mais atrasadas primeiro, então
   * as buscas "na hora", conferidas a toda rodada, nunca passam na frente de uma diária vencida.
   */
  async dueForAlert(due: AlertDueThresholds, limit: number): Promise<SavedSearchRow[]> {
    // limit é uma constante do job (inteiro) — seguro para interpolar.
    const [rows] = await pool.query<SavedSearchRow[]>(
      `SELECT s.id, s.user_id, s.name, s.query, s.filters, s.alert_enabled, s.alert_frequency,
              s.last_alert_at, s.created_at
         FROM saved_searches s
         JOIN users u ON u.id = s.user_id
        WHERE s.alert_enabled = 1
          AND u.deleted_at IS NULL
          AND u.status NOT IN ('suspended', 'banned')
          AND COALESCE(s.last_alert_at, s.created_at) <= CASE s.alert_frequency
                WHEN 'instant' THEN CAST(:instant AS DATETIME)
                WHEN 'daily' THEN DATE_SUB(
                  DATE_ADD(CAST(:dayStart AS DATETIME), INTERVAL COALESCE(u.digest_hour, :defaultHour) HOUR),
                  INTERVAL IF(COALESCE(u.digest_hour, :defaultHour) <= :hourNow, 1, 86401) SECOND
                )
                ELSE CAST(:hourly AS DATETIME)
              END
        ORDER BY COALESCE(s.last_alert_at, s.created_at) ASC, s.id ASC
        LIMIT ${Math.trunc(limit)}`,
      // Diária: o horário do dono hoje, se já passou, senão o de ontem, menos um segundo.
      {
        instant: due.instant,
        hourly: due.hourly,
        dayStart: due.daily.dayStart,
        hourNow: due.daily.hourNow,
        defaultHour: due.daily.defaultHour,
      },
    );
    return rows;
  },

  async advanceCursor(id: number, to: Date): Promise<void> {
    await pool.query<ResultSetHeader>(
      `UPDATE saved_searches SET last_alert_at = :to WHERE id = :id`,
      { id, to },
    );
  },
};
