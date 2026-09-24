import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createUser, openAs, settled } from './helpers';

/**
 * Política de Privacidade 1.3 comunicada na plataforma (ADR 54): conta nova não vê faixa (o
 * cadastro já registra a versão vigente); quem respondeu a uma versão antiga vê a faixa, lê a
 * política com o histórico, e "Li e aceito" ou "Não aceito" registram e encerram a faixa em
 * todos os aparelhos. Desktop e mobile.
 */

test('política 1.3: faixa para quem está na versão antiga, aceite registrado no perfil', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  const headers = { Authorization: `Bearer ${user.token}` };

  // Conta criada pela API já nasce na 1.3: nada de faixa.
  await openAs(page, user, '/');
  await settled(page);
  await expect(page.getByTestId('legal-banner')).toHaveCount(0);

  // O registro mais recente passa a ser a 1.2: é como uma conta antiga entra hoje.
  const old = await request.post('/api/lgpd/consents', {
    headers,
    data: { type: 'privacy_policy', version: '1.2', accepted: true },
  });
  expect(old.ok(), await old.text()).toBeTruthy();
  await page.reload();
  await settled(page);
  const banner = page.getByRole('region', { name: 'Atualização da Política de Privacidade' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('versão 1.3');
  await expect(banner).toContainText('avisos no navegador');

  // A faixa passa no axe e o link leva ao texto com o histórico.
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="legal-banner"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
  const [policy] = await Promise.all([
    page.context().waitForEvent('page'),
    banner.getByRole('link', { name: 'Ler a política' }).click(),
  ]);
  await policy.waitForLoadState();
  await expect(policy.getByRole('heading', { level: 1 })).toHaveText('Política de Privacidade');
  await expect(policy.getByText(/Versão 1\.3 · atualizada em 2026-09-24/)).toBeVisible();
  await expect(policy.getByRole('heading', { name: 'Histórico de versões' })).toBeVisible();
  await expect(policy.getByText('6. Alterações desta política')).toBeVisible();
  await policy.close();

  // "Li e aceito": some, fica sumida ao recarregar, e aparece no Perfil como aceita.
  await banner.getByRole('button', { name: 'Li e aceito' }).click();
  await expect(
    page.locator('.toast', { hasText: 'fica registrada nos seus consentimentos' }),
  ).toBeVisible();
  await expect(page.getByTestId('legal-banner')).toHaveCount(0);
  await page.reload();
  await settled(page);
  await expect(page.getByTestId('legal-banner')).toHaveCount(0);
  await page.getByRole('link', { name: 'Perfil', exact: true }).click();
  await settled(page);
  const consents = page.getByLabel('Consentimentos');
  await expect(consents.locator('li').first()).toContainText('Política de Privacidade · v1.3');
  await expect(consents.locator('li').first()).toContainText('aceito em');

  // Os Termos não mudaram: a página pública continua na 1.2.
  await page.goto('/termos');
  await expect(page.getByText(/Versão 1\.2 · atualizada em 2026-09-09/)).toBeVisible();
});

test('política 1.3: "Não aceito" também registra e encerra a faixa', async ({ page, request }) => {
  const user = await createUser(request, 'freelancer');
  const headers = { Authorization: `Bearer ${user.token}` };
  const old = await request.post('/api/lgpd/consents', {
    headers,
    data: { type: 'privacy_policy', version: '1.1', accepted: true },
  });
  expect(old.ok(), await old.text()).toBeTruthy();

  await openAs(page, user, '/');
  await settled(page);
  const banner = page.getByRole('region', { name: 'Atualização da Política de Privacidade' });
  await expect(banner).toBeVisible();
  // Quem está na 1.1 ouve também o que a 1.2 trouxe.
  await expect(banner).toContainText('Cópia de dados baixável');
  await banner.getByRole('button', { name: 'Não aceito' }).click();
  await expect(
    page.locator('.toast', { hasText: 'desligar os avisos no navegador' }),
  ).toBeVisible();
  await expect(page.getByTestId('legal-banner')).toHaveCount(0);

  await page.getByRole('link', { name: 'Perfil', exact: true }).click();
  await settled(page);
  await expect(page.getByLabel('Consentimentos').locator('li').first()).toContainText(
    'recusado em',
  );
  const list = (await (await request.get('/api/lgpd/consents', { headers })).json()) as {
    type: string;
    version: string;
    accepted: boolean;
  }[];
  expect(list[0]).toMatchObject({ type: 'privacy_policy', version: '1.3', accepted: false });
});
