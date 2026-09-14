import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/mail/mail.service', () => ({
  mailService: { enabled: vi.fn() },
}));
vi.mock('../modules/notifications/notifications.repository', () => ({
  notificationsRepository: { usersForDigest: vi.fn() },
}));
vi.mock('../modules/notifications/notifications.service', () => ({
  notificationsService: { sendDigest: vi.fn() },
}));

import { mailService } from '../modules/mail/mail.service';
import { notificationsRepository } from '../modules/notifications/notifications.repository';
import { notificationsService } from '../modules/notifications/notifications.service';
import { hourInBrt, runDailyDigest, startOfTodayBrt } from './daily-digest';

const mail = vi.mocked(mailService);
const repo = vi.mocked(notificationsRepository);
const svc = vi.mocked(notificationsService);

// 12:00 em Brasília = 15:00Z (DIGEST_HOUR padrão é 8)
const NOON_BRT = new Date('2026-09-14T15:00:00Z');
const DAWN_BRT = new Date('2026-09-14T06:30:00Z'); // 03:30 em Brasília

beforeEach(() => {
  vi.clearAllMocks();
  mail.enabled.mockReturnValue(true);
  repo.usersForDigest.mockResolvedValue([]);
});

describe('hora e dia em Brasília', () => {
  it('converte UTC para a hora local e acha o começo do dia', () => {
    expect(hourInBrt(NOON_BRT)).toBe(12);
    expect(hourInBrt(new Date('2026-09-14T01:00:00Z'))).toBe(22); // ainda o dia anterior em Brasília
    expect(startOfTodayBrt(NOON_BRT).toISOString()).toBe('2026-09-14T03:00:00.000Z');
    expect(startOfTodayBrt(new Date('2026-09-14T01:00:00Z')).toISOString()).toBe(
      '2026-09-13T03:00:00.000Z',
    );
  });
});

describe('runDailyDigest', () => {
  it('não faz nada com o e-mail desligado ou antes da hora', async () => {
    mail.enabled.mockReturnValue(false);
    expect((await runDailyDigest(NOON_BRT)).skipped).toBe('mail_off');
    mail.enabled.mockReturnValue(true);
    expect((await runDailyDigest(DAWN_BRT)).skipped).toBe('before_hour');
    expect(repo.usersForDigest).not.toHaveBeenCalled();
  });

  it('a partir da hora, um resumo por usuário elegível; sem novidades só marca o dia', async () => {
    const u1 = { id: 1, email: 'a@escambo.test', last_digest_at: null };
    const u2 = { id: 2, email: 'b@escambo.test', last_digest_at: new Date('2026-09-13T11:00:00Z') };
    const u3 = { id: 3, email: 'c@escambo.test', last_digest_at: null };
    repo.usersForDigest.mockResolvedValue([u1, u2, u3] as never);
    svc.sendDigest
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('smtp'));

    const r = await runDailyDigest(NOON_BRT);

    expect(repo.usersForDigest).toHaveBeenCalledWith(new Date('2026-09-14T03:00:00.000Z'));
    expect(svc.sendDigest).toHaveBeenCalledWith(u1, NOON_BRT);
    expect(r).toEqual({ skipped: null, sent: [1], empty: [2], failed: [3] });
  });
});
