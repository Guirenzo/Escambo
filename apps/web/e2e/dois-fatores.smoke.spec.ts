import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { audit } from './a11y.helpers';
import { createAdmin, createUser, openAs, PASSWORD, settled, type TestUser } from './helpers';

/**
 * Verificação em duas etapas (RF-090, RNF-042, ADR 66), de ponta a ponta: ativar no Perfil lendo
 * a chave da própria tela, sair, entrar com a senha e o código do app, e entrar com um código de
 * recuperação (que vale uma vez só). O código é calculado aqui mesmo, como um app autenticador
 * faria (RFC 6238: HMAC-SHA1, passo de 30 s, 6 dígitos). O axe confere o cartão com o QR e o
 * passo 2 do login. E o atendimento: o admin acha a conta pelo e-mail e tira a 2FA.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Decode(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text.replace(/[\s=]+/g, '').toUpperCase()) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error(`caractere fora do base32: ${ch}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

/** Passo de 30 s de agora (ou daqui a `ahead` passos). */
const stepNow = (ahead = 0): number => Math.floor(Date.now() / 1000 / STEP_SECONDS) + ahead;

/** Código TOTP de 6 dígitos de um passo (RFC 6238 / 4226). */
function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

/** Entra pelo formulário com e-mail e senha (o passo 1). */
async function passwordStep(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
}

/**
 * Sai. No desktop pelo botão da barra lateral; no celular ele não aparece (a barra vira a
 * navegação de baixo), então a sessão deste navegador é apagada como o "Sair" apaga.
 */
async function logout(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Sair', exact: true });
  if (await button.isVisible()) {
    await button.click();
    await expect(page).toHaveURL(/\/login/);
  } else {
    await page.evaluate(() => {
      window.localStorage.removeItem('escambo_token');
      window.localStorage.removeItem('escambo_refresh');
    });
  }
}

/**
 * A sessão abriu: a tela sai do /login (para a home, ou de volta para onde a guarda de rota mandou
 * ao sair, como o /perfil no desktop) e o navegador guarda o par de tokens.
 */
async function expectSignedIn(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
  const refresh = await page.evaluate(() => window.localStorage.getItem('escambo_refresh'));
  expect(refresh, 'refresh token guardado').toBeTruthy();
}

test('ativar no Perfil, sair, entrar com senha + código do app e com um código de recuperação', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const user = await createUser(request, 'client');

  // Sem 2FA, o login abre a sessão direto. O teste entra pelo formulário (e não com o token no
  // armazenamento, como o openAs): sair precisa apagar uma sessão de verdade.
  await passwordStep(page, user.email);
  await expect(
    page.getByRole('heading', { name: /^(Bom dia|Boa tarde|Boa noite),/ }),
  ).toBeVisible();
  await page.goto('/perfil');
  await settled(page);

  // Ativar: senha → QR e a chave em texto → código do app → códigos de recuperação.
  const card = page.getByTestId('dois-fatores');
  await card.getByRole('button', { name: 'Ativar' }).click();
  const start = card.getByRole('form', { name: 'Ativar a verificação em duas etapas' });
  await expect(start.getByLabel('Senha atual')).toBeFocused();
  await start.getByLabel('Senha atual').fill(PASSWORD);
  await start.getByRole('button', { name: 'Continuar' }).click();

  await expect(card.getByRole('img', { name: 'QR code para o app autenticador' })).toBeVisible();
  await expect(
    card.getByRole('heading', { name: 'Adicione a conta no app autenticador' }),
  ).toBeFocused();
  const shown = await card.getByTestId('mfa-secret').innerText();
  // A chave aparece em grupos de 4 (32 caracteres base32 = 20 bytes, RNF-042).
  expect(shown).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
  const secret = shown.replace(/\s+/g, '');
  const qrProblems = await audit(page, 'cartão com o QR da 2FA', {
    include: '[data-testid="dois-fatores"]',
  });
  expect(qrProblems.join('\n')).toBe('');

  const enabledStep = stepNow();
  const confirm = card.getByRole('form', { name: 'Confirmar o código do app' });
  await confirm.getByLabel('Código do app autenticador').fill(totp(secret, enabledStep));
  await confirm.getByRole('button', { name: 'Confirmar' }).click();

  const codesList = card.getByTestId('mfa-recovery-codes');
  await expect(codesList.getByRole('listitem')).toHaveCount(10);
  const codes = await codesList.getByRole('listitem').allInnerTexts();
  for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  await expect(card.getByRole('heading', { name: 'Códigos de recuperação' })).toBeFocused();
  await expect(card.getByRole('button', { name: 'Concluir' })).toBeDisabled();
  await card.getByRole('checkbox', { name: 'Guardei os códigos em lugar seguro' }).check();
  await card.getByRole('button', { name: 'Concluir' }).click();
  await expect(card.getByTestId('mfa-ativa')).toContainText('Ativa desde');
  await expect(card.getByTestId('mfa-codigos-restantes')).toHaveText(
    'Códigos de recuperação restantes: 10.',
  );

  // A senha sozinha não entra mais: a API pede o segundo fator e não devolve sessão.
  const bare = await request.post('/api/auth/login', {
    data: { email: user.email, password: PASSWORD },
  });
  expect(bare.status()).toBe(200);
  const challenge = (await bare.json()) as Record<string, unknown>;
  expect(challenge.mfaRequired).toBe(true);
  expect(challenge).not.toHaveProperty('accessToken');

  // Sair e entrar com a senha + o código do app.
  await logout(page);
  await passwordStep(page, user.email);
  await expect(page.getByRole('heading', { name: 'Verificação em duas etapas' })).toBeVisible();
  const appCode = page.getByLabel('Código do app autenticador');
  await expect(appCode).toBeFocused();
  const loginProblems = await audit(page, 'login: passo 2 (código do app)');
  expect(loginProblems.join('\n')).toBe('');

  // O código da ativação não vale de novo (anti-reuso): o do passo seguinte, que a janela de ±1
  // passo do servidor já aceita, entra sem esperar 30 s.
  await appCode.fill(totp(secret, enabledStep));
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(appCode).toHaveAttribute('aria-invalid', 'true');
  await appCode.fill(totp(secret, enabledStep + 1));
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expectSignedIn(page);

  // Sair e entrar com um código de recuperação (sem o celular).
  await logout(page);
  await passwordStep(page, user.email);
  await page.getByRole('button', { name: 'Usar um código de recuperação' }).click();
  const recovery = page.getByLabel('Código de recuperação');
  await expect(recovery).toBeFocused();
  await recovery.fill(codes[0]!.toLowerCase());
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expectSignedIn(page);

  // O código usado não vale de novo, e o Perfil mostra quantos sobraram.
  await page.goto('/perfil');
  await settled(page);
  await expect(page.getByTestId('mfa-codigos-restantes')).toHaveText(
    'Códigos de recuperação restantes: 9.',
  );
  await logout(page);
  await passwordStep(page, user.email);
  await page.getByRole('button', { name: 'Usar um código de recuperação' }).click();
  await page.getByLabel('Código de recuperação').fill(codes[0]!);
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Código de recuperação')).toHaveAttribute('aria-invalid', 'true');
  await expect(page).toHaveURL(/\/login/);
});

