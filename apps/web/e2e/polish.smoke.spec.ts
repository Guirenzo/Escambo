import { expect, test } from '@playwright/test';
import { browserClockNow, createService, createUser, openAs, settled, topUp } from './helpers';

/**
 * Polimento de marketplace: paginação da busca ("Carregar mais"), propor troca direto do card
 * e sair de todos os dispositivos. Mais o acabamento do app: título por tela, página 404 de
 * verdade e nenhuma requisição para fora. Rodam em desktop e mobile.
 */

test('cada tela tem o próprio título e a navegação é anunciada', async ({ page, request }) => {
  const user = await createUser(request, 'client');
  await openAs(page, user, '/');
  await settled(page);
  await expect(page).toHaveTitle('Início · Escambo');

  await page.getByRole('link', { name: 'Carteira' }).first().click();
  await expect(page).toHaveTitle('Carteira · Escambo');
  // Região viva repete o título para quem usa leitor de tela (o SPA não recarrega).
  await expect(page.getByTestId('route-announcer')).toHaveText('Carteira · Escambo');

  await page.goto('/servicos');
  await expect(page).toHaveTitle('Serviços · Escambo');
});

test('endereço inexistente mostra 404 com saída, em vez de redirecionar em silêncio', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  await openAs(page, user, '/pagina-que-nao-existe');
  await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page).toHaveTitle('Página não encontrada · Escambo');
  await page.getByRole('button', { name: 'Ir para o início' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page).toHaveTitle('Início · Escambo');
});

test('o app não carrega código nem fonte de terceiros (tudo empacotado, CSP fechada)', async ({
  page,
  request,
}) => {
  // Avatares de perfil podem apontar para qualquer host HTTPS (conteúdo do usuário); o que não
  // pode sair do domínio é código: script, folha de estilo, fonte ou requisição de dados.
  const DE_TERCEIROS = ['script', 'stylesheet', 'font', 'xhr', 'fetch', 'websocket'];
  const externas: string[] = [];
  page.on('request', (r) => {
    const host = new URL(r.url()).host;
    const fora = host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1');
    if (fora && DE_TERCEIROS.includes(r.resourceType())) {
      externas.push(`${r.resourceType()} ${r.url()}`);
    }
  });
  const user = await createUser(request, 'client');
  await openAs(page, user, '/');
  await settled(page);
  await page.goto('/servicos');
  await settled(page);
  expect(externas.join('\n')).toBe('');
});

test('busca pagina com "Carregar mais"', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  for (let i = 0; i < 13; i++) await createService(request, freelancer, 50 + i);
  const client = await createUser(request, 'client');

  await openAs(page, client, '/servicos');
  await settled(page);
  const cards = page.locator('.card.service');
  await expect(cards).toHaveCount(12);
  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect.poll(async () => cards.count()).toBeGreaterThan(12);
});

test('freelancer propõe troca a partir do card de outro freelancer', async ({ page, request }) => {
  const owner = await createUser(request, 'freelancer');
  const wanted = await createService(request, owner, 400);
  const me = await createUser(request, 'freelancer');
  const mine = await createService(request, me, 300);
  await topUp(request, me, 100); // ofereço 300 por 400: pago R$ 100 de torna, reservados na proposta

  await openAs(page, me, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(wanted.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const card = page.locator('.card.service', { hasText: wanted.title });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Propor troca' }).click();

  await expect(page).toHaveURL(/\/trocas/);
  await settled(page);
  const form = page.locator('form', { hasText: 'Nova proposta de troca' });
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Eu quero (serviço de outro freelancer)')).toHaveValue(
    String(wanted.id),
  );
  await form.getByLabel('Serviço que ofereço').selectOption(String(mine.id));
  await form.getByLabel('Valor estimado da minha oferta (R$)').fill('300');
  await expect(
    form.getByText('Você paga R$ 100,00 de torna · reservado da sua carteira agora'),
  ).toBeVisible();
  await form.getByRole('button', { name: 'Enviar proposta' }).click();
  await expect(page.locator('.toast', { hasText: 'Proposta de troca enviada' })).toBeVisible();
  const proposed = page.locator('.card.service', { hasText: 'Você propôs' });
  await expect(proposed).toBeVisible();
  await expect(proposed).toContainText('torna reservada');
});

test('sair de todos os dispositivos encerra a sessão atual', async ({ page, request }) => {
  const user = await createUser(request, 'client');
  await openAs(page, user, '/perfil');
  await settled(page);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Sair de todos os dispositivos' }).click();
  await expect(page).toHaveURL(/\/login/);
});

test('busca com filtros de preço e prazo e ordenação por menor preço', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const tag = `Filtro ${Date.now().toString(36)}`;
  await createService(request, freelancer, 300, 0, { title: `${tag} médio`, deliveryDays: 10 });
  await createService(request, freelancer, 100, 0, { title: `${tag} barato`, deliveryDays: 2 });
  await createService(request, freelancer, 900, 0, { title: `${tag} caro`, deliveryDays: 30 });
  const client = await createUser(request, 'client');

  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(tag);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const cards = page.locator('.card.service', { hasText: tag });
  await expect(cards).toHaveCount(3);

  // Menor preço: o barato primeiro; maior preço: o caro primeiro.
  const filters = page.getByTestId('filters');
  await filters.getByLabel('Ordenar por').selectOption('price_asc');
  await expect(cards.first()).toContainText('barato');
  await filters.getByLabel('Ordenar por').selectOption('price_desc');
  await expect(cards.first()).toContainText('caro');

  // Faixa de preço e prazo estreitam a lista; limpar volta aos três.
  await filters.getByLabel('Preço máximo').fill('500');
  await expect(cards).toHaveCount(2);
  await filters.getByLabel('Prazo máximo').selectOption('7');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('barato');
  await filters.getByLabel('Preço mínimo').fill('200');
  await expect(page.getByText('Nenhum serviço com esses filtros')).toBeVisible();
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(cards).toHaveCount(3);
});

