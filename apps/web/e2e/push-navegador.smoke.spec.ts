import { expect, test } from '@playwright/test';
import { createUser, openAs, settled } from './helpers';

/**
 * Avisos push no navegador (ADR 52). O serviço de push do Chrome não existe no teste, então o
 * PushManager é trocado por um de mentira: o que se prova aqui é o nosso caminho, da permissão à
 * assinatura gravada na conta, ao aviso de teste e ao desligar. O service worker de verdade
 * (/sw.js) é registrado e conferido à parte. Desktop e mobile.
 */

const FAKE_ENDPOINT = 'https://push.exemplo.test/e2e-aparelho';

/** Troca o PushManager do aparelho por um que assina na hora, sem serviço de push de verdade. */
const fakePushManager = `
  const subscription = {
    endpoint: ${JSON.stringify(FAKE_ENDPOINT)},
    toJSON() {
      return { endpoint: this.endpoint, keys: { p256dh: 'BChaveFalsaDeTeste000', auth: 'authFalso0' } };
    },
    unsubscribe: async () => { window.__pushAssinado = false; return true; },
  };
  Object.defineProperty(window, 'PushManager', { value: function PushManager() {}, configurable: true });
  const manager = {
    getSubscription: async () => (window.__pushAssinado ? subscription : null),
    subscribe: async () => { window.__pushAssinado = true; return subscription; },
  };
  Object.defineProperty(navigator.serviceWorker, 'register', {
    value: async () => ({ pushManager: manager }),
    configurable: true,
  });
  Object.defineProperty(navigator.serviceWorker, 'getRegistration', {
    value: async () => ({ pushManager: manager }),
    configurable: true,
  });
  Object.defineProperty(navigator.serviceWorker, 'ready', {
    get: () => Promise.resolve({ pushManager: manager }),
    configurable: true,
  });
`;

test('avisos no navegador: liga o aparelho, envia teste e desliga', async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(['notifications']);
  await page.addInitScript(fakePushManager);
  const user = await createUser(request, 'client');
  const headers = { Authorization: `Bearer ${user.token}` };
  const devices = async (): Promise<number> =>
    (
      (await (await request.get('/api/notifications/push', { headers })).json()) as {
        devices: number;
      }
    ).devices;
  expect(await devices()).toBe(0);

  await openAs(page, user, '/perfil');
  await settled(page);
  const card = page.getByTestId('push-card');
  await expect(card.getByTestId('push-devices')).toHaveText('0 aparelhos ligados');

  await card.getByRole('button', { name: 'Ligar avisos neste aparelho' }).click();
  await expect(page.locator('.toast', { hasText: 'este aparelho vai avisar você' })).toBeVisible();
  await expect(card.getByTestId('push-devices')).toHaveText('1 aparelho ligado');
  await expect.poll(devices).toBe(1);

  await card.getByRole('button', { name: 'Enviar aviso de teste' }).click();
  await expect(page.locator('.toast', { hasText: 'enviado para 1 aparelho' })).toBeVisible();

  await card.getByRole('button', { name: 'Desligar neste aparelho' }).click();
  await expect(page.locator('.toast', { hasText: 'desligados neste aparelho' })).toBeVisible();
  await expect(card.getByTestId('push-devices')).toHaveText('0 aparelhos ligados');
  await expect.poll(devices).toBe(0);
  await expect(card.getByRole('button', { name: 'Ligar avisos neste aparelho' })).toBeVisible();
});

test('o service worker dos avisos é servido e registra sem erro', async ({ page }) => {
  const sw = await page.request.get('/sw.js');
  expect(sw.ok(), await sw.text()).toBeTruthy();
  const body = await sw.text();
  expect(body).toContain("addEventListener('push'");
  expect(body).toContain("addEventListener('notificationclick'");

  await page.goto('/login');
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return typeof reg.scope === 'string' && 'pushManager' in reg;
  });
  expect(registered).toBe(true);
});
