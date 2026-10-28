import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { audit } from './a11y.helpers';
import { createUser, settled } from './helpers';

/**
 * Login com Google (RF-002), de ponta a ponta, desktop e mobile. Desligado (o padrão), o botão não
 * aparece e as rotas do Google não existem. Ligado, a API aponta para o Google FALSO dos testes
 * (e2e/google-falso.mjs, só em 127.0.0.1, com GOOGLE_TEST_IDP_URL): a pessoa escolhe a conta
 * na "tela do Google" e volta pelo servidor. Cobre entrar com uma conta que já existe e concluir o
 * cadastro de uma conta nova, com o axe no login, em "Concluir cadastro" e no cartão do Perfil.
 *
 * Os testes do fluxo ligado só rodam com a API ligada ao Google falso; o do desligado roda sempre
 * (com a API ligada, a resposta "desligado" é simulada para o app, e o 404 das rotas fica com a
 * integração da API).
 */

const unique = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function googleOn(request: APIRequestContext): Promise<boolean> {
  const res = await request.get('/api/auth/providers');
  return res.ok() && ((await res.json()) as { google?: boolean }).google === true;
}

/** Na "tela do Google" (o falso): escolhe a conta e continua. */
async function chooseGoogleAccount(page: Page, email: string, name?: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Google falso (testes)' })).toBeVisible();
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  if (name) await page.getByLabel('Nome').fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
}

const consent = (page: Page) =>
  page.getByRole('checkbox', { name: 'Li e aceito os Termos de Uso e a Política de Privacidade.' });

test('login com Google desligado: o botão não aparece', async ({ page, request }) => {
  if (await googleOn(request)) {
    await page.route('**/api/auth/providers', (route) =>
      route.fulfill({ json: { google: false } }),
    );
  } else {
    const start = await request.get('/api/auth/google/start', { maxRedirects: 0 });
    expect(start.status()).toBe(404);
  }
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Bem-vindo de volta' })).toBeVisible();
  // A resposta da API já chegou (o botão some depois dela, não antes).
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('link', { name: /Google/ })).toHaveCount(0);
  await page.goto('/cadastro');
  await expect(page.getByRole('heading', { name: 'Crie sua conta' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('link', { name: /Google/ })).toHaveCount(0);
});

test.describe('login com Google ligado (Google falso)', () => {
  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await googleOn(request)),
      'API sem o login com Google (suba com o Google falso: e2e/google-falso.mjs)',
    );
  });

  test('conta que já existe entra pelo Google, e o login com o botão passa no axe', async ({
    page,
    request,
  }) => {
    const user = await createUser(request, 'client');
    await page.goto('/login');
    const button = page.getByRole('link', { name: 'Entrar com Google' });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('href', '/api/auth/google/start');
    expect(await audit(page, 'login com o botão do Google')).toEqual([]);

    await button.click();
    await chooseGoogleAccount(page, user.email);

    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole('heading', { name: /^(Bom dia|Boa tarde|Boa noite),/ }),
    ).toBeVisible();
    await settled(page);

    // O Perfil mostra a conta vinculada; a senha continua (a conta já era confirmada).
    await page.goto('/perfil');
    const card = page.getByTestId('google-card');
    await expect(card).toContainText('Vinculado');
    await expect(card).toContainText('A senha continua valendo.');
    await expect(page.getByRole('form', { name: 'Trocar senha' })).toBeVisible();
  });

  test('conta nova: concluir o cadastro (papel e aceite) e entrar, sem senha', async ({ page }) => {
    const email = `e2e-google-${unique()}@gmail.com`;
    await page.goto('/cadastro?perfil=freelancer');
    await page.getByRole('link', { name: 'Criar conta com Google' }).click();
    await chooseGoogleAccount(page, email, 'Ana Google');

    const heading = page.getByRole('heading', { name: 'Concluir cadastro' });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    // O código de uso único já saiu do endereço.
    await expect(page).toHaveURL(/\/entrar\/google$/);
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText(/Falta pouco, Ana\./)).toBeVisible();
    // O "Eu sou" escolhido no cadastro veio junto.
    await expect(page.getByLabel('Eu sou')).toHaveValue('freelancer');
    const create = page.getByRole('button', { name: 'Criar conta' });
    await expect(create).toBeDisabled();
    expect(await audit(page, 'concluir cadastro pelo Google')).toEqual([]);

    await consent(page).check();
    await create.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole('heading', { name: /^(Bom dia|Boa tarde|Boa noite),/ }),
    ).toBeVisible();
    await settled(page);

    // No Perfil: vinculada, sem senha (o caminho é o "Esqueci minha senha"), e o nome do Google
    // sugerido para o perfil.
    await page.goto('/perfil');
    await expect(page.getByTestId('google-card')).toContainText('Vinculado');
    const noPassword = page.getByTestId('sem-senha');
    await expect(noPassword).toBeVisible();
    await expect(noPassword.getByRole('link', { name: 'Criar uma senha' })).toHaveAttribute(
      'href',
      '/esqueci-senha',
    );
    await expect(page.getByRole('form', { name: 'Trocar senha' })).toHaveCount(0);
    expect(
      await audit(page, 'Perfil de conta do Google', { include: '[data-testid="google-card"]' }),
    ).toEqual([]);
    expect(
      await audit(page, 'cartão Senha sem senha', { include: '[data-testid="sem-senha"]' }),
    ).toEqual([]);

    // Sair e entrar de novo pelo Google: a conta já vinculada entra direto.
    await page.evaluate(() => window.localStorage.clear());
    await page.goto('/login');
    await page.getByRole('link', { name: 'Entrar com Google' }).click();
    await chooseGoogleAccount(page, email);
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole('heading', { name: /^(Bom dia|Boa tarde|Boa noite),/ }),
    ).toBeVisible();
  });

  test('desistir na tela do Google volta ao login com o aviso', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Entrar com Google' }).click();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('alert')).toContainText('O login com o Google foi cancelado.');
  });
});
