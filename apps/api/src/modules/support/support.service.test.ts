import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supportService as svc } from './support.service';
const { repo, dispatch, warn } = vi.hoisted(() => ({
  repo: {
    list: vi.fn(),
    find: vi.fn(),
    messages: vi.fn(),
    create: vi.fn(),
    reply: vi.fn(),
    close: vi.fn(),
    update: vi.fn(),
    activeAdmins: vi.fn(),
    saveNotice: vi.fn(),
  },
  dispatch: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('./support.repository', () => ({ supportRepository: repo }));
vi.mock('../notifications/notifications.service', () => ({ notificationsService: { dispatch } }));
vi.mock('../../config/logger', () => ({ logger: { warn } }));
const NOW = new Date('2026-10-15T15:00:00Z');
const row = {
  id: 12,
  ulid: 'ulid',
  user_id: 7,
  owner_deleted: 0,
  contract_id: null,
  category: 'account',
  subject: 'ASSUNTO PRIVADO',
  status: 'open',
  priority: 'medium',
  assigned_to: null,
  first_response_at: null,
  sla_due_at: NOW,
  sla_alerted_at: null,
  resolved_at: null,
  closed_at: null,
  created_at: NOW,
  updated_at: NOW,
};
const message = (id: number, senderId = 7, internal = 0) => ({
  id,
  ticket_id: 12,
  sender_id: senderId,
  message: 'TEXTO PRIVADO',
  is_internal: internal,
  created_at: NOW,
});
beforeEach(() => {
  vi.resetAllMocks();
  repo.list.mockResolvedValue([row]);
  repo.find.mockResolvedValue(row);
  repo.messages.mockResolvedValue([]);
  repo.create.mockResolvedValue(12);
  repo.reply.mockResolvedValue(true);
  repo.activeAdmins.mockResolvedValue([90]);
  repo.saveNotice.mockResolvedValue({ userId: 90, id: 99, params: {} });
});
describe('projeções de suporte', () => {
  it('lista mantém formato paginado e histórico anonimizado sinalizado', async () => {
    repo.list.mockResolvedValue([{ ...row, owner_deleted: 1 }]);
    expect(await svc.list(null, { page: 2, limit: 50, status: 'resolved' })).toMatchObject({
      page: 2,
      limit: 50,
      items: [{ ownerDeleted: true, createdAt: NOW.toISOString() }],
    });
    expect(repo.list).toHaveBeenCalledWith(null, { page: 2, limit: 50, status: 'resolved' });
  });
  it('detalhe público pede SQL público, últimas 50 ascendentes e cursor mais antigo', async () => {
    repo.messages.mockResolvedValue(Array.from({ length: 51 }, (_, i) => message(100 - i)));
    const detail = await svc.detail(12, 7, 101);
    expect(repo.find).toHaveBeenCalledWith(12, 7);
    expect(repo.messages).toHaveBeenCalledWith(12, false, 101);
    expect(detail.messages.map((m) => m.id)).toEqual(Array.from({ length: 50 }, (_, i) => 51 + i));
    expect(detail.nextBeforeId).toBe(51);
  });
  it('admin vê notas identificadas e papéis são do titular do ticket', async () => {
    repo.messages.mockResolvedValue([message(3, 90, 1), message(2, 90), message(1)]);
    const detail = await svc.detail(12, null);
    expect(detail.messages.map((m) => [m.from, m.internal])).toEqual([
      ['user', false],
      ['support', false],
      ['support', true],
    ]);
    expect(detail.nextBeforeId).toBeNull();
    expect(repo.messages).toHaveBeenCalledWith(12, true, undefined);
  });
  it('ticket de outro dono é 404 sem consultar mensagens', async () => {
    repo.find.mockResolvedValue(undefined);
    await expect(svc.detail(12, 8)).rejects.toMatchObject({ statusCode: 404 });
    expect(repo.messages).not.toHaveBeenCalled();
  });
});
describe('ações e avisos sem texto privado', () => {
  it('abertura avisa admins atuais com link administrativo sem assunto/descrição', async () => {
    const input = {
      category: 'account' as const,
      subject: 'ASSUNTO PRIVADO',
      description: 'DESCRIÇÃO PRIVADA',
    };
    await svc.create(7, input);
    expect(repo.create).toHaveBeenCalledWith(7, input);
    expect(repo.saveNotice).toHaveBeenCalledWith(
      90,
      expect.objectContaining({
        type: 'support_opened',
        data: { supportTicketId: 12, supportAdmin: true },
      }),
      true,
    );
    expect(JSON.stringify(repo.saveNotice.mock.calls)).not.toMatch(/PRIVADO|PRIVADA/);
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it('falha de envio opcional não reverte abertura e log só tem ticketId', async () => {
    repo.saveNotice.mockRejectedValue(new Error('TEXTO PRIVADO'));
    await expect(
      svc.create(7, { category: 'other', subject: 'Assunto', description: 'Descrição detalhada' }),
    ).resolves.toHaveProperty('id', 12);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('TEXTO PRIVADO');
    expect(warn.mock.calls[0]![0]).toEqual({ ticketId: 12 });
  });
  it.each([false, true])(
    'resposta pública resolve=%s avisa dono com metadados genéricos',
    async (resolve) => {
      await svc.reply(12, 90, true, { message: 'TEXTO PRIVADO', resolve });
      expect(repo.saveNotice).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          type: resolve ? 'support_resolved' : 'support_reply',
          data: { supportTicketId: 12 },
        }),
        false,
      );
      expect(JSON.stringify(repo.saveNotice.mock.calls)).not.toContain('TEXTO PRIVADO');
    },
  );
  it('nota interna nunca notifica, mesmo com conteúdo privado', async () => {
    await svc.reply(12, 90, true, { message: 'NOTA PRIVADA', internal: true });
    expect(repo.saveNotice).not.toHaveBeenCalled();
    expect(repo.activeAdmins).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('autor administrativo de chamado próprio não notifica a si mesmo', async () => {
    repo.find.mockResolvedValue({ ...row, user_id: 90 });
    await svc.reply(12, 90, true, { message: 'Minha própria resposta' });
    expect(repo.saveNotice).not.toHaveBeenCalled();
  });
  it('titular responde e equipe é avisada', async () => {
    await svc.reply(12, 7, false, { message: 'TEXTO PRIVADO' });
    expect(repo.saveNotice).toHaveBeenCalledWith(
      90,
      expect.objectContaining({
        type: 'support_reply',
        data: { supportTicketId: 12, supportAdmin: true },
      }),
      true,
    );
  });
  it('encerramento confirmado pela expiração só então vira erro 409, sem inserir/avisar', async () => {
    repo.reply.mockResolvedValue(false);
    await expect(svc.reply(12, 7, false, { message: 'Oi' })).rejects.toMatchObject({
      code: 'ticket_closed',
    });
    expect(repo.find).not.toHaveBeenCalled();
    expect(repo.saveNotice).not.toHaveBeenCalled();
  });
  it('close e update retornam somente detalhe apropriado', async () => {
    await svc.close(12, 7);
    expect(repo.close).toHaveBeenCalledWith(12, 7);
    expect(repo.find).toHaveBeenCalledWith(12, 7);
    await svc.update(12, 90, { priority: 'high' });
    expect(repo.update).toHaveBeenCalledWith(12, 90, { priority: 'high' });
    expect(repo.find).toHaveBeenLastCalledWith(12, null);
  });
});
