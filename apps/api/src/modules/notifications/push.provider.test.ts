import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Os dois falsos ficam fora do factory: quando um teste recarrega o provedor (vi.resetModules),
// o módulo novo recebe estes mesmos, e dá para conferir o que ele pediu. Nenhum push sai da máquina.
const wp = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  generateVAPIDKeys: vi.fn(),
}));
vi.mock('web-push', () => ({ default: wp }));

import webpush from 'web-push';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import {
  activePushProvider,
  offPushProvider,
  simulatedPushProvider,
  webPushProvider,
} from './push.provider';
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
const originalProvider = env.PUSH_PROVIDER;

/**
 * As chaves VAPID ficam guardadas no módulo depois da primeira leitura. Para conferir de onde
 * elas vêm em cada configuração, o provedor é carregado de novo com o ambiente já ajustado.
 */
async function fresh(patch: Partial<typeof env>) {
  vi.resetModules();
  const config = await import('../../config/env');
  Object.assign(config.env, { PUSH_PUBLIC_KEY: '', PUSH_PRIVATE_KEY: '', ...patch });
  const log = (await import('../../config/logger')).logger;
  return { provider: await import('./push.provider'), log };
}

beforeEach(() => {
  vi.clearAllMocks();
  wp.sendNotification.mockResolvedValue({});
  wp.generateVAPIDKeys.mockReturnValue({ publicKey: 'chave-publica', privateKey: 'chave-privada' });
});

afterEach(() => {
  env.PUSH_PROVIDER = originalProvider;
  vi.restoreAllMocks();
});

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

  it('entrega para o endpoint do aparelho com as chaves dele, o aviso em JSON e a identificação VAPID', async () => {
    const { provider } = await fresh({
      PUSH_PROVIDER: 'webpush',
      PUSH_PUBLIC_KEY: 'publica-do-ambiente',
      PUSH_PRIVATE_KEY: 'privada-do-ambiente',
      PUSH_SUBJECT: 'mailto:avisos@escambo.test',
    });

    await expect(provider.webPushProvider.send(alvo, aviso, { ttlSeconds: 60 })).resolves.toBe(
      'sent',
    );

    expect(provider.webPushProvider.name).toBe('webpush');
    expect(wp.sendNotification).toHaveBeenCalledTimes(1);
    const [subscription, payload, options] = wp.sendNotification.mock.calls[0]!;
    expect(subscription).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(JSON.parse(payload as string)).toEqual(aviso);
    expect(options).toEqual({
      vapidDetails: {
        subject: 'mailto:avisos@escambo.test',
        publicKey: 'publica-do-ambiente',
        privateKey: 'privada-do-ambiente',
      },
      TTL: 60,
    });
  });

  it('aparelho que desfez a assinatura (404/410) ou chave que não bate mais (401/403): a assinatura morreu, sem alarde no log', async () => {
    const warn = vi.spyOn(logger, 'warn');
    for (const statusCode of [404, 410, 401, 403]) {
      wp.sendNotification.mockRejectedValueOnce(
        Object.assign(new Error('recusado'), { statusCode }),
      );
      await expect(webPushProvider.send(alvo, aviso), String(statusCode)).resolves.toBe('gone');
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('falha passageira do serviço (429, 500, rede fora): não lança, devolve failed e avisa no log com o status', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const busy = Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
    const offline = new Error('ECONNRESET');
    wp.sendNotification.mockRejectedValueOnce(busy).mockRejectedValueOnce(offline);

    await expect(webPushProvider.send(alvo, aviso)).resolves.toBe('failed');
    await expect(webPushProvider.send(alvo, aviso)).resolves.toBe('failed');

    expect(warn).toHaveBeenNthCalledWith(1, { err: busy, status: 429 }, 'push não entregue');
    expect(warn).toHaveBeenNthCalledWith(
      2,
      { err: offline, status: undefined },
      'push não entregue',
    );
  });
});

