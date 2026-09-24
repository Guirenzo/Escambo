import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/notifications/notifications.repository', () => ({
  notificationsRepository: {
    usersForQuietSummary: vi.fn(),
    listHeld: vi.fn(),
    claimQuietSummary: vi.fn(),
  },
}));
vi.mock('../modules/notifications/push.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/notifications/push.service')>();
  return {
    ...actual,
    pushService: { send: vi.fn() },
  };
});
vi.mock('../modules/notifications/notifications.service', () => ({
  toNotification: (r: {
    id: number;
    type: string;
    title: string;
    body: string | null;
    data: string | null;
  }) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    data: r.data ? JSON.parse(r.data) : null,
    isRead: false,
    createdAt: '2026-09-15T01:00:00.000Z',
  }),
}));

import { env } from '../config/env';
import { notificationsRepository } from '../modules/notifications/notifications.repository';
import { pushService } from '../modules/notifications/push.service';
import { runQuietPushSummary } from './quiet-push-summary';

const repo = vi.mocked(notificationsRepository);
const push = vi.mocked(pushService);

// 07:30 em Brasília = 10:30Z: a janela 22→7 acabou de fechar.
const MANHA = new Date('2026-09-15T10:30:00Z');

const conta = (id: number, summaryId: number | null = null) => ({
  id,
  timezone: 'America/Sao_Paulo',
  push_quiet_start: 22,
  push_quiet_end: 7,
  push_quiet_summary_id: summaryId,
});
const retido = (id: number, title: string, data: string | null = null) => ({
  id,
  type: 'contract_proposal',
  title,
  body: 'corpo',
  data,
  is_read: 0,
  created_at: new Date('2026-09-15T01:00:00Z'),
  push_held_at: new Date('2026-09-15T01:00:00Z'),
});

beforeEach(() => {
  vi.clearAllMocks();
  env.PUSH_PROVIDER = 'simulated';
  repo.usersForQuietSummary.mockResolvedValue([]);
  repo.claimQuietSummary.mockResolvedValue(true);
  push.send.mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
});

describe('resumo ao fim do silêncio (ADR 54)', () => {
  it('com o canal desligado nem consulta', async () => {
    env.PUSH_PROVIDER = 'off';
    expect(await runQuietPushSummary(MANHA)).toMatchObject({ skipped: 'push_off' });
    expect(repo.usersForQuietSummary).not.toHaveBeenCalled();
  });

  it('procura um fuso por vez, com a hora local de cada um', async () => {
    await runQuietPushSummary(MANHA);
    expect(repo.usersForQuietSummary).toHaveBeenCalledTimes(5);
    expect(repo.usersForQuietSummary).toHaveBeenCalledWith('America/Sao_Paulo', 7);
    expect(repo.usersForQuietSummary).toHaveBeenCalledWith('America/Manaus', 6);
  });

  it('um retido só vira o próprio aviso, com a etiqueta e a URL dele; a trava vem antes do envio', async () => {
    repo.usersForQuietSummary.mockImplementation(async (zone) =>
      zone === 'America/Sao_Paulo' ? ([conta(7)] as never) : [],
    );
    repo.listHeld.mockResolvedValue([retido(41, 'Proposta aceita', '{"contractId":9}')] as never);
    const order: string[] = [];
    repo.claimQuietSummary.mockImplementation(async () => {
      order.push('claim');
      return true;
    });
    push.send.mockImplementation(async () => {
      order.push('send');
      return { sent: 1, removed: 0, failed: 0 };
    });

    const r = await runQuietPushSummary(MANHA);
    expect(r.sent).toEqual([7]);
    expect(repo.listHeld).toHaveBeenCalledWith(7, 0);
    expect(repo.claimQuietSummary).toHaveBeenCalledWith(7, 41);
    expect(order).toEqual(['claim', 'send']);
    const payload = push.send.mock.calls[0]?.[1];
    expect(payload).toMatchObject({
      title: 'Proposta aceita',
      url: '/contratos/9',
      tag: 'contract_proposal:9',
    });
    // TTL até as 22:00: das 07:30 são 14,5 h, presas ao teto de 12.
    expect(push.send.mock.calls[0]?.[2]).toEqual({ ttlSeconds: 12 * 3600 });
  });

  it('vários retidos viram um resumo só, e a marca é o maior id', async () => {
    repo.usersForQuietSummary.mockImplementation(async (zone) =>
      zone === 'America/Sao_Paulo' ? ([conta(7, 40)] as never) : [],
    );
    repo.listHeld.mockResolvedValue([retido(41, 'A'), retido(42, 'B'), retido(43, 'C')] as never);
    const r = await runQuietPushSummary(MANHA);
    expect(r.sent).toEqual([7]);
    expect(repo.listHeld).toHaveBeenCalledWith(7, 40);
    expect(repo.claimQuietSummary).toHaveBeenCalledWith(7, 43);
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(push.send.mock.calls[0]?.[1]).toMatchObject({
      title: 'Enquanto você estava em silêncio',
      tag: 'quiet_summary',
    });
  });

  it('outra instância já pegou a trava: nada sai, nada conta', async () => {
    repo.usersForQuietSummary.mockImplementation(async (zone) =>
      zone === 'America/Sao_Paulo' ? ([conta(7)] as never) : [],
    );
    repo.listHeld.mockResolvedValue([retido(41, 'A')] as never);
    repo.claimQuietSummary.mockResolvedValue(false);
    const r = await runQuietPushSummary(MANHA);
    expect(push.send).not.toHaveBeenCalled();
    expect(r).toMatchObject({ sent: [], failed: [], unreachable: [], empty: [] });
  });

  it('tudo lido entre a consulta e agora: vazio, sem trava; aparelho morto: inalcançável', async () => {
    repo.usersForQuietSummary.mockImplementation(async (zone) =>
      zone === 'America/Sao_Paulo' ? ([conta(7), conta(8)] as never) : [],
    );
    repo.listHeld.mockImplementation(async (id) => (id === 7 ? [] : ([retido(50, 'A')] as never)));
    push.send.mockResolvedValue({ sent: 0, removed: 1, failed: 0 });
    const r = await runQuietPushSummary(MANHA);
    expect(r.empty).toEqual([7]);
    expect(r.unreachable).toEqual([8]);
    expect(repo.claimQuietSummary).toHaveBeenCalledTimes(1);
  });

  it('falha no envio de uma pessoa não derruba as outras', async () => {
    repo.usersForQuietSummary.mockImplementation(async (zone) =>
      zone === 'America/Sao_Paulo' ? ([conta(7), conta(8)] as never) : [],
    );
    repo.listHeld.mockResolvedValue([retido(50, 'A')] as never);
    push.send
      .mockRejectedValueOnce(new Error('rede'))
      .mockResolvedValueOnce({ sent: 1, removed: 0, failed: 0 });
    const r = await runQuietPushSummary(MANHA);
    expect(r.failed).toEqual([7]);
    expect(r.sent).toEqual([8]);
  });
});