test('busca por dia de atendimento: "quem atende sábado" só mostra quem marcou o dia', async ({
  page,
  request,
}) => {
  const tag = `Atende ${Date.now().toString(36)}`;
  const profile = (name: string, availableDays: number[] | null) => ({
    fullName: name,
    city: 'Joinville',
    isAvailable: true,
    availableDays,
  });
  const weekdays = await createUser(request, 'freelancer');
  const weekend = await createUser(request, 'freelancer');
  const silent = await createUser(request, 'freelancer'); // não informou os dias
  for (const [u, p] of [
    [weekdays, profile('Freela semana', [1, 2, 3, 4, 5])],
    [weekend, profile('Freela fim de semana', [0, 6])],
    [silent, profile('Freela sem dias', null)],
  ] as const) {
    const res = await request.put('/api/profiles/freelancer', {
      headers: { Authorization: `Bearer ${u.token}` },
      data: p,
    });
    expect(res.ok()).toBeTruthy();
  }
  await createService(request, weekdays, 100, 0, { title: `${tag} semana` });
  await createService(request, weekend, 100, 0, { title: `${tag} fim de semana` });
  await createService(request, silent, 100, 0, { title: `${tag} sem dias` });
  const client = await createUser(request, 'client');

  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(tag);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const cards = page.locator('.card.service', { hasText: tag });
  await expect(cards).toHaveCount(3);
  // O card diz quando cada um atende; quem não informou não ganha chip.
  await expect(cards.filter({ hasText: `${tag} semana` }).getByTestId('owner-days')).toHaveText(
    'atende seg a sex',
  );
  await expect(cards.filter({ hasText: 'sem dias' }).getByTestId('owner-days')).toHaveCount(0);

  const filters = page.getByTestId('filters');
  await filters.getByLabel('Atende no dia').selectOption('6'); // sábado
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('fim de semana');
  await expect(cards.first().getByTestId('owner-days')).toHaveText('atende dom, sáb');
  await filters.getByLabel('Atende no dia').selectOption('1'); // segunda
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(`${tag} semana`);
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(cards).toHaveCount(3);
});

test('busca por período do dia e "atende agora" (freelancers no fuso padrão, Brasília)', async ({
  page,
  request,
}) => {
  const tag = `Periodo ${Date.now().toString(36)}`;
  const everyDay = [0, 1, 2, 3, 4, 5, 6];
  const put = async (u: { token: string }, data: Record<string, unknown>) => {
    const res = await request.put('/api/profiles/freelancer', {
      headers: { Authorization: `Bearer ${u.token}` },
      data: { city: 'Joinville', ...data },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  };
  const allDay = await createUser(request, 'freelancer');
  const mornings = await createUser(request, 'freelancer');
  const paused = await createUser(request, 'freelancer');
  await put(allDay, { fullName: 'Freela dia todo', isAvailable: true, availableDays: everyDay });
  await put(mornings, {
    fullName: 'Freela manhãs',
    isAvailable: true,
    availableDays: [1],
    availablePeriods: { '1': ['morning'] },
  });
  await put(paused, { fullName: 'Freela pausado', isAvailable: false, availableDays: everyDay });
  await createService(request, allDay, 100, 0, { title: `${tag} dia todo` });
  await createService(request, mornings, 100, 0, { title: `${tag} manhãs` });
  await createService(request, paused, 100, 0, { title: `${tag} pausado` });
  const client = await createUser(request, 'client');

  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(tag);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const cards = page.locator('.card.service', { hasText: tag });
  await expect(cards).toHaveCount(3);
  await expect(cards.filter({ hasText: `${tag} manhãs` }).getByTestId('owner-days')).toHaveText(
    'atende seg · manhã',
  );

  // Período só com o dia: segunda à noite → quem atende o dia todo (pausado também: o filtro
  // de dia é sobre a agenda marcada; "agora" é que olha a pausa).
  const filters = page.getByTestId('filters');
  await expect(filters.getByLabel('Período do dia')).toBeDisabled();
  await filters.getByLabel('Atende no dia').selectOption('1');
  await filters.getByLabel('Período do dia').selectOption('evening');
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: `${tag} manhãs` })).toHaveCount(0);
  await filters.getByLabel('Período do dia').selectOption('morning');
  await expect(cards).toHaveCount(3);

  // Atende agora: aceitando pedidos, no dia e período de agora (madrugada: ninguém).
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(cards).toHaveCount(3);
  await page.getByRole('button', { name: 'Atende agora' }).click();
  await expect(page.getByRole('button', { name: 'Atende agora' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const { day, hour } = browserClockNow();
  const expected = hour < 6 ? 0 : 1 + (day === 1 && hour < 12 ? 1 : 0);
  if (expected === 0) {
    await expect(page.getByText('Nenhum serviço com esses filtros')).toBeVisible();
  } else {
    await expect(cards).toHaveCount(expected);
    await expect(cards.filter({ hasText: `${tag} dia todo` }).getByTestId('owner-now')).toHaveText(
      'atende agora',
    );
  }
  await expect(cards.filter({ hasText: `${tag} pausado` })).toHaveCount(0);
});
