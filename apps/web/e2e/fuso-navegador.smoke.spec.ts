import { expect, test } from '@playwright/test';
import { createUser, openAs, PASSWORD, settled, type TestUser } from './helpers';

/**
 * Fuso detectado pelo navegador (ADR 51), com o navegador em Manaus: o cadastro pelo formulário
 * já grava o fuso de Manaus, sem perguntar nada; a conta antiga, que nunca escolheu fuso, vê uma
 * sugestão única, e qualquer resposta grava a escolha e a sugestão não volta. Desktop e mobile.
 */
test.use({ timezoneId: 'America/Manaus' });

const me = async (
  request: import('@playwright/test').APIRequestContext,
  user: TestUser,
): Promise<{ timezone: string; timezoneChosen: boolean }> =>
  (
    await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${user.token}` } })
  ).json();

test('cadastro pelo formulário com o navegador em Manaus já grava o fuso de Manaus', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Criar conta', exact: true }).first().click();
  const form = page.locator('form');
  await form.getByLabel('E-mail').fill(`e2e-fuso-${Date.now().toString(36)}@escambo.test`);
  await form.getByLabel('Senha').fill(PASSWORD);
  await form.getByRole('checkbox').check();
  await form.locator('button[type="submit"]').click();
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
  // Nada a sugerir: a conta já nasceu no fuso do aparelho.
  await expect(page.getByTestId('timezone-banner')).toHaveCount(0);

  await page.getByRole('link', { name: 'Perfil', exact: true }).click();
  await settled(page);
  await expect(page.getByTestId('email-prefs')).toContainText('Horário de Manaus.');
  await expect(page.getByTestId('email-prefs').getByLabel('Fuso horário')).toHaveValue(
    'America/Manaus',
  );
});

test('conta antiga sem fuso escolhido: sugestão única, "Usar" grava Manaus e "Manter" grava Brasília', async ({
  page,
  request,
}) => {
  // Conta criada pela API, sem fuso: está no padrão de Brasília e nunca escolheu.
  const freela = await createUser(request, 'freelancer');
  expect(await me(request, freela)).toMatchObject({
    timezone: 'America/Sao_Paulo',
    timezoneChosen: false,
  });

  await openAs(page, freela, '/');
  await settled(page);
  const banner = page.getByRole('region', { name: 'Sugestão de fuso horário' });
  await expect(banner).toContainText('Seu aparelho está no horário de Manaus');
  await expect(banner).toContainText(
    'no resumo por e-mail, nos avisos e na sua agenda de atendimento?',
  );
  await banner.getByRole('button', { name: 'Usar horário de Manaus' }).click();
  await expect(page.locator('.toast', { hasText: 'agora usa o horário de Manaus' })).toBeVisible();
  await expect(banner).toHaveCount(0);
  expect(await me(request, freela)).toMatchObject({
    timezone: 'America/Manaus',
    timezoneChosen: true,
  });
  await page.reload();
  await settled(page);
  // Só afirma que a faixa não voltou depois de a sessão carregar (a saudação da home depende dela).
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
  await expect(page.getByTestId('timezone-banner')).toHaveCount(0);

  // Outra conta prefere continuar em Brasília: também não pergunta de novo.
  const client = await createUser(request, 'client');
  await openAs(page, client, '/');
  await settled(page);
  const again = page.getByRole('region', { name: 'Sugestão de fuso horário' });
  await expect(again).toContainText('no resumo por e-mail e nos avisos?');
  await expect(again).not.toContainText('agenda de atendimento');
  await again.getByRole('button', { name: 'Manter Brasília' }).click();
  await expect(
    page.locator('.toast', { hasText: 'continua no horário de Brasília' }),
  ).toBeVisible();
  await expect(again).toHaveCount(0);
  expect(await me(request, client)).toMatchObject({
    timezone: 'America/Sao_Paulo',
    timezoneChosen: true,
  });
  await page.reload();
  await settled(page);
  // Só afirma que a faixa não voltou depois de a sessão carregar (a saudação da home depende dela).
  await expect(page.getByRole('heading', { name: /^Olá,/ })).toBeVisible();
  await expect(page.getByTestId('timezone-banner')).toHaveCount(0);
});
