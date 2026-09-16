import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./notifications.repository', () => ({
  notificationsRepository: {
    create: vi.fn().mockResolvedValue(1),
    listSince: vi.fn(),
    markDigest: vi.fn(),
  },
}));
vi.mock('../auth/auth.repository', () => ({
  authRepository: { findById: vi.fn(), setEmailPreference: vi.fn() },
}));
vi.mock('../mail/mail.service', () => ({
  EMAILED_NOTIFICATION_TYPES: new Set(['contract_proposal']),
  mailService: { enabled: () => true, send: vi.fn().mockResolvedValue(5) },
  notificationLink: (data: { contractId?: number } | null) =>
    data?.contractId
      ? `http://app.escambo.test/contratos/${data.contractId}`
      : 'http://app.escambo.test/notificacoes',
}));
vi.mock('../../config/realtime', () => ({ realtime: { emitToUser: vi.fn() } }));

import { env } from '../../config/env';
import { authRepository } from '../auth/auth.repository';
import { mailService } from '../mail/mail.service';
import { notificationsRepository, type NotificationRow } from './notifications.repository';
import { notificationsService } from './notifications.service';

const users = vi.mocked(authRepository);
const repo = vi.mocked(notificationsRepository);
const send = vi.mocked(mailService.send);

const user = (email_frequency: 'instant' | 'daily' | 'off', digest_hour: number | null = null) =>
  ({ id: 7, email: 'f@escambo.test', deleted_at: null, email_frequency, digest_hour }) as never;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.clearAllMocks());

describe('preferência de e-mail (ADR 27)', () => {
  it('e-mail por evento só para quem está em "instant"', async () => {
    users.findById.mockResolvedValue(user('instant'));
    await notificationsService.notify(7, { type: 'contract_proposal', title: 'Nova proposta' });
    await flush();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ template: 'notification' }));

    for (const pref of ['daily', 'off'] as const) {
      send.mockClear();
      users.findById.mockResolvedValue(user(pref));
      await notificationsService.notify(7, { type: 'contract_proposal', title: 'Nova proposta' });
      await flush();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('get/set da preferência passam pelo repositório de usuários; sem hora escolhida vale a padrão', async () => {
    users.findById.mockResolvedValue(user('daily'));
    expect(await notificationsService.getEmailPreference(7)).toEqual({
      emailFrequency: 'daily',
      digestHour: env.DIGEST_HOUR,
      timezone: 'America/Sao_Paulo',
    });

    users.findById.mockResolvedValue(user('off', 20));
    expect(
      await notificationsService.setEmailPreference(7, { emailFrequency: 'off', digestHour: 20 }),
    ).toEqual({ emailFrequency: 'off', digestHour: 20, timezone: 'America/Sao_Paulo' });
    expect(users.setEmailPreference).toHaveBeenCalledWith(7, {
      emailFrequency: 'off',
      digestHour: 20,
    });
  });

  it('sendDigest junta as notificações desde o último resumo num e-mail só e marca o dia', async () => {
    const now = new Date('2026-09-14T15:00:00Z');
    const rows = [
      {
        id: 1,
        type: 'contract_proposal',
        title: 'Nova proposta',
        body: 'Site',
        data: '{"contractId":9}',
        is_read: 0,
        created_at: now,
      },
      {
        id: 2,
        type: 'contract_accepted',
        title: 'Aceita',
        body: null,
        data: null,
        is_read: 0,
        created_at: now,
      },
    ] as unknown as NotificationRow[];
    repo.listSince.mockResolvedValue(rows);

    const count = await notificationsService.sendDigest(
      { id: 7, email: 'f@escambo.test', last_digest_at: new Date('2026-09-13T11:00:00Z') },
      now,
    );

    expect(count).toBe(2);
    expect(repo.listSince).toHaveBeenCalledWith(7, new Date('2026-09-13T11:00:00Z'));
    expect(send).toHaveBeenCalledWith({
      userId: 7,
      to: 'f@escambo.test',
      template: 'digest',
      vars: {
        items: [
          { title: 'Nova proposta', body: 'Site', link: 'http://app.escambo.test/contratos/9' },
          { title: 'Aceita', body: null, link: 'http://app.escambo.test/notificacoes' },
        ],
      },
    });
    expect(repo.markDigest).toHaveBeenCalledWith(7, now);

    // Sem novidades: nada enviado, mas o dia fica marcado (não varre de novo a cada rodada).
    send.mockClear();
    repo.listSince.mockResolvedValue([]);
    expect(
      await notificationsService.sendDigest(
        { id: 7, email: 'f@escambo.test', last_digest_at: null },
        now,
      ),
    ).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(repo.listSince).toHaveBeenLastCalledWith(7, new Date('2026-09-13T15:00:00Z')); // últimas 24h
    expect(repo.markDigest).toHaveBeenLastCalledWith(7, now);
  });
});
