import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentSubscription,
  ensureServiceWorker,
  hourNowIn,
  inQuietWindow,
  lastDeviceEndpoint,
  pushSupported,
  rememberDeviceEndpoint,
  subscribeDevice,
  urlBase64ToUint8Array,
} from './push';

/**
 * A parte dos avisos push que fala com o navegador (ADR 52): permissão, service worker e a
 * assinatura deste aparelho. O jsdom não tem nada disso, então cada teste monta o navegador de
 * mentira que precisa.
 */

const KEY = 'RXNjYW1ibw'; // "Escambo" em base64url
const OTHER_KEY = '-_-_';

interface FakeSubscription {
  options?: { applicationServerKey: ArrayBuffer | null };
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON: () => { endpoint?: string; keys?: Record<string, string> };
}

const subscriptionFor = (
  key: string | null,
  json: ReturnType<FakeSubscription['toJSON']> = {
    endpoint: 'https://push.example/aparelho-1',
    keys: { p256dh: 'chave-publica', auth: 'segredo' },
  },
): FakeSubscription => ({
  options: { applicationServerKey: key ? urlBase64ToUint8Array(key).buffer : null },
  unsubscribe: vi.fn().mockResolvedValue(true),
  toJSON: () => json,
});

/** Navegador com suporte a push: permissão, registro do service worker e assinatura existente. */
function fakeBrowser({
  permission = 'granted' as NotificationPermission,
  answer = 'granted' as NotificationPermission,
  existing = null as FakeSubscription | null,
  created = subscriptionFor(KEY),
  registered = true,
} = {}) {
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(existing),
    subscribe: vi.fn().mockResolvedValue(created),
  };
  const registration = { pushManager };
  const serviceWorker = {
    // O register resolve antes de o worker estar ativo: quem assina precisa do registro do `ready`.
    register: vi.fn().mockResolvedValue({ installing: {} }),
    ready: Promise.resolve(registration),
    getRegistration: vi.fn().mockResolvedValue(registered ? registration : undefined),
  };
  const requestPermission = vi.fn().mockResolvedValue(answer);
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', { permission, requestPermission });
  return { pushManager, registration, serviceWorker, requestPermission, created };
}

afterEach(() => {
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rememberDeviceEndpoint(null);
});

describe('janela de silêncio (ADR 54)', () => {
  it('sem janela configurada nunca está em silêncio', () => {
    expect(inQuietWindow(3, null)).toBe(false);
  });

  it('janela que cruza a meia-noite: das 22 às 7 silencia de 22:00 a 06:59', () => {
    const night = { start: 22, end: 7 };
    expect(inQuietWindow(21, night)).toBe(false);
    expect(inQuietWindow(22, night)).toBe(true);
    expect(inQuietWindow(23, night)).toBe(true);
    expect(inQuietWindow(0, night)).toBe(true);
    expect(inQuietWindow(6, night)).toBe(true);
    // O fim é exclusivo: às 7 em ponto os avisos voltam.
    expect(inQuietWindow(7, night)).toBe(false);
    expect(inQuietWindow(12, night)).toBe(false);
  });

  it('janela diurna: das 13 às 15 silencia só 13:00 a 14:59', () => {
    const nap = { start: 13, end: 15 };
    expect(inQuietWindow(12, nap)).toBe(false);
    expect(inQuietWindow(13, nap)).toBe(true);
    expect(inQuietWindow(14, nap)).toBe(true);
    expect(inQuietWindow(15, nap)).toBe(false);
    expect(inQuietWindow(2, nap)).toBe(false);
  });
});

describe('hora de agora no fuso da conta', () => {
  it('a mesma hora do mundo dá horas diferentes em Brasília e em Manaus', () => {
    const now = new Date('2026-10-02T15:30:00.000Z');
    expect(hourNowIn('America/Sao_Paulo', now)).toBe(12);
    expect(hourNowIn('America/Manaus', now)).toBe(11);
  });

  it('meia-noite é 0 (e não 24), e a hora cheia ignora os minutos', () => {
    expect(hourNowIn('America/Sao_Paulo', new Date('2026-10-02T03:00:00.000Z'))).toBe(0);
    expect(hourNowIn('America/Sao_Paulo', new Date('2026-10-02T02:59:59.000Z'))).toBe(23);
  });

  it('sem data usa o relógio de agora', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T20:10:00.000Z'));
    expect(hourNowIn('America/Sao_Paulo')).toBe(17);
    vi.useRealTimers();
  });
});

describe('suporte do navegador', () => {
  it('navegador sem service worker nem PushManager não tem avisos', async () => {
    expect(pushSupported()).toBe(false);
    await expect(currentSubscription()).resolves.toBeNull();
  });

  it('com service worker, PushManager e Notification, tem', () => {
    fakeBrowser();
    expect(pushSupported()).toBe(true);
  });

  it('faltando só a API de notificação, não tem', () => {
    fakeBrowser();
    vi.unstubAllGlobals();
    vi.stubGlobal('PushManager', class {});
    expect(pushSupported()).toBe(false);
  });
});

