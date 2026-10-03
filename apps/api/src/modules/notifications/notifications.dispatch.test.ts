import type { PoolConnection } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Banco, conta, socket, e-mail e push falsos: o teste confere o que a gravação e o envio pedem a
// cada um. O conjunto do e-mail e o link continuam os de verdade (os tipos do ADR 58 estão nele).
const { repo, users, socket, mail, push } = vi.hoisted(() => ({
  repo: { create: vi.fn() },
  users: { findById: vi.fn() },
  socket: { emitToUser: vi.fn(), emitToContract: vi.fn() },
  mail: { enabled: vi.fn(), send: vi.fn() },
  push: { notify: vi.fn() },
}));
vi.mock('./notifications.repository', () => ({ notificationsRepository: repo }));
vi.mock('../auth/auth.repository', () => ({ authRepository: users }));
vi.mock('../../config/realtime', () => ({ realtime: socket }));
vi.mock('./push.service', () => ({ pushService: push }));
vi.mock('../mail/mail.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mail/mail.service')>()),
  mailService: mail,
}));

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { notificationsService, type SavedNotification } from './notifications.service';

const flush = () => new Promise((r) => setTimeout(r, 0));
const AGORA = new Date('2026-10-01T12:00:00Z');
const appUrl = env.APP_URL;

const conta = {
  id: 7,
  email: 'f@escambo.test',
  deleted_at: null,
  email_frequency: 'instant',
};

const lembrete: SavedNotification = {
  userId: 7,
  id: 41,
  params: {
    type: 'contract_deadline_reminder',
    title: 'Lembrete: Logo',
    body: 'Entregue até sex, 02/10/2026, até 23:59.',
    data: { contractId: 3 },
  },
};

