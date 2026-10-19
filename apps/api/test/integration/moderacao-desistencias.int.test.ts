import type { ModerationHealth } from '@escambo/types';
import jwt from 'jsonwebtoken';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { env } from '../../src/config/env';
import { runModerationSlaReport } from '../../src/jobs/moderation-sla-report';
import { dayKey, startOfTodayBrt } from '../../src/modules/reports/moderation.day';
import { moderationHealthService } from '../../src/modules/reports/moderation.health';
import { REPORT_STATE_KEY } from '../../src/modules/reports/moderation.sla-state';
import { settingsRepository } from '../../src/modules/settings/settings.repository';
import { settingsService } from '../../src/modules/settings/settings.service';

const app = createApp();
const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });
const HOUR = 3_600_000;
const NOW = new Date(startOfTodayBrt(new Date()).getTime() + 12 * HOUR);
const REVIEWED_AT = new Date(NOW.getTime() - 24 * HOUR);
const CREATED_AT = new Date(REVIEWED_AT.getTime() - 72 * HOUR);
const originalSettings = new Map<string, SavedSetting | null>();
const reportsCreated: number[] = [];
let restoreExistingReportDates: (() => Promise<void>) | undefined;

interface SavedReportDates extends RowDataPacket {
  id: number;
  created_at: Date;
  reviewed_at: Date | null;
}

interface SavedSetting extends RowDataPacket {
  id: number;
  key_name: string;
  value: string;
  type: string;
  description: string | null;
  updated_by: number | null;
  updated_at: Date;
}

/**
 * Outras integrações deixam denúncias reais neste database descartável. Só suas datas são
 * retiradas temporariamente da janela/SLA; status, texto, autoria e decisões permanecem.
 * A restauração é por ID, em transação, e roda mesmo se uma assertiva ou hook falhar.
 */
