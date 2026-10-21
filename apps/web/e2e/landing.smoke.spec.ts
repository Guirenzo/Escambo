import { expect, test } from '@playwright/test';
import { expectAccessible } from './a11y.helpers';
import { createService, createUser, openLanding, PASSWORD } from './helpers';

/**
 * Página inicial pública v2, de ponta a ponta: a busca do topo filtra a vitrine de serviços reais
 * sem pedir login (o cartão leva ao serviço, e o app pede o login e volta), os atalhos das
 * categorias, o estado vazio com saída, a localização pedida só no clique, as abas do "Como
 * funciona" pelo teclado e a calculadora da torna com a taxa da API, anunciada em região viva.
 */

const unique = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.use({
  geolocation: { latitude: -26.3045, longitude: -48.8487 },
  permissions: ['geolocation'],
});

test('a busca do topo filtra a vitrine sem login, e o cartão leva ao serviço depois de entrar', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const title = `Vitrine e2e ${unique()}`;
  const service = await createService(request, freelancer, 480, 0, { title });
  const client = await createUser(request, 'client');

  await openLanding(page);
  const status = page.getByTestId('vitrine-status');
  await expect(status).not.toHaveText('Carregando serviços…');

  const search = page.getByRole('search', { name: 'Buscar serviços' });
  await search.getByLabel('O que você precisa?').fill(title);
  await search.getByRole('button', { name: 'Buscar' }).click();
  // O resultado aparece na vitrine, e o foco vai para o título dela.
  const heading = page.getByRole('heading', { level: 2, name: 'Resultados da busca' });
  await expect(heading).toBeFocused();
  await expect(status).toHaveText('1 serviço encontrado.');
  const vitrine = page.locator('#vitrine');
  await expect(vitrine.getByRole('list', { name: 'Filtros da vitrine' })).toContainText(title);
  await expect(vitrine.getByRole('link', { name: 'Ver todos os serviços' })).toHaveAttribute(
    'href',
    `/servicos?q=${encodeURIComponent(title).replace(/%20/g, '+')}`,
  );

  // Sem sessão, o serviço pede o login e volta para ele.
  await vitrine.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('E-mail').fill(client.email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`/servicos/${service.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
});

test('atalho de categoria filtra a vitrine, a busca sem resultado tem saída e tudo volta ao limpar', async ({
  page,
}) => {
  await openLanding(page);
  const shortcuts = page.getByRole('group', { name: 'Atalhos' });
  const first = shortcuts.getByRole('button').first();
  const name = (await first.textContent())!.trim();
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  const vitrine = page.locator('#vitrine');
  await expect(vitrine.getByRole('link', { name: 'Ver todos os serviços' })).toHaveAttribute(
    'href',
    /\/servicos\?categoria=\d+$/,
  );
  await expect(vitrine.getByRole('list', { name: 'Filtros da vitrine' })).toContainText(name);

  // Uma busca que não acha nada: estado vazio com a saída, sem número inventado.
  const nothing = `nada-${unique()}`;
  await page.getByLabel('O que você precisa?').fill(nothing);
  await page.getByLabel('O que você precisa?').press('Enter');
  await expect(page.getByTestId('vitrine-status')).toHaveText('Nenhum serviço encontrado.');
  await expect(vitrine.getByText(`Nada encontrado para “${nothing}” em ${name}`)).toBeVisible();
  await expect(vitrine.getByRole('link', { name: 'Publicar o primeiro serviço' })).toHaveAttribute(
    'href',
    '/cadastro?perfil=freelancer',
  );
  await expectAccessible(page, 'página inicial: vitrine vazia');

  await vitrine.getByRole('button', { name: 'Limpar os filtros' }).click();
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('O que você precisa?')).toHaveValue('');
  await expect(page.getByRole('heading', { level: 2, name: 'Descubra serviços' })).toBeVisible();
});

test('"Usar minha localização" só pede no clique e ordena a vitrine por distância', async ({
  page,
}) => {
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/services?')) asked.push(r.url());
  });
  await openLanding(page);
  await expect(page.getByTestId('vitrine-status')).not.toHaveText('Carregando serviços…');
  // Ao abrir, nenhuma posição sai do navegador.
  expect(asked.every((u) => !u.includes('lat='))).toBe(true);

  const nearby = page.waitForRequest((r) => /\/api\/services\?.*lat=/.test(r.url()));
  await page.getByRole('button', { name: 'Usar minha localização' }).click();
  const url = new URL((await nearby).url());
  expect(url.searchParams.get('sort')).toBe('distance');
  expect(url.searchParams.get('radiusKm')).toBe('50');
  expect(Number(url.searchParams.get('lat'))).toBeCloseTo(-26.3045, 3);
  await expect(page.getByRole('heading', { level: 2, name: 'Perto de você' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Filtros da vitrine' }).getByText('Perto de você'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Tirar a localização' }).click();
  await expect(page.getByRole('button', { name: 'Usar minha localização' })).toBeVisible();
});

test('"Como funciona": as abas andam pelo teclado e cada painel tem passos e uma saída', async ({
  page,
}) => {
  await openLanding(page);
  const tabs = page.getByRole('tablist', { name: 'Escolha o seu lado' });
  const contratar = tabs.getByRole('tab', { name: 'Contratar' });
  await contratar.scrollIntoViewIfNeeded();
  await contratar.focus();
  await expect(contratar).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  const oferecer = tabs.getByRole('tab', { name: 'Oferecer' });
  await expect(oferecer).toBeFocused();
  await expect(oferecer).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Oferecer' })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Contratar' })).toBeHidden();
  await page.keyboard.press('End');
  const trocar = tabs.getByRole('tab', { name: 'Trocar' });
  await expect(trocar).toBeFocused();
  // Do tablist, o Tab entra no painel (a aba escolhida é a única parada da lista).
  await page.keyboard.press('Tab');
  const more = page.getByRole('tabpanel', { name: 'Trocar' }).getByRole('link', {
    name: 'Simular a torna',
  });
  await expect(more).toBeFocused();
  await expectAccessible(page, 'página inicial: aba Trocar');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#troca$/);
});

test('calculadora da torna: a taxa vem da API e o resultado é anunciado em região viva', async ({
  page,
  request,
}) => {
  const fee = (
    (await (await request.get('/api/settings/public')).json()) as { platformFeePercentage: number }
  ).platformFeePercentage;
  const torna = 500.5;
  const feeValue = Math.round(torna * fee) / 100;
  const brl = (n: number) =>
    n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });
  const plain = (s: string) => s.replace(/\s/g, ' ');

  await openLanding(page);
  const calc = page.getByRole('group', { name: 'Simule a torna' });
  await calc.scrollIntoViewIfNeeded();
  await calc.getByLabel('Você oferece').fill('1.000');
  await calc.getByLabel('Você quer').fill('1.500,50');
  const result = page.getByTestId('torna-resultado');
  await expect(result).toContainText(plain(`Você completa ${brl(torna)}`).replace(',00', ''));
  const live = page.getByTestId('torna-anuncio');
  await expect(live).toHaveAttribute('role', 'status');
  await expect
    .poll(async () => plain((await live.textContent()) ?? ''))
    .toContain(
      plain(
        `Torna de ${brl(torna)}: você completa. A taxa de ${fee.toLocaleString('pt-BR')}% é ${brl(feeValue)}`,
      ),
    );

  // Valor que não é número: o campo diz o que está errado.
  await calc.getByLabel('Você oferece').fill('mil reais');
  await expect(calc.getByLabel('Você oferece')).toHaveAttribute('aria-invalid', 'true');
  await expect(calc.getByLabel('Você oferece')).toHaveAccessibleDescription(
    /Digite um valor em reais/,
  );
  await expectAccessible(page, 'página inicial: calculadora com valor inválido');
});