/** Ativa a 2FA de `user` pela API, com o código calculado do segredo que ela devolve. */
async function enableMfaByApi(request: Parameters<typeof createUser>[0], user: TestUser) {
  const headers = { Authorization: `Bearer ${user.token}` };
  const setup = await request.post('/api/auth/mfa/setup', {
    headers,
    data: { password: PASSWORD },
  });
  expect(setup.status(), await setup.text()).toBe(200);
  const { secret } = (await setup.json()) as { secret: string };
  const enable = await request.post('/api/auth/mfa/enable', {
    headers,
    data: { code: totp(secret, stepNow()) },
  });
  expect(enable.status(), await enable.text()).toBe(200);
}

test('atendimento: o admin acha a conta pelo e-mail e desativa a 2FA com o motivo', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  await enableMfaByApi(request, user);
  const admin = await createAdmin(request);

  await openAs(page, admin, '/admin');
  await settled(page);
  const section = page.locator('#atendimento-conta');
  await section.getByLabel('E-mail da conta').fill(user.email);
  await section.getByRole('button', { name: 'Buscar' }).click();
  await expect(section.getByTestId('lookup-result')).toHaveText('Conta encontrada.');
  await expect(section.getByTestId('lookup-mfa')).toHaveText('Ativa');

  await section.getByRole('button', { name: 'Desativar verificação em duas etapas' }).click();
  const dialog = page.getByRole('dialog', { name: 'Desativar a verificação em duas etapas' });
  const reason = dialog.getByLabel('Motivo (fica no registro do atendimento)');
  await reason.fill('curto');
  await dialog.getByRole('button', { name: 'Desativar' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Escreva o motivo com pelo menos 10 caracteres.',
  );
  await expect(reason).toBeFocused();
  await reason.fill('Perdeu o celular; titularidade confirmada no chamado de suporte.');
  await dialog.getByRole('button', { name: 'Desativar' }).click();
  await expect(dialog).toBeHidden();
  await expect(section.getByTestId('lookup-mfa')).toHaveText('Desativada');

  // Sem a 2FA, a senha volta a abrir a sessão direto.
  const login = await request.post('/api/auth/login', {
    data: { email: user.email, password: PASSWORD },
  });
  expect(login.status()).toBe(200);
  expect(await login.json()).toHaveProperty('accessToken');
});