async function isolateExistingReportDates(): Promise<() => Promise<void>> {
  if (env.NODE_ENV !== 'test' || !/^escambo(?:_[a-z0-9]+)*_test$/.test(env.DB_NAME))
    throw new Error(
      'O isolamento da fixture exige o database descartável do harness de integração',
    );
  const [database] = await pool.query<(RowDataPacket & { name: string })[]>(
    'SELECT DATABASE() AS name',
  );
  if (database[0]?.name !== env.DB_NAME)
    throw new Error('A conexão do isolamento não corresponde ao database de teste configurado');

  const connection = await pool.getConnection();
  let rows: SavedReportDates[];
  try {
    await connection.beginTransaction();
    [rows] = await connection.query<SavedReportDates[]>(
      'SELECT id, created_at, reviewed_at FROM content_reports ORDER BY id FOR UPDATE',
    );
    if (rows.length) {
      const outsideWindow = new Date(Math.max(Date.now(), NOW.getTime()) + 366 * 24 * HOUR);
      await connection.query(
        `UPDATE content_reports SET created_at = :outsideWindow,
          reviewed_at = IF(reviewed_at IS NULL, NULL, :outsideWindow) WHERE id IN (:ids)`,
        { outsideWindow, ids: rows.map((row) => row.id) },
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return async () => {
    if (!rows.length) return;
    const restore = await pool.getConnection();
    try {
      await restore.beginTransaction();
      const [found] = await restore.query<RowDataPacket[]>(
        'SELECT id FROM content_reports WHERE id IN (:ids) FOR UPDATE',
        { ids: rows.map((row) => row.id) },
      );
      if (found.length !== rows.length) throw new Error('Uma denúncia preexistente desapareceu');
      for (const row of rows)
        await restore.query(
          'UPDATE content_reports SET created_at = :createdAt, reviewed_at = :reviewedAt WHERE id = :id',
          {
            id: row.id,
            createdAt: row.created_at,
            reviewedAt: row.reviewed_at,
          },
        );
      await restore.commit();
    } catch (error) {
      await restore.rollback();
      throw error;
    } finally {
      restore.release();
    }
  };
}

interface Actor {
  id: number;
  token: string;
}

let admin: Actor;
let reporter: Actor;
let freelancer: Actor;

async function actor(role: 'admin' | 'client' | 'freelancer'): Promise<Actor> {
  const key = ulid();
  const [created] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (ulid, email, role, status, timezone)
      VALUES (:key, :email, :role, 'active', 'America/Sao_Paulo')`,
    { key, email: `adr61-sla-${key}@escambo.test`, role },
  );
  return {
    id: created.insertId,
    token: jwt.sign({ sub: key, uid: created.insertId, role }, env.JWT_SECRET, {
      expiresIn: '1h',
    }),
  };
}

async function health(): Promise<ModerationHealth> {
  const response = await request(app)
    .get('/api/admin/moderation/health?days=7')
    .set(auth(admin))
    .expect(200);
  return response.body as ModerationHealth;
}

async function reportMails(): Promise<number> {
  const [rows] = await pool.query<(RowDataPacket & { count: number })[]>(
    "SELECT COUNT(*) AS count FROM email_outbox WHERE user_id = :admin AND template = 'moderation_report'",
    { admin: admin.id },
  );
  return Number(rows[0]!.count);
}

/** A decisão passa pela rota real; só os instantes desse registro fictício são históricos. */
async function dismissYesterday(id: number): Promise<void> {
  await request(app)
    .post(`/api/admin/reports/${id}/dismiss`)
    .set(auth(admin))
    .send({ note: 'Revisão humana encerrada com justificativa fictícia' })
    .expect(200);
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT status, reviewed_by, reviewed_at FROM content_reports WHERE id = :id',
    { id },
  );
  expect(rows[0]).toMatchObject({ status: 'dismissed', reviewed_by: admin.id });
  expect(rows[0]!.reviewed_at).toBeInstanceOf(Date);
  await pool.query('UPDATE content_reports SET reviewed_at = :at WHERE id = :id', {
    id,
    at: REVIEWED_AT,
  });
}

beforeAll(async () => {
  restoreExistingReportDates = await isolateExistingReportDates();
  admin = await actor('admin');
  reporter = await actor('client');
  freelancer = await actor('freelancer');
  for (const key of ['moderation_sla_hours', 'moderation_sla_report_enabled', REPORT_STATE_KEY]) {
    const [rows] = await pool.query<SavedSetting[]>(
      'SELECT * FROM platform_settings WHERE key_name = :key',
      { key },
    );
    originalSettings.set(key, rows[0] ?? null);
  }
  await settingsRepository.set('moderation_sla_hours', '24', 'integer');
  await settingsRepository.set('moderation_sla_report_enabled', 'true', 'boolean');
  await pool.query('DELETE FROM platform_settings WHERE key_name = :key', {
    key: REPORT_STATE_KEY,
  });
  settingsService.clearCache();
});

afterEach(async () => {
  if (reportsCreated.length) {
    await pool.query('DELETE FROM content_reports WHERE id IN (:ids)', {
      ids: reportsCreated,
    });
    reportsCreated.length = 0;
  }
  if (originalSettings.has(REPORT_STATE_KEY))
    await pool.query('DELETE FROM platform_settings WHERE key_name = :key', {
      key: REPORT_STATE_KEY,
    });
});

afterAll(async () => {
  try {
    for (const [key, row] of originalSettings) {
      if (row === null)
        await pool.query('DELETE FROM platform_settings WHERE key_name = :key', { key });
      else
        await pool.query(
          `INSERT INTO platform_settings
            (id, key_name, value, type, description, updated_by, updated_at)
            VALUES (:id, :key_name, :value, :type, :description, :updated_by, :updated_at)
            ON DUPLICATE KEY UPDATE id = :id, value = :value, type = :type, description = :description,
              updated_by = :updated_by, updated_at = :updated_at`,
          row,
        );
    }
  } finally {
    try {
      await restoreExistingReportDates?.();
    } finally {
      settingsService.clearCache();
      await pool.end();
    }
  }
});

describe('ADR 61 / G.6.12: revisões humanas fora das automáticas e da meta', () => {
  it.each([
    ['Desistências:', 'system'],
    ['Reincidência:', 'system'],
    ['Desistências:', 'legacy-admin'],
    ['Reincidência:', 'legacy-admin'],
  ] as const)(
    'revisão %s de origem %s encerrada em 72h não dispara a meta de 24h',
    async (prefix, origin) => {
      const before = await health();
      const mailCount = await reportMails();
      // A revisão do sistema/administrador legado não tem rota pública de criação.
      const [created] = await pool.query<ResultSetHeader>(
        `INSERT INTO content_reports
          (reporter_id, target_type, target_id, reason, description, status, created_at)
          VALUES (:reporter, 'user', :freelancer, 'other', :description, 'pending', :createdAt)`,
        {
          reporter: origin === 'system' ? null : admin.id,
          freelancer: freelancer.id,
          description: `${prefix} revisão humana fictícia da conta`,
          createdAt: CREATED_AT,
        },
      );
      reportsCreated.push(created.insertId);
      const open = await health();
      expect(open.queue.accountReviewsOpen).toBe(before.queue.accountReviewsOpen + 1);
      expect(open.queue.automaticPending).toBe(before.queue.automaticPending);
      expect(open.queue.overSlaPending).toBe(before.queue.overSlaPending);

      await dismissYesterday(created.insertId);
      const result = await runModerationSlaReport(NOW);
      expect.soft(result.skipped).toBeNull();
      expect.soft(result).toMatchObject({
        breached: false,
        slow: false,
        waiting: false,
        delivered: 0,
      });
      expect.soft(await reportMails()).toBe(mailCount);
      const after = await health();
      expect.soft(after.queue.accountReviewsOpen).toBe(before.queue.accountReviewsOpen);
      expect.soft(after.automatic).toEqual(before.automatic);
      expect.soft(after.decisions).toEqual(before.decisions);
      const series = await moderationHealthService.history(1, NOW);
      const yesterday = series.history.find((day) => day.day === dayKey(REVIEWED_AT))!;
      expect.soft(yesterday).toMatchObject({ actioned: 0, dismissed: 0, medianHours: null });
    },
  );

  it.each(['Desistências:', 'Reincidência:'] as const)(
    'denúncia humana imitando %s continua na meta e sua decisão em 72h dispara o relatório',
    async (prefix) => {
      const before = await health();
      const mailCount = await reportMails();
      const created = await request(app)
        .post('/api/reports')
        .set(auth(reporter))
        .send({
          targetType: 'user',
          targetId: freelancer.id,
          reason: 'other',
          description: `${prefix} relato humano que não é uma revisão da equipe`,
        })
        .expect(201);
      const id = created.body.id as number;
      reportsCreated.push(id);
      await pool.query('UPDATE content_reports SET created_at = :at WHERE id = :id', {
        id,
        at: CREATED_AT,
      });
      const open = await health();
      expect(open.queue.accountReviewsOpen).toBe(before.queue.accountReviewsOpen);
      expect(open.queue.overSlaPending).toBe(before.queue.overSlaPending + 1);
      await dismissYesterday(id);

      const result = await runModerationSlaReport(NOW);
      expect(result.skipped).toBeNull();
      expect(result).toMatchObject({
        breached: true,
        slow: true,
        waiting: false,
      });
      expect(result.delivered).toBeGreaterThanOrEqual(1);
      expect(await reportMails()).toBe(mailCount + 1);
      const after = await health();
      expect(after.decisions.total).toBe(before.decisions.total + 1);
      expect(after.decisions.medianHours).toBe(72);
      const series = await moderationHealthService.history(1, NOW);
      const yesterday = series.history.find((day) => day.day === dayKey(REVIEWED_AT))!;
      expect(yesterday).toMatchObject({
        actioned: 0,
        dismissed: 1,
        medianHours: 72,
      });
    },
  );
});
