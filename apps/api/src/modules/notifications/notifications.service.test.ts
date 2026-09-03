import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./notifications.repository', () => ({
  notificationsRepository: {
    create: vi.fn(),
    listForUser: vi.fn(),
    countUnread: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  },
}));

import { notificationsService } from './notifications.service';
import { notificationsRepository, type NotificationRow } from './notifications.repository';

const repo = vi.mocked(notificationsRepository);

const row = (
  o: Partial<{
    id: number;
    type: string;
    title: string;
    body: string | null;
    data: string | Record<string, unknown> | null;
    is_read: number;
    created_at: Date;
  }> = {},
): NotificationRow =>
  ({
    id: 1,
    type: 'contract_proposal',
    title: 'Nova proposta',
    body: null,
    data: null,
    is_read: 0,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  }) as unknown as NotificationRow;

beforeEach(() => vi.clearAllMocks());

describe('notify (best-effort)', () => {
  it('cria a notificação serializando o data', async () => {
    repo.create.mockResolvedValue(1);
    await notificationsService.notify(7, { type: 't', title: 'oi', data: { contractId: 5 } });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, type: 't', title: 'oi', data: JSON.stringify({ contractId: 5 }) }),
    );
  });

  it('não lança se o repositório falhar', async () => {
    repo.create.mockRejectedValue(new Error('db down'));
    await expect(notificationsService.notify(7, { type: 't', title: 'oi' })).resolves.toBeUndefined();
  });
});

describe('list', () => {
  it('mapeia itens (data JSON) e traz unreadCount', async () => {
    repo.listForUser.mockResolvedValue([row({ data: '{"contractId":5}', is_read: 0 })]);
    repo.countUnread.mockResolvedValue(3);
    const res = await notificationsService.list(7, 1, 20);
    expect(res.unreadCount).toBe(3);
    expect(res.items[0]!.data).toEqual({ contractId: 5 });
    expect(res.items[0]!.isRead).toBe(false);
  });
});

describe('markRead', () => {
  it('404 quando não encontra', async () => {
    repo.markRead.mockResolvedValue(false);
    await expect(notificationsService.markRead(1, 7)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('ok quando marca', async () => {
    repo.markRead.mockResolvedValue(true);
    await expect(notificationsService.markRead(1, 7)).resolves.toBeUndefined();
  });
});
