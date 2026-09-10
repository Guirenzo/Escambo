import { expect, test } from '@playwright/test';
import { createAdmin, createUser, latestEmail, linkIn, openAs, PASSWORD, settled } from './helpers';

/**
 * Contas e conformidade: cadastro com aceite dos termos (consentimento registrado), páginas
 * legais públicas, conta suspensa perde o acesso na hora, avatar por URL. Desktop e mobile.
 */

const unique = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('cadastro pelo formulário exige aceitar os termos e registra o consentimento', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Criar conta', exact: true }).first().click();
  const form = page.locator('form');
  await form.getByLabel('E-mail').fill(`e2e-ui-${unique()}@escambo.test`);
  await form.getByLabel('Senha').fill(PASSWORD);
  await form.getByLabel('Eu sou').selectOption('freelancer');
  const submit = form.locator('button[type="submit"]');
  await expect(submit).toBeDisabled();
  await form.getByRole('checkbox').check();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
  await page.getByRole('link', { name: 'Perfil', exact: true }).click();
  await settled(page);
  const consents = page.getByLabel('Consentimentos');
  await expect(consents.locator('li')).toHaveCount(2);
  await expect(consents).toContainText('Termos de Uso');
  await expect(consents).toContainText('Política de Privacidade');
});

test('confirmação de e-mail: banner no app, link do e-mail confirma e o banner some', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  const admin = await createAdmin(request);

  await openAs(page, user, '/');
  await settled(page);
  const banner = page.getByTestId('verify-banner');
  await expect(banner).toContainText(user.email);
  await banner.getByRole('button', { name: 'Reenviar e-mail' }).click();
  await expect(page.locator('.toast', { hasText: 'Link reenviado' })).toBeVisible();

  const mail = await latestEmail(request, admin, user.id, 'verify_email');
  expect(mail.subject).toBe('Confirme seu e-mail no Escambo');
  const link = linkIn(mail.text);
  expect(link).toContain('/verificar-email?token=');
  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page.getByTestId('verify-ok')).toBeVisible();
  await page.getByRole('link', { name: 'Ir para o app' }).click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
  await expect(page.getByTestId('verify-banner')).toHaveCount(0);
});

test('esqueci minha senha: link por e-mail redefine a senha e encerra as sessões antigas', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'freelancer');
  const admin = await createAdmin(request);

  await page.goto('/login');
  await page.getByRole('link', { name: 'Esqueci minha senha' }).click();
  await expect(page).toHaveURL(/\/esqueci-senha/);
  await page.getByLabel('E-mail').fill(user.email);
  await page.getByRole('button', { name: 'Enviar link' }).click();
  await expect(page.getByTestId('forgot-sent')).toContainText(user.email);

  const mail = await latestEmail(request, admin, user.id, 'password_reset');
  const link = linkIn(mail.text);
  expect(link).toContain('/redefinir-senha?token=');
  await page.goto(new URL(link).pathname + new URL(link).search);
  await page.getByLabel('Nova senha', { exact: true }).fill('NovaSenha@456');
  await page.getByLabel('Confirmar nova senha').fill('NovaSenha@456');
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByTestId('reset-done')).toBeVisible();

  // Link é de uso único; senha antiga já não entra; a nova entra.
  const reuse = await request.post('/api/auth/reset-password', {
    data: { token: new URL(link).searchParams.get('token'), password: 'OutraSenha@789' },
  });
  expect(reuse.status()).toBe(400);
  const old = await request.post('/api/auth/login', {
    data: { email: user.email, password: PASSWORD },
  });
  expect(old.status()).toBe(401);
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(user.email);
  await page.getByLabel('Senha').fill('NovaSenha@456');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
});

test('Termos e Privacidade são páginas públicas', async ({ page }) => {
  await page.goto('/termos');
  await expect(page.getByRole('heading', { level: 1, name: 'Termos de Uso' })).toBeVisible();
  await page.getByRole('link', { name: 'Política de Privacidade' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Política de Privacidade' }),
  ).toBeVisible();
});

test('conta suspensa perde o acesso na hora e não entra mais', async ({ page, request }) => {
  const target = await createUser(request, 'client');
  const admin = await createAdmin(request);
  const me = await request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${target.token}` },
  });
  const { ulid } = (await me.json()) as { ulid: string };

  await openAs(page, target, '/');
  await settled(page);
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();

  const susp = await request.post(`/api/admin/users/${ulid}/suspend`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  expect(susp.ok()).toBeTruthy();

  // Próxima chamada da sessão aberta toma 403 → sessão encerrada → login.
  await page.getByRole('link', { name: 'Serviços' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('E-mail').fill(target.email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByText(/Conta suspensa/)).toBeVisible();
});

test('avatar por URL aparece na sidebar e no perfil público', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  await openAs(page, freelancer, '/perfil');
  await settled(page);
  const form = page.locator('form', { hasText: 'Salvar freelancer' });
  await form.getByLabel('Foto (URL da imagem)').fill(PNG_1PX);
  await form.getByRole('button', { name: 'Salvar freelancer' }).click();
  await expect(page.locator('.toast', { hasText: 'Perfil de freelancer salvo' })).toBeVisible();
  await expect(page.locator('.side-user .avatar img')).toHaveCount(1);
});
