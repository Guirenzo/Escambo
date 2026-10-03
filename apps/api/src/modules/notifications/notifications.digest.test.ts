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
import { logger } from '../../config/logger';
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

  it('o e-mail por evento vai para o endereço da conta, com o título, o corpo e o link do assunto', async () => {
    users.findById.mockResolvedValue(user('instant'));

    await notificationsService.notify(7, {
      type: 'contract_proposal',
      title: 'Nova proposta',
      body: 'Landing page',
      data: { contractId: 9 },
    });
    await flush();

    expect(users.findById).toHaveBeenCalledWith(7);
    expect(send.mock.calls).toEqual([
      [
        {
          userId: 7,
          to: 'f@escambo.test',
          template: 'notification',
          vars: {
            title: 'Nova proposta',
            body: 'Landing page',
            link: 'http://app.escambo.test/contratos/9',
          },
        },
      ],
    ]);
  });

  it('conta antiga sem preferência gravada recebe por evento; sem corpo, o e-mail leva corpo nulo', async () => {
    users.findById.mockResolvedValue({
      id: 7,
      email: 'f@escambo.test',
      deleted_at: null,
    } as never);

    await notificationsService.notify(7, { type: 'contract_proposal', title: 'Nova proposta' });
    await flush();

    expect(send.mock.calls).toEqual([
      [
        {
          userId: 7,
          to: 'f@escambo.test',
          template: 'notification',
          vars: {
            title: 'Nova proposta',
            body: null,
            link: 'http://app.escambo.test/notificacoes',
          },
        },
      ],
    ]);
  });

  it('tipo que não vai por e-mail (chat) nem consulta a conta; conta encerrada ou inexistente não recebe', async () => {
    await notificationsService.notify(7, { type: 'message_received', title: 'Nova mensagem' });
    await flush();
    expect(users.findById).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    users.findById.mockResolvedValue({
      id: 7,
      email: 'f@escambo.test',
      deleted_at: new Date('2026-09-01T00:00:00Z'),
      email_frequency: 'instant',
    } as never);
    await notificationsService.notify(7, { type: 'contract_proposal', title: 'Nova proposta' });
    await flush();
    expect(users.findById).toHaveBeenCalledWith(7);
    expect(send).not.toHaveBeenCalled();

    users.findById.mockResolvedValue(undefined);
    await notificationsService.notify(7, { type: 'contract_proposal', title: 'Nova proposta' });
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('falha no e-mail da notificação fica só no log: a notificação in-app foi criada e quem notificou segue', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const down = new Error('banco fora');
    users.findById.mockRejectedValueOnce(down);

    await expect(
      notificationsService.notify(7, { type: 'contract_proposal', title: 'Nova proposta' }),
    ).resolves.toBeUndefined();
    await flush();

    expect(repo.create).toHaveBeenCalledWith({
      userId: 7,
      type: 'contract_proposal',
      title: 'Nova proposta',
      body: null,
      data: null,
    });
    expect(send).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      [{ err: down, type: 'contract_proposal' }, 'e-mail da notificação falhou'],
    ]);
    warn.mockRestore();
  });

  it('a preferência lida traz o fuso, a janela de silêncio e o que sai nela como a conta gravou (ADR 46, 54 e 56)', async () => {
    users.findById.mockResolvedValue({
      id: 7,
      email: 'f@escambo.test',
      deleted_at: null,
      email_frequency: 'instant',
      digest_hour: 0,
      timezone: 'America/Manaus',
      push_quiet_start: 22,
      push_quiet_end: 7,
      push_quiet_pass: 'deadline',
    } as never);

    expect(await notificationsService.getEmailPreference(7)).toEqual({
      emailFrequency: 'instant',
      // Meia-noite é uma hora escolhida, não "sem hora": não cai na padrão da plataforma.
      digestHour: 0,
      timezone: 'America/Manaus',
      quietHours: { start: 22, end: 7 },
      quietPass: ['deadline'],
    });
    expect(users.findById).toHaveBeenCalledWith(7);
  });

  it('conta que não existe mais lê os padrões (por evento, hora da plataforma, Brasília, sem silêncio) em vez de quebrar', async () => {
    users.findById.mockResolvedValue(undefined);

    expect(await notificationsService.getEmailPreference(99)).toEqual({
      emailFrequency: 'instant',
      digestHour: env.DIGEST_HOUR,
      timezone: 'America/Sao_Paulo',
      quietHours: null,
      quietPass: null,
    });
    expect(users.findById).toHaveBeenCalledWith(99);
  });

  it('get/set da preferência passam pelo repositório de usuários; sem hora escolhida vale a padrão', async () => {
    users.findById.mockResolvedValue(user('daily'));
    expect(await notificationsService.getEmailPreference(7)).toEqual({
      emailFrequency: 'daily',
      digestHour: env.DIGEST_HOUR,
      timezone: 'America/Sao_Paulo',
      quietHours: null,
      quietPass: null,
    });

    users.findById.mockResolvedValue(user('off', 20));
    expect(
      await notificationsService.setEmailPreference(7, { emailFrequency: 'off', digestHour: 20 }),
    ).toEqual({
      emailFrequency: 'off',
      digestHour: 20,
      timezone: 'America/Sao_Paulo',
      quietHours: null,
      quietPass: null,
    });
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
