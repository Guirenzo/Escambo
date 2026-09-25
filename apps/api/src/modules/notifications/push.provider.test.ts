import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({
  default: {
    sendNotification: vi.fn().mockResolvedValue({}),
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'chave-publica', privateKey: 'chave-privada' })),
  },
}));

import webpush from 'web-push';
import { webPushProvider } from './push.provider';
import { PUSH_TTL_MAX_SECONDS } from './quiet-hours';

const sendNotification = vi.mocked(webpush.sendNotification);
const alvo = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'p', auth: 'a' };
const aviso = {
  title: 'Prazo estourado',
  body: 'Até …',
  url: '/contratos/3',
  tag: 'contract_overdue:3',
};
const opcoes = () => sendNotification.mock.calls.at(-1)?.[2] as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

/** Web Push de verdade (ADR 52), com a prioridade só quando pedida (ADR 56). */
describe('webPushProvider', () => {
  it('prioridade alta só quando pedida; sem pedido, a chave nem vai e o serviço recebe normal', async () => {
    await webPushProvider.send(alvo, aviso, { ttlSeconds: 60 });
    expect(Object.keys(opcoes()).sort()).toEqual(['TTL', 'vapidDetails']);
    expect(opcoes().TTL).toBe(60);

    await webPushProvider.send(alvo, aviso, { ttlSeconds: 43_200, urgency: 'high' });
    expect(opcoes()).toMatchObject({ TTL: 43_200, urgency: 'high' });
  });

  it('sem opções, o TTL é o teto de quiet-hours', async () => {
    await webPushProvider.send(alvo, aviso);
    expect(opcoes().TTL).toBe(PUSH_TTL_MAX_SECONDS);
    expect(opcoes()).not.toHaveProperty('urgency');
  });
});
