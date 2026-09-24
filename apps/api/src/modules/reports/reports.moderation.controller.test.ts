import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

vi.mock('./moderation.health', () => ({
  moderationHealthService: { history: vi.fn(), report: vi.fn() },
}));
vi.mock('../admin/admin.repository', () => ({
  adminRepository: { recordAction: vi.fn() },
}));

import { adminRepository } from '../admin/admin.repository';
import { moderationHealthService } from './moderation.health';
import { exportModerationHealthCsv } from './reports.moderation.controller';

const health = vi.mocked(moderationHealthService);
const admin = vi.mocked(adminRepository);

const res = () => {
  const r = { setHeader: vi.fn(), send: vi.fn() };
  return r as unknown as Response & typeof r;
};
const req = (query: Record<string, string>) => ({ query, user: { uid: 7 } }) as unknown as Request;

beforeEach(() => vi.clearAllMocks());

/** GET /api/admin/moderation/health/export.csv (ADR 55). */
describe('exportModerationHealthCsv', () => {
  it('devolve o CSV da série com o nome pelas pontas e registra a exportação nas ações do admin', async () => {
    health.history.mockResolvedValue({
      history: [
        { day: '2026-09-18', received: 1, flagged: 0, actioned: 1, dismissed: 0, medianHours: 2 },
        {
          day: '2026-09-24',
          received: 0,
          flagged: 0,
          actioned: 0,
          dismissed: 0,
          medianHours: null,
        },
      ],
      slaHours: 24,
    });
    const r = res();
    await exportModerationHealthCsv(req({ days: '7' }), r);

    expect(health.history).toHaveBeenCalledWith(7);
    expect(r.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(r.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="escambo-moderacao-2026-09-18_2026-09-24.csv"',
    );
    const body = r.send.mock.calls[0]![0] as string;
    expect(body.startsWith('﻿dia;denuncias_recebidas;')).toBe(true);
    expect(body).toContain('2026-09-18;1;0;1;0;1;2,0;24;nao\r\n');
    expect(admin.recordAction).toHaveBeenCalledWith(
      7,
      'moderation_health_exported',
      'moderation',
      null,
      '7 dias · 2026-09-18 → 2026-09-24',
    );
  });

  it('sem ?days usa 30; fora de 1..365 é erro de validação (422 no handler)', async () => {
    health.history.mockResolvedValue({ history: [], slaHours: 24 });
    await exportModerationHealthCsv(req({}), res());
    expect(health.history).toHaveBeenCalledWith(30);
    await expect(exportModerationHealthCsv(req({ days: '0' }), res())).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(exportModerationHealthCsv(req({ days: '400' }), res())).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(admin.recordAction).toHaveBeenCalledTimes(1);
  });
});