describe('service worker e assinatura deste aparelho', () => {
  it('ensureServiceWorker registra /sw.js e devolve o registro pronto', async () => {
    const { serviceWorker, registration } = fakeBrowser();
    await expect(ensureServiceWorker()).resolves.toBe(registration);
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js');
  });

  it('currentSubscription devolve a assinatura guardada pelo navegador', async () => {
    const existing = subscriptionFor(KEY);
    fakeBrowser({ existing });
    await expect(currentSubscription()).resolves.toBe(existing);
  });

  it('sem service worker registrado ou sem assinatura, não há assinatura', async () => {
    fakeBrowser({ registered: false });
    await expect(currentSubscription()).resolves.toBeNull();
    fakeBrowser({ existing: null });
    await expect(currentSubscription()).resolves.toBeNull();
  });
});

describe('subscribeDevice: ligar os avisos neste aparelho', () => {
  it('permissão já dada: assina com a chave da API e devolve o que a API precisa guardar', async () => {
    const browser = fakeBrowser();

    const device = await subscribeDevice(KEY);

    expect(device).toEqual({
      endpoint: 'https://push.example/aparelho-1',
      p256dh: 'chave-publica',
      auth: 'segredo',
    });
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(browser.serviceWorker.register).toHaveBeenCalledWith('/sw.js');
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const options = browser.pushManager.subscribe.mock.calls[0]![0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([69, 115, 99, 97, 109, 98, 111]);
    // Sair da conta precisa saber qual aparelho desligar.
    expect(lastDeviceEndpoint()).toBe('https://push.example/aparelho-1');
  });

  it('permissão ainda não respondida: pergunta, e com o sim segue assinando', async () => {
    const browser = fakeBrowser({ permission: 'default', answer: 'granted' });
    await subscribeDevice(KEY);
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('a pessoa nega na hora: explica e não registra nada', async () => {
    const browser = fakeBrowser({ permission: 'default', answer: 'denied' });
    await expect(subscribeDevice(KEY)).rejects.toThrow('Permissão de avisos negada no navegador');
    expect(browser.serviceWorker.register).not.toHaveBeenCalled();
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(lastDeviceEndpoint()).toBeNull();
  });

  it('permissão já negada no navegador: nem pergunta de novo', async () => {
    const browser = fakeBrowser({ permission: 'denied' });
    await expect(subscribeDevice(KEY)).rejects.toThrow('Permissão de avisos negada no navegador');
    expect(browser.requestPermission).not.toHaveBeenCalled();
  });

  it('aparelho já assinado com a mesma chave: reaproveita, sem assinar de novo', async () => {
    const existing = subscriptionFor(KEY, {
      endpoint: 'https://push.example/ja-assinado',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const browser = fakeBrowser({ existing });

    const device = await subscribeDevice(KEY);

    expect(device.endpoint).toBe('https://push.example/ja-assinado');
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('servidor trocou de chave: desfaz a assinatura velha antes de assinar com a nova', async () => {
    const existing = subscriptionFor(OTHER_KEY, {
      endpoint: 'https://push.example/velha',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const browser = fakeBrowser({ existing });

    const device = await subscribeDevice(KEY);

    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(existing.unsubscribe.mock.invocationCallOrder[0]!).toBeLessThan(
      browser.pushManager.subscribe.mock.invocationCallOrder[0]!,
    );
    expect(device.endpoint).toBe('https://push.example/aparelho-1');
  });

  it('assinatura velha sem chave guardada (navegador antigo) também é refeita', async () => {
    const existing = subscriptionFor(null);
    const browser = fakeBrowser({ existing });
    await subscribeDevice(KEY);
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('se desfazer a velha falha, ainda tenta assinar com a chave nova', async () => {
    const existing = subscriptionFor(OTHER_KEY);
    existing.unsubscribe.mockRejectedValue(new Error('InvalidStateError'));
    const browser = fakeBrowser({ existing });

    await expect(subscribeDevice(KEY)).resolves.toMatchObject({
      endpoint: 'https://push.example/aparelho-1',
    });
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['sem endpoint', { keys: { p256dh: 'p', auth: 'a' } }],
    ['sem a chave p256dh', { endpoint: 'https://push.example/x', keys: { auth: 'a' } }],
    ['sem o segredo auth', { endpoint: 'https://push.example/x', keys: { p256dh: 'p' } }],
    ['sem chave nenhuma', { endpoint: 'https://push.example/x' }],
  ])(
    'assinatura incompleta (%s) é recusada e o aparelho não fica lembrado',
    async (_what, json) => {
      fakeBrowser({ created: subscriptionFor(KEY, json) });
      await expect(subscribeDevice(KEY)).rejects.toThrow(
        'O navegador não devolveu a assinatura completa',
      );
      expect(lastDeviceEndpoint()).toBeNull();
    },
  );
});

describe('navegador sem armazenamento', () => {
  it('lembrar e ler o endpoint não quebram: só não há endpoint lembrado', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });

    expect(() => rememberDeviceEndpoint('https://push.example/1')).not.toThrow();
    expect(() => rememberDeviceEndpoint(null)).not.toThrow();
    expect(lastDeviceEndpoint()).toBeNull();
  });
});
