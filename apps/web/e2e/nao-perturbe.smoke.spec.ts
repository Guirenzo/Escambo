import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled, topUp } from './helpers';

/**
 * "Não perturbe" nos avisos do navegador (ADR 54), com o PushManager de mentira do teste de push:
 * ligar o silêncio pelo cartão, trocar a hora, ver o aviso ficar guardado durante a janela e
 * desligar. A prova de "não enviou" e do resumo ao fim da janela fica na integração (o e2e não
 * roda os jobs). Desktop e mobile.
 */

const FAKE_ENDPOINT = 'https://push.exemplo.test/e2e-silencio';

const fakePushManager = `
  const subscription = {
    endpoint: ${JSON.stringify(FAKE_ENDPOINT)},
    toJSON() {
      return { endpoint: this.endpoint, keys: { p256dh: 'BChaveFalsaDeTeste000', auth: 'authFalso0' } };
    },
    unsubscribe: async () => { window.__pushAssinado = false; return true; },
  };
  Object.defineProperty(window, 'PushManager', { value: function PushManager() {}, configurable: true });
  Object.defineProperty(window, 'Notification', {
    value: Object.assign(function Notification() {}, {
      permission: 'granted',
      requestPermission: async () => 'granted',
    }),
    configurable: true,
  });
  const manager = {
    getSubscription: async () => (window.__pushAssinado ? subscription : null),
    subscribe: async () => { window.__pushAssinado = true; return subscription; },
  };
  Object.defineProperty(navigator.serviceWorker, 'register', { value: async () => ({ pushManager: manager }), configurable: true });
  Object.defineProperty(navigator.serviceWorker, 'getRegistration', { value: async () => ({ pushManager: manager }), configurable: true });
  Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve({ pushManager: manager }), configurable: true });
`;

const mod = (n: number): number => ((n % 24) + 24) % 24;

test('não perturbe: liga pelo cartão, guarda o aviso durante a janela e desliga', async ({
  page,
  request,
  context,
  baseURL,
}) => {
  await context.grantPermissions(['notifications'], { origin: baseURL });
  await page.addInitScript(fakePushManager);
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const headers = { Authorization: `Bearer ${freelancer.token}` };
  const prefs = async () =>
    (await (await request.get('/api/notifications/preferences', { headers })).json()) as {
      quietHours: { start: number; end: number } | null;
      timezone: string;
    };
  const held = async (): Promise<number> =>
    ((await (await request.get('/api/notifications/push', { headers })).json()) as { held: number })
      .held;

  await openAs(page, freelancer, '/perfil');
  await settled(page);
  const card = page.getByTestId('push-card');
  await card.scrollIntoViewIfNeeded();
  // O parágrafo avisa da transferência para o serviço de push, fora do Brasil (LGPD art. 33).
  await expect(card).toContainText('fora do Brasil');
  // Sem aparelho e sem janela, não há o que silenciar.
  await expect(page.getByTestId('push-quiet')).toHaveCount(0);

  await card.getByRole('button', { name: 'Ligar avisos neste aparelho' }).click();
  await expect(card.getByTestId('push-devices')).toContainText('1 aparelho ligado');
  const quiet = page.getByTestId('push-quiet');
  await expect(quiet).toBeVisible();

  // Marcar liga a noite (22h às 7h) e grava na conta.
  // O checkbox é controlado pela sessão: só vira depois que a API grava e a sessão recarrega,
  // então o clique, e não o check(), que exige a mudança na hora.
  await quiet.getByRole('checkbox', { name: 'Silenciar os avisos num horário' }).click();
  await expect(page.locator('.toast', { hasText: 'silêncio das 22:00 às 07:00' })).toBeVisible();
  await expect.poll(async () => (await prefs()).quietHours).toEqual({ start: 22, end: 7 });
  await expect(quiet).toContainText('(do dia seguinte)');

  // Trocar o fim persiste, e o começo não oferece a hora do fim.
  await quiet.getByRole('combobox', { name: 'Fim do silêncio' }).selectOption('6');
  await expect.poll(async () => (await prefs()).quietHours).toEqual({ start: 22, end: 6 });
  await page.reload();
  await settled(page);
  await expect(
    page.getByTestId('push-quiet').getByRole('combobox', { name: 'Fim do silêncio' }),
  ).toHaveValue('6');

  // Janela cobrindo o agora, no fuso da conta: um aviso pushado fica guardado, e o cartão diz.
  const zone = (await prefs()).timezone;
  const h = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(
      new Date(),
    ),
  );
  const res = await request.put('/api/notifications/preferences', {
    headers,
    data: { quietHours: { start: mod(h - 1), end: mod(h + 2) } },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  // A proposta de contratação é para o freelancer: é ele quem recebe o aviso.
  const service = await createService(request, freelancer, 100);
  await topUp(request, client, 100);
  const proposal = await request.post('/api/contracts', {
    headers: { Authorization: `Bearer ${client.token}` },
    data: {
      freelancerId: freelancer.id,
      serviceId: service.id,
      title: service.title,
      description: 'Proposta na madrugada: silêncio, por favor.',
      price: 100,
    },
  });
  expect(proposal.ok(), await proposal.text()).toBeTruthy();
  await expect.poll(held, { timeout: 10_000 }).toBe(1);

  await page.reload();
  await settled(page);
  await expect(page.getByTestId('push-quiet-now')).toContainText('1 aviso guardado');

  // Desligar descarta o guardado e volta a bater a qualquer hora.
  await page.getByTestId('push-quiet').getByRole('checkbox').click();
  await expect(page.locator('.toast', { hasText: 'voltam a bater a qualquer hora' })).toBeVisible();
  await expect.poll(async () => (await prefs()).quietHours).toBeNull();
  await expect.poll(held).toBe(0);
});
