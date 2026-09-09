import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./notifications.repository', () => ({
  notificationsRepository: { create: vi.fn() },
}));
vi.mock('../../config/realtime', () => ({
  realtime: { emitToUser: vi.fn(), emitToContract: vi.fn() },
}));

import { realtime } from '../../config/realtime';
import { notificationsRepository } from './notifications.repository';
import { notificationsService } from './notifications.service';

const repo = vi.mocked(notificationsRepository);
const rt = vi.mocked(realtime);

describe('notificações em tempo real', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persiste e empurra a notificação para as conexões do usuário', async () => {
    repo.create.mockResolvedValue(42);

    await notificationsService.notify(7, {
      type: 'contract_proposal',
      title: 'Nova proposta',
      data: { contractId: 1 },
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, type: 'contract_proposal', title: 'Nova proposta' }),
    );
    expect(rt.emitToUser).toHaveBeenCalledWith(
      7,
      'notification:new',
      expect.objectContaining({
        id: 42,
        type: 'contract_proposal',
        title: 'Nova proposta',
        data: { contractId: 1 },
        isRead: false,
      }),
    );
  });

  it('falha ao persistir não derruba quem notificou nem emite evento', async () => {
    repo.create.mockRejectedValue(new Error('db down'));

    await expect(
      notificationsService.notify(7, { type: 'contract_accepted', title: 'Aceita' }),
    ).resolves.toBeUndefined();

    expect(rt.emitToUser).not.toHaveBeenCalled();
  });
});
