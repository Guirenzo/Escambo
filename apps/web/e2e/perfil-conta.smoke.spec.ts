import { expect, test } from '@playwright/test';
import {
  completeContract,
  createAdmin,
  createService,
  createUser,
  latestEmail,
  openAs,
  PASSWORD,
  settled,
} from './helpers';

/**
 * Perfil e conta: o perfil público mostra XP e conquistas (RF-015, RF-068, RN-058) e a troca de
 * senha com login (RF-017) derruba as outras sessões, mantém a de quem trocou e avisa por e-mail.
 */

test('perfil público mostra o XP e a badge do primeiro contrato, em destaque e em "Conquistas"', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const service = await createService(request, freelancer);
  // Contrato concluído: +100 XP e a badge "First Deal" (+50 XP), RN-051.
  await completeContract(request, client, freelancer, service);

  const me = await request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${freelancer.token}` },
  });
  const { ulid } = (await me.json()) as { ulid: string };
  await openAs(page, client, `/freelancers/${ulid}`);
  await settled(page);

  await expect(page.getByTestId('total-xp')).toHaveText('150 XP');
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
