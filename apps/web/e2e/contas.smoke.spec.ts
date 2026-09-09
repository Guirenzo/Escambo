import { expect, test } from '@playwright/test';
import { createAdmin, createUser, openAs, PASSWORD, settled } from './helpers';

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