/** De onde vêm as chaves VAPID: do ambiente, ou um par por subida só para o simulado (ADR 52). */
describe('vapidKeys', () => {
  it('com as duas chaves no ambiente, usa as do ambiente e não gera nenhuma', async () => {
    const { provider } = await fresh({
      PUSH_PROVIDER: 'webpush',
      PUSH_PUBLIC_KEY: 'publica-do-ambiente',
      PUSH_PRIVATE_KEY: 'privada-do-ambiente',
    });

    expect(provider.vapidKeys()).toEqual({
      publicKey: 'publica-do-ambiente',
      privateKey: 'privada-do-ambiente',
    });
    expect(wp.generateVAPIDKeys).not.toHaveBeenCalled();
  });

  it('envio real sem as duas chaves é erro de configuração: chave por processo quebraria o cluster', async () => {
    const noKeys = await fresh({ PUSH_PROVIDER: 'webpush' });
    expect(() => noKeys.provider.vapidKeys()).toThrow(
      'PUSH_PROVIDER=webpush exige PUSH_PUBLIC_KEY e PUSH_PRIVATE_KEY',
    );

    // Só a pública não basta.
    const publicOnly = await fresh({ PUSH_PROVIDER: 'webpush', PUSH_PUBLIC_KEY: 'publica' });
    expect(() => publicOnly.provider.vapidKeys()).toThrow('PUSH_PROVIDER=webpush exige');

    expect(wp.generateVAPIDKeys).not.toHaveBeenCalled();
  });

  it('envio sem as chaves não lança para quem envia: é tentativa perdida (failed), com o erro de configuração no log', async () => {
    const { provider, log } = await fresh({ PUSH_PROVIDER: 'webpush', PUSH_PUBLIC_KEY: 'publica' });
    const warn = vi.spyOn(log, 'warn');

    await expect(provider.webPushProvider.send(alvo, aviso)).resolves.toBe('failed');

    expect(wp.sendNotification).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(message).toBe('push não entregue');
    expect(fields).toEqual({ err: expect.any(Error), status: undefined });
    expect((fields as { err: Error }).err.message).toContain(
      'PUSH_PROVIDER=webpush exige PUSH_PUBLIC_KEY e PUSH_PRIVATE_KEY',
    );
  });

  it('simulado sem chaves: gera um par uma vez, reaproveita enquanto o processo viver e loga só a pública', async () => {
    const { provider, log } = await fresh({ PUSH_PROVIDER: 'simulated' });
    const info = vi.spyOn(log, 'info');

    const first = provider.vapidKeys();
    const second = provider.vapidKeys();

    expect(first).toEqual({ publicKey: 'chave-publica', privateKey: 'chave-privada' });
    expect(second).toBe(first);
    expect(wp.generateVAPIDKeys).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toEqual({ publicKey: 'chave-publica' });
    expect(JSON.stringify(info.mock.calls[0])).not.toContain('chave-privada');
  });

  it('simulado com só uma das chaves no ambiente também gera o par (meia configuração não vale)', async () => {
    const { provider } = await fresh({ PUSH_PROVIDER: 'simulated', PUSH_PRIVATE_KEY: 'privada' });

    expect(provider.vapidKeys()).toEqual({
      publicKey: 'chave-publica',
      privateKey: 'chave-privada',
    });
  });
});

describe('provedores simulado e desligado', () => {
  it('simulado: conta como entregue sem sair da máquina; o log leva o início do endpoint, o título e a prioridade', async () => {
    const info = vi.spyOn(logger, 'info');
    const longTarget = { ...alvo, endpoint: `https://push.escambo.test/${'a'.repeat(100)}` };

    await expect(simulatedPushProvider.send(longTarget, aviso)).resolves.toBe('sent');
    await expect(simulatedPushProvider.send(alvo, aviso, { urgency: 'high' })).resolves.toBe(
      'sent',
    );

    expect(simulatedPushProvider.name).toBe('simulated');
    expect(wp.sendNotification).not.toHaveBeenCalled();
    // O endpoint inteiro identifica o aparelho: só os 60 primeiros caracteres vão para o log.
    expect(info).toHaveBeenNthCalledWith(
      1,
      { endpoint: longTarget.endpoint.slice(0, 60), title: 'Prazo estourado', urgency: 'normal' },
      'push (simulado) entregue',
    );
    expect(longTarget.endpoint.length).toBeGreaterThan(60);
    expect(info).toHaveBeenNthCalledWith(
      2,
      { endpoint: alvo.endpoint, title: 'Prazo estourado', urgency: 'high' },
      'push (simulado) entregue',
    );
  });

  it('desligado: não entrega nada e devolve failed, sem tocar no serviço de push', async () => {
    await expect(offPushProvider.send(alvo, aviso)).resolves.toBe('failed');
    expect(wp.sendNotification).not.toHaveBeenCalled();
  });

  it('activePushProvider segue PUSH_PROVIDER: webpush é o real, off é o desligado, o resto é o simulado', () => {
    env.PUSH_PROVIDER = 'webpush';
    expect(activePushProvider()).toBe(webPushProvider);
    env.PUSH_PROVIDER = 'off';
    expect(activePushProvider()).toBe(offPushProvider);
    env.PUSH_PROVIDER = 'simulated';
    expect(activePushProvider()).toBe(simulatedPushProvider);
  });
});
