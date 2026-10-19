import { expect, test } from '@playwright/test';
import {
  completeContract,
  createAdmin,
  createService,
  createUser,
  latestEmail,
  linkIn,
  openAs,
  PASSWORD,
  settled,
} from './helpers';

/**
 * Perfil e conta: o perfil público mostra XP e conquistas (RF-015, RF-068, RN-058) e a troca de
 * senha com login (RF-017) derruba as outras sessões, mantém a de quem trocou e avisa por e-mail;
 * o telefone é salvo no Perfil e a troca de e-mail só vale pelo link enviado ao endereço novo.
 */

test('perfil público mostra o XP e a badge do primeiro contrato, em destaque e em "Conquistas"', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const service = await createService(request, freelancer);
  // Contrato concluído: +100 XP e a badge "First Deal" (+50 XP), RN-051. O aceite feito logo em
  // seguida cumpre a missão semanal "Resposta rápida" (+100 XP do catálogo, ADR 63).
  await completeContract(request, client, freelancer, service);

  const me = await request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${freelancer.token}` },
  });
  const { ulid } = (await me.json()) as { ulid: string };
  await openAs(page, client, `/freelancers/${ulid}`);
  await settled(page);

  await expect(page.getByTestId('total-xp')).toHaveText('250 XP');
  await expect(page.getByRole('list', { name: 'Conquistas em destaque' })).toContainText(
    'First Deal',
  );
  const achievements = page.getByTestId('achievements');
  await expect(achievements).toContainText('1 badge');
  await expect(achievements.getByRole('list', { name: 'Badges conquistadas' })).toContainText(
    'First Deal',
  );
});

test('troca de senha no Perfil: as outras sessões caem, esta continua e chega o aviso por e-mail', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  const admin = await createAdmin(request);
  // Outra sessão aberta (outro aparelho), com o refresh token dela.
  const other = await request.post('/api/auth/login', {
    data: { email: user.email, password: PASSWORD },
  });
  const { refreshToken } = (await other.json()) as { refreshToken: string };

  await openAs(page, user, '/perfil');
  await settled(page);
  const form = page.getByRole('form', { name: 'Trocar senha' });
  await form.getByLabel('Senha atual').fill('nao-e-a-senha');
  await form.getByLabel('Nova senha', { exact: true }).fill('NovaSenha@456');
  await form.getByLabel('Confirmar nova senha').fill('NovaSenha@456');
  await form.getByRole('button', { name: 'Trocar senha' }).click();
  await expect(form.getByRole('alert')).toHaveText('Senha atual incorreta');
  await expect(form.getByLabel('Senha atual')).toBeFocused();

  await form.getByLabel('Senha atual').fill(PASSWORD);
  await form.getByRole('button', { name: 'Trocar senha' }).click();
  await expect(
    page.locator('.toast', { hasText: 'Senha alterada. As outras sessões foram encerradas.' }),
  ).toBeVisible();

  // A outra sessão caiu; a senha antiga não entra e a nova entra.
  const refresh = await request.post('/api/auth/refresh', { data: { refreshToken } });
  expect(refresh.status()).toBe(401);
  const old = await request.post('/api/auth/login', {
    data: { email: user.email, password: PASSWORD },
  });
  expect(old.status()).toBe(401);
  const fresh = await request.post('/api/auth/login', {
    data: { email: user.email, password: 'NovaSenha@456' },
  });
  expect(fresh.status()).toBe(200);

  // Quem trocou continua dentro: o navegador guardou o par novo, e o refresh dele renova.
  const kept = await page.evaluate(() => window.localStorage.getItem('escambo_refresh'));
  expect(kept).toBeTruthy();
  const renewed = await request.post('/api/auth/refresh', { data: { refreshToken: kept } });
  expect(renewed.status()).toBe(200);

  const mail = await latestEmail(request, admin, user.id, 'notification');
  expect(mail.subject).toBe('Sua senha foi alterada');
  expect(mail.text).toContain('/esqueci-senha');
});

test('telefone e troca de e-mail no Perfil: o e-mail novo só vale pelo link enviado a ele', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  const admin = await createAdmin(request);
  const newEmail = `novo-${user.email}`;

  await openAs(page, user, '/perfil');
  await settled(page);

  // Telefone (opcional, só o titular vê): sai formatado do que a API guardou em E.164.
  const phoneForm = page.getByRole('form', { name: 'Telefone da conta' });
  await phoneForm.getByLabel('Telefone com DDD').fill('47 99999 1234');
  await phoneForm.getByRole('button', { name: 'Salvar telefone' }).click();
  await expect(page.locator('.toast', { hasText: 'Telefone salvo.' })).toBeVisible();
  await expect(phoneForm.getByLabel('Telefone com DDD')).toHaveValue('(47) 99999-1234');

  // Pedido da troca: senha errada volta para o campo; com a certa, fica pendente.
  const emailForm = page.getByRole('form', { name: 'Trocar e-mail' });
  await emailForm.getByLabel('Novo e-mail').fill(newEmail);
  await emailForm.getByLabel('Senha atual').fill('nao-e-a-senha');
  await emailForm.getByRole('button', { name: 'Trocar e-mail' }).click();
  await expect(emailForm.getByRole('alert')).toHaveText('Senha atual incorreta');
  await expect(emailForm.getByLabel('Senha atual')).toBeFocused();
  await emailForm.getByLabel('Senha atual').fill(PASSWORD);
  await emailForm.getByRole('button', { name: 'Trocar e-mail' }).click();
  await expect(page.getByTestId('email-pendente')).toContainText(newEmail);

  // Até confirmar, o login segue pelo endereço antigo; o antigo recebeu o aviso.
  const before = await request.post('/api/auth/login', {
    data: { email: newEmail, password: PASSWORD },
  });
  expect(before.status()).toBe(401);
  const notice = await latestEmail(request, admin, user.id, 'notification');
  expect(notice.subject).toBe('Pedido para trocar o e-mail da sua conta');

  // O link do e-mail enviado ao endereço novo, aberto nesta aba (logada): um clique confirma.
  const mail = await latestEmail(request, admin, user.id, 'email_change');
  const link = new URL(linkIn(mail.text));
  expect(link.pathname).toBe('/confirmar-novo-email');
  await page.goto(`${link.pathname}${link.search}`);
  await page.getByRole('button', { name: 'Confirmar novo e-mail' }).click();
  await expect(page.getByTestId('email-change-ok')).toContainText(
    'As outras sessões foram encerradas; esta continua.',
  );

  const after = await request.post('/api/auth/login', {
    data: { email: newEmail, password: PASSWORD },
  });
  expect(after.status()).toBe(200);
  const old = await request.post('/api/auth/login', {
    data: { email: user.email, password: PASSWORD },
  });
  expect(old.status()).toBe(401);
});
