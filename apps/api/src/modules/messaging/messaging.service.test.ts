import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./messaging.repository', () => ({
  messagingRepository: { getOrCreate: vi.fn(), listMessages: vi.fn(), insertMessage: vi.fn() },
}));
vi.mock('../contracts/contracts.repository', () => ({
  contractsRepository: { findById: vi.fn() },
}));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: { notify: vi.fn() },
}));
vi.mock('../../config/realtime', () => ({
  realtime: { emitToContract: vi.fn() },
}));

import { messagingService } from './messaging.service';
import { messagingRepository, type MessageRow } from './messaging.repository';
import { contractsRepository, type ContractRow } from '../contracts/contracts.repository';
import { notificationsService } from '../notifications/notifications.service';
import { realtime } from '../../config/realtime';

const mRepo = vi.mocked(messagingRepository);
const cRepo = vi.mocked(contractsRepository);

const fakeContract = (o: Partial<{ client_id: number; freelancer_id: number }> = {}): ContractRow =>
  ({ id: 1, client_id: 10, freelancer_id: 20, ...o }) as unknown as ContractRow;

const fakeMsg = (o: Partial<{ sender_id: number; content: string }> = {}): MessageRow =>
  ({
    id: 1,
    conversation_id: 5,
    sender_id: 10,
    content: 'oi',
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...o,
  }) as unknown as MessageRow;

beforeEach(() => vi.clearAllMocks());

describe('messagingService.history', () => {
  it('404 quando o contrato não existe', async () => {
    cRepo.findById.mockResolvedValue(undefined);
    await expect(messagingService.history(1, 10)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('403 quando o usuário não é parte do contrato', async () => {
    cRepo.findById.mockResolvedValue(fakeContract());
    await expect(messagingService.history(1, 99)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('resolve a conversa e devolve mensagens + a outra parte', async () => {
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
    mRepo.listMessages.mockResolvedValue([fakeMsg()]);

    const h = await messagingService.history(1, 10); // cliente

    expect(mRepo.getOrCreate).toHaveBeenCalledWith(10, 20, 1);
    expect(h.conversationId).toBe(5);
    expect(h.otherPartyId).toBe(20); // freelancer
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({ id: 1, content: 'oi', senderId: 10 });
  });
});

describe('messagingService.send', () => {
  it('persiste, transmite em tempo real e notifica a outra parte', async () => {
    cRepo.findById.mockResolvedValue(fakeContract());
    mRepo.getOrCreate.mockResolvedValue(5);
    mRepo.insertMessage.mockResolvedValue(fakeMsg({ sender_id: 20, content: 'resposta' }));

    const msg = await messagingService.send(1, 20, 'resposta'); // freelancer envia

    expect(mRepo.insertMessage).toHaveBeenCalledWith({ conversationId: 5, senderId: 20, content: 'resposta' });
    expect(realtime.emitToContract).toHaveBeenCalledWith(
      1,
      'message:new',
      expect.objectContaining({ contractId: 1, content: 'resposta' }),
    );
    expect(notificationsService.notify).toHaveBeenCalledWith(
      10, // outra parte = cliente
      expect.objectContaining({ type: 'chat_message', data: { contractId: 1 } }),
    );
    expect(msg.content).toBe('resposta');
  });
});
