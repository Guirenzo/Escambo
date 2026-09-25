import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled, topUp, type TestUser } from './helpers';

/**
 * "Não perturbe" nos avisos do navegador (ADR 54), com o PushManager de mentira do teste de push:
 * ligar o silêncio pelo cartão, trocar a hora, ver o aviso ficar guardado durante a janela e
 * desligar. A prova de "não enviou" e do resumo ao fim da janela fica na integração (o e2e não
 * roda os jobs). O que sai mesmo no silêncio (ADR 56): vem marcado para quem entrega trabalho,
 * desmarcar persiste, a conta de antes escolhe e quem só contrata não vê — o caminho que sai de
 * fato é provado na integração (quiet-pass.int.test.ts). Desktop e mobile.
 */

const FAKE_ENDPOINT = 'https://push.exemplo.test/e2e-silencio';

const fakePushManager = (endpoint = FAKE_ENDPOINT) => `
  const subscription = {
    endpoint: ${JSON.stringify(endpoint)},
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
  await page.addInitScript(fakePushManager());
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const headers = { Authorization: `Bearer ${freelancer.token}` };
  const prefs = async () =>
    (await (await request.get('/api/notifications/preferences', { headers })).json()) as {
      quietHours: { start: number; end: number } | null;
      quietPass: string[] | null;
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
  // Quem entrega trabalho liga com o prazo vencido marcado (ADR 56), e a mensagem diz isso.
  await expect(page.locator('.toast', { hasText: 'sai na hora' })).toBeVisible();
  await expect.poll(async () => (await prefs()).quietPass).toEqual(['deadline']);
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
  await page
    .getByTestId('push-quiet')
    .getByRole('checkbox', { name: 'Silenciar os avisos num horário' })
    .click();
  await expect(page.locator('.toast', { hasText: 'voltam a bater a qualquer hora' })).toBeVisible();
  await expect.poll(async () => (await prefs()).quietHours).toBeNull();
  await expect.poll(held).toBe(0);
});

/** Liga os avisos pelo cartão, num aparelho de mentira só desta pessoa. */
async function withDevice(
  page: import('@playwright/test').Page,
  user: TestUser,
  baseURL: string | undefined,
): Promise<void> {
  await page.context().grantPermissions(['notifications'], { origin: baseURL });
  await page.addInitScript(fakePushManager(`https://push.exemplo.test/e2e-passa-${user.id}`));
  await openAs(page, user, '/perfil');
  await settled(page);
  const card = page.getByTestId('push-card');
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('button', { name: 'Ligar avisos neste aparelho' }).click();
  await expect(card.getByTestId('push-devices')).toContainText('1 aparelho ligado');
}

const quietPassOf = async (request: import('@playwright/test').APIRequestContext, user: TestUser) =>
  (
    (await (
      await request.get('/api/notifications/preferences', {
        headers: { Authorization: `Bearer ${user.token}` },
      })
    ).json()) as { quietPass: string[] | null }
  ).quietPass;

test('o que sai no silêncio: vem marcado para quem entrega, e desmarcar persiste', async ({
  page,
  request,
  baseURL,
  isMobile,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  await withDevice(page, freelancer, baseURL);
  const quiet = page.getByTestId('push-quiet');
  await quiet.getByRole('checkbox', { name: 'Silenciar os avisos num horário' }).click();
  const grupo = page.getByTestId('push-quiet-pass');
  const caixa = grupo.getByRole('checkbox', {
    name: 'Prazo vencido num trabalho que você entrega',
  });
  await expect(caixa).toBeChecked();
  await expect(grupo).toContainText('prioridade alta');
  if (isMobile) {
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }

  await caixa.click();
  await expect(
    page.locator('.toast', { hasText: 'também espera, e vem primeiro no aviso das' }),
  ).toBeVisible();
  await expect.poll(() => quietPassOf(request, freelancer)).toEqual([]);
  await page.reload();
  await settled(page);
  await expect(
    page
      .getByTestId('push-quiet-pass')
      .getByRole('checkbox', { name: 'Prazo vencido num trabalho que você entrega' }),
  ).not.toBeChecked();
});

test('o que sai no silêncio: a conta de antes vê a opção desmarcada e escolhe', async ({
  page,
  request,
  baseURL,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  await withDevice(page, freelancer, baseURL);
  // A janela gravada sem escolha: é como ficou quem ligou o silêncio sob a Política 1.3.
  const res = await request.put('/api/notifications/preferences', {
    headers: { Authorization: `Bearer ${freelancer.token}` },
    data: { quietHours: { start: 22, end: 7 } },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  await page.reload();
  await settled(page);
  const caixa = page
    .getByTestId('push-quiet-pass')
    .getByRole('checkbox', { name: 'Prazo vencido num trabalho que você entrega' });
  await expect(caixa).not.toBeChecked();
  await expect(page.getByTestId('push-quiet')).toContainText(
    'menos o que estiver marcado logo abaixo',
  );
  await caixa.click();
  await expect(page.locator('.toast', { hasText: 'sai na hora, mesmo no silêncio' })).toBeVisible();
  await expect.poll(() => quietPassOf(request, freelancer)).toEqual(['deadline']);
});

test('o que sai no silêncio: quem só contrata não vê a escolha', async ({
  page,
  request,
  baseURL,
}) => {
  const client = await createUser(request, 'client');
  await withDevice(page, client, baseURL);
  await page
    .getByTestId('push-quiet')
    .getByRole('checkbox', { name: 'Silenciar os avisos num horário' })
    .click();
  const toast = page.locator('.toast', { hasText: 'silêncio das 22:00 às 07:00' });
  await expect(toast).toBeVisible();
  await expect(toast).not.toContainText('sai na hora');
  await expect(page.getByTestId('push-quiet-pass')).toHaveCount(0);
  await expect.poll(() => quietPassOf(request, client)).toBeNull();
});
