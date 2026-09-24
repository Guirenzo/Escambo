import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/auth.repository', () => ({
  authRepository: { findById: vi.fn() },
}));
vi.mock('./push.repository', () => ({
  pushRepository: {
    listForUser: vi.fn(),
    markSent: vi.fn(),
    markError: vi.fn(),
    removeById: vi.fn(),
  },
}));
vi.mock('./notifications.repository', () => ({
  notificationsRepository: { markPushHeld: vi.fn(), countHeld: vi.fn() },
}));
vi.mock('./push.provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./push.provider')>();
  const send = vi.fn().mockResolvedValue('sent');
  return {
    ...actual,
    activePushProvider: () => ({ name: 'simulated', send }),
    __send: send,
  };
});
vi.mock('../mail/mail.service', () => ({
  EMAILED_NOTIFICATION_TYPES: new Set(['contract_proposal']),
}));

import { env } from '../../config/env';
import { authRepository } from '../auth/auth.repository';
import { notificationsRepository } from './notifications.repository';
import * as provider from './push.provider';
import { pushRepository } from './push.repository';
import { pushService, quietSummaryPayload } from './push.service';

const users = vi.mocked(authRepository);
const pushes = vi.mocked(pushRepository);
const notifs = vi.mocked(notificationsRepository);
const send = (provider as unknown as { __send: ReturnType<typeof vi.fn> }).__send;

/**
 * "Não perturbe" no serviço de push (ADR 54): dentro da janela o aviso não sai e a notificação
 * fica marcada como retida; fora dela sai com o TTL até o próximo silêncio. O provedor de unidade
 * é 'off' por padrão (vitest.config.ts), então cada teste liga o simulado.
 */
const conta = (quiet: { start: number; end: number } | null, timezone = 'America/Sao_Paulo') => ({
  id: 7,
  ulid: 'u7',
  email: 'a@escambo.test',
  password_hash: null,
  role: 'client',
  status: 'active',
  deleted_at: null,
  timezone,
  push_quiet_start: quiet?.start ?? null,
  push_quiet_end: quiet?.end ?? null,
});

const aparelho = {
  id: 1,
  user_id: 7,
  endpoint: 'https://push.escambo.test/a',
  p256dh: 'p',
  auth_key: 'a',
};
const aviso = {
  type: 'contract_proposal',
  title: 'Proposta',
  body: 'x',
  data: { contractId: 3 },
  notificationId: 41,
};

beforeEach(() => {
  vi.clearAllMocks();
  env.PUSH_PROVIDER = 'simulated';
  pushes.listForUser.mockResolvedValue([aparelho] as never);
  send.mockResolvedValue('sent');
});

describe('push dentro e fora do silêncio (ADR 54)', () => {
  it('às 22:00 de Brasília com janela 22→7, o aviso fica retido e nada sai', async () => {
    users.findById.mockResolvedValue(conta({ start: 22, end: 7 }) as never);
    await pushService.notify(7, aviso, new Date('2026-09-15T01:00:00Z')); // 22:00 em Brasília
    expect(notifs.markPushHeld).toHaveBeenCalledWith(41, new Date('2026-09-15T01:00:00Z'));
    expect(send).not.toHaveBeenCalled();
  });

  it('às 07:00 a janela já acabou: sai com o TTL até as 22:00 (15 horas viram o teto de 12)', async () => {
    users.findById.mockResolvedValue(conta({ start: 22, end: 7 }) as never);
    await pushService.notify(7, aviso, new Date('2026-09-15T10:00:00Z')); // 07:00 em Brasília
    expect(notifs.markPushHeld).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[2]).toEqual({ ttlSeconds: 12 * 3600 });
  });

  it('o fuso da conta manda: o mesmo instante em Manaus ainda é 06:00, e fica retido', async () => {
    users.findById.mockResolvedValue(conta({ start: 22, end: 7 }, 'America/Manaus') as never);
    await pushService.notify(7, aviso, new Date('2026-09-15T10:00:00Z'));
    expect(notifs.markPushHeld).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('sem janela, sai com o teto de 12 horas', async () => {
    users.findById.mockResolvedValue(conta(null) as never);
    await pushService.notify(7, aviso, new Date('2026-09-15T01:00:00Z'));
    expect(send.mock.calls[0]?.[2]).toEqual({ ttlSeconds: 12 * 3600 });
  });

  it('o aviso de teste fura o silêncio, mas leva o TTL até o próximo início', async () => {
    users.findById.mockResolvedValue(conta({ start: 22, end: 7 }) as never);
    const r = await pushService.sendTest(7, new Date('2026-09-14T18:00:00Z')); // 15:00 em Brasília
    expect(r.sent).toBe(1);
    expect(send.mock.calls[0]?.[2]).toEqual({ ttlSeconds: 7 * 3600 });
  });

  it('canal desligado ou conta encerrada: nem retém, nem envia', async () => {
    env.PUSH_PROVIDER = 'off';
    users.findById.mockResolvedValue(conta({ start: 22, end: 7 }) as never);
    await pushService.notify(7, aviso, new Date('2026-09-15T01:00:00Z'));
    expect(notifs.markPushHeld).not.toHaveBeenCalled();
    env.PUSH_PROVIDER = 'simulated';
    users.findById.mockResolvedValue({
      ...conta({ start: 22, end: 7 }),
      deleted_at: new Date(),
    } as never);
    await pushService.notify(7, aviso, new Date('2026-09-15T01:00:00Z'));
    expect(notifs.markPushHeld).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('o resumo de vários avisos tem título fixo, os primeiros títulos e etiqueta única', () => {
    const p = quietSummaryPayload([
      { title: 'Proposta aceita' },
      { title: 'Entrega registrada' },
      { title: 'Disputa aberta' },
      { title: 'Saque concluído' },
      { title: 'Nova avaliação' },
    ]);
    expect(p.title).toBe('Enquanto você estava em silêncio');
    expect(p.body).toBe(
      '5 avisos ficaram por ver: Proposta aceita · Entrega registrada · Disputa aberta',
    );
    expect(p.url).toBe('/notificacoes');
    expect(p.tag).toBe('quiet_summary');
    expect(p.body.length).toBeLessThanOrEqual(120);
  });
});