beforeAll(() => {
  env.APP_URL = 'https://app.escambo.test';
});
afterAll(() => {
  env.APP_URL = appUrl;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  users.findById.mockResolvedValue(conta);
  mail.enabled.mockReturnValue(true);
  mail.send.mockResolvedValue(5);
  push.notify.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A gravação dos lembretes (ADR 58): dentro da transação de quem chama, sem enviar nada. */
describe('persist', () => {
  it('grava na conexão de quem chama, com o título cortado, e devolve o que o envio precisa sem enviar nada', async () => {
    const conn = { query: vi.fn() } as unknown as PoolConnection;
    repo.create.mockResolvedValue(41);
    const longo = `Lembrete: ${'a'.repeat(200)}`;
    const cortado = `Lembrete: ${'a'.repeat(139)}…`;

    const saved = await notificationsService.persist(
      7,
      {
        type: 'contract_deadline_reminder',
        title: longo,
        body: 'Entregue até sex, 02/10/2026, até 23:59.',
        data: { contractId: 3 },
      },
      conn,
    );

    expect(cortado).toHaveLength(150);
    expect(repo.create.mock.calls).toEqual([
      [
        {
          userId: 7,
          type: 'contract_deadline_reminder',
          title: cortado,
          body: 'Entregue até sex, 02/10/2026, até 23:59.',
          data: '{"contractId":3}',
        },
        conn,
      ],
    ]);
    expect(repo.create.mock.calls[0]![1]).toBe(conn);
    // O mesmo título cortado segue para o envio (socket, e-mail e push).
    expect(saved).toEqual({
      userId: 7,
      id: 41,
      params: {
        type: 'contract_deadline_reminder',
        title: cortado,
        body: 'Entregue até sex, 02/10/2026, até 23:59.',
        data: { contractId: 3 },
      },
    });
    await flush();
    expect(socket.emitToUser).not.toHaveBeenCalled();
    expect(push.notify).not.toHaveBeenCalled();
    expect(users.findById).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('sem conexão, o repositório grava fora de transação; corpo e dados ausentes vão nulos', async () => {
    repo.create.mockResolvedValue(8);

    const saved = await notificationsService.persist(7, { type: 't', title: 'x'.repeat(150) });

    expect(repo.create.mock.calls).toEqual([
      [{ userId: 7, type: 't', title: 'x'.repeat(150), body: null, data: null }, undefined],
    ]);
    expect(saved.id).toBe(8);
    expect(saved.params.title).toBe('x'.repeat(150));
  });

  it('lança se o banco falhar: quem grava na transação desfaz tudo e tenta na rodada seguinte', async () => {
    const down = new Error('ER_LOCK_DEADLOCK');
    repo.create.mockRejectedValue(down);

    await expect(
      notificationsService.persist(7, { type: 't', title: 'oi' }, {} as PoolConnection),
    ).rejects.toBe(down);
    expect(socket.emitToUser).not.toHaveBeenCalled();
    expect(push.notify).not.toHaveBeenCalled();
  });
});

/** O envio de uma notificação já gravada: socket, e-mail e push, e nunca lança. */
describe('dispatch', () => {
  it('emite no socket, manda o e-mail e o push com o id gravado e a etiqueta própria', async () => {
    expect(notificationsService.dispatch(lembrete, { ownTag: true })).toBeUndefined();

    expect(socket.emitToUser.mock.calls).toEqual([
      [
        7,
        'notification:new',
        {
          id: 41,
          type: 'contract_deadline_reminder',
          title: 'Lembrete: Logo',
          body: 'Entregue até sex, 02/10/2026, até 23:59.',
          data: { contractId: 3 },
          isRead: false,
          createdAt: '2026-10-01T12:00:00.000Z',
        },
      ],
    ]);
    expect(push.notify).toHaveBeenCalledTimes(1);
    expect(push.notify.mock.calls[0]![0]).toBe(7);
    expect(push.notify.mock.calls[0]![1]).toStrictEqual({
      type: 'contract_deadline_reminder',
      title: 'Lembrete: Logo',
      body: 'Entregue até sex, 02/10/2026, até 23:59.',
      data: { contractId: 3 },
      notificationId: 41,
      ownTag: true,
    });
    await flush();
    expect(users.findById).toHaveBeenCalledWith(7);
    expect(mail.send.mock.calls).toEqual([
      [
        {
          userId: 7,
          to: 'f@escambo.test',
          template: 'notification',
          vars: {
            title: 'Lembrete: Logo',
            body: 'Entregue até sex, 02/10/2026, até 23:59.',
            link: 'https://app.escambo.test/contratos/3',
          },
        },
      ],
    ]);
  });

  it('a categoria do silêncio vai só ao push, junto com a etiqueta própria; sem opções (ou ownTag false), nenhuma das duas vai', () => {
    notificationsService.dispatch(lembrete, { passCategory: 'deadline', ownTag: true });
    notificationsService.dispatch(lembrete);
    notificationsService.dispatch(lembrete, { ownTag: false });

    const base = {
      type: 'contract_deadline_reminder',
      title: 'Lembrete: Logo',
      body: 'Entregue até sex, 02/10/2026, até 23:59.',
      data: { contractId: 3 },
      notificationId: 41,
    };
    expect(push.notify.mock.calls.map((c) => c[1])).toStrictEqual([
      { ...base, passCategory: 'deadline', ownTag: true },
      base,
      base,
    ]);
    // O socket não leva nem a categoria nem a etiqueta: são do aparelho.
    for (const call of socket.emitToUser.mock.calls) {
      expect(call[2]).not.toHaveProperty('passCategory');
      expect(call[2]).not.toHaveProperty('ownTag');
    }
  });

  it('sem corpo nem dados, o socket recebe nulos e o e-mail leva para a lista de notificações', async () => {
    notificationsService.dispatch({
      userId: 7,
      id: 42,
      params: { type: 'contract_auto_approved', title: 'Aprovada automaticamente' },
    });

    expect(socket.emitToUser.mock.calls[0]![2]).toEqual({
      id: 42,
      type: 'contract_auto_approved',
      title: 'Aprovada automaticamente',
      body: null,
      data: null,
      isRead: false,
      createdAt: '2026-10-01T12:00:00.000Z',
    });
    await flush();
    expect(mail.send.mock.calls[0]![0]).toEqual({
      userId: 7,
      to: 'f@escambo.test',
      template: 'notification',
      vars: {
        title: 'Aprovada automaticamente',
        body: null,
        link: 'https://app.escambo.test/notificacoes',
      },
    });
  });

  it.each([
    'contract_proposal_reminder',
    'contract_deadline_reminder',
    'contract_approval_reminder',
    'contract_extension_reminder',
    'contract_revision_stalled',
    'contract_auto_approved',
  ])('%s (ADR 58) vai por e-mail a quem recebe por evento', async (type) => {
    notificationsService.dispatch({ userId: 7, id: 50, params: { type, title: 'Aviso' } });
    await flush();

    expect(mail.send.mock.calls).toEqual([
      [
        {
          userId: 7,
          to: 'f@escambo.test',
          template: 'notification',
          vars: { title: 'Aviso', body: null, link: 'https://app.escambo.test/notificacoes' },
        },
      ],
    ]);
  });

  it('nunca lança: o socket fora fica no log com o tipo', () => {
    const warn = vi.spyOn(logger, 'warn');
    const down = new Error('socket fora');
    socket.emitToUser.mockImplementationOnce(() => {
      throw down;
    });

    expect(() => notificationsService.dispatch(lembrete, { ownTag: true })).not.toThrow();

    expect(warn.mock.calls).toEqual([
      [{ err: down, type: 'contract_deadline_reminder' }, 'envio da notificação falhou'],
    ]);
  });

  it('nunca lança: o e-mail que falha fica no log e o push sai do mesmo jeito', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const down = new Error('banco fora');
    users.findById.mockRejectedValueOnce(down);

    expect(() => notificationsService.dispatch(lembrete, { ownTag: true })).not.toThrow();
    await flush();

    expect(push.notify).toHaveBeenCalledTimes(1);
    expect(mail.send).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      [{ err: down, type: 'contract_deadline_reminder' }, 'e-mail da notificação falhou'],
    ]);
  });
});

/** O notify de sempre virou a soma das duas metades: grava fora de transação e envia. */
describe('notify = persist + dispatch', () => {
  it('grava sem conexão e envia o que foi gravado, com a categoria; a etiqueta própria não vem do notify', async () => {
    const persist = vi.spyOn(notificationsService, 'persist');
    const dispatch = vi.spyOn(notificationsService, 'dispatch');
    repo.create.mockResolvedValue(9);
    const input = {
      type: 'contract_overdue',
      title: 'Prazo estourado: Logo',
      data: { contractId: 3 },
    };

    await notificationsService.notify(7, input, { passCategory: 'deadline' });

    expect(persist.mock.calls).toEqual([[7, input]]);
    expect(dispatch.mock.calls).toEqual([
      [{ userId: 7, id: 9, params: input }, { passCategory: 'deadline' }],
    ]);
    expect(repo.create.mock.calls[0]![1]).toBeUndefined();
    expect(push.notify.mock.calls[0]![1]).toStrictEqual({
      ...input,
      notificationId: 9,
      passCategory: 'deadline',
    });
  });

  it('sem opções, o envio recebe opções vazias', async () => {
    const dispatch = vi.spyOn(notificationsService, 'dispatch');
    repo.create.mockResolvedValue(10);

    await notificationsService.notify(7, { type: 't', title: 'oi' });

    expect(dispatch.mock.calls).toEqual([
      [{ userId: 7, id: 10, params: { type: 't', title: 'oi' } }, {}],
    ]);
  });

  it('não lança se o banco falhar: fica no log e nada é enviado', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const down = new Error('db down');
    repo.create.mockRejectedValue(down);

    await expect(
      notificationsService.notify(7, { type: 'contract_proposal', title: 'Nova proposta' }),
    ).resolves.toBeUndefined();
    await flush();

    expect(warn.mock.calls).toEqual([[{ err: down }, 'notify falhou']]);
    expect(socket.emitToUser).not.toHaveBeenCalled();
    expect(push.notify).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });
});
