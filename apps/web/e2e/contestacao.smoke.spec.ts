import { expect, test } from '@playwright/test';
import { createAdmin, createUser, noisyPngFixture, openAs, settled, uploadImage } from './helpers';

/**
 * Contestação de remoção de imagem (ADR 41): o dono vê a remoção no perfil e contesta, o admin vê
 * a imagem guardada e reverte, e o trabalho volta a mostrar a imagem no perfil público. A denúncia
 * e a remoção vão pela API; a fila de denúncias tem o próprio teste (confianca.smoke).
 */
test('imagem removida: o dono contesta pelo perfil, o admin reverte e a imagem volta ao portfólio', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const headers = { Authorization: `Bearer ${freelancer.token}` };
  const title = `Trabalho contestado ${Date.now().toString(36)}`;
  const image = await uploadImage(request, freelancer, noisyPngFixture());
  const added = await request.post('/api/profiles/portfolio', {
    headers,
    data: { title, imageUrl: image },
  });
  expect(added.ok(), await added.text()).toBeTruthy();
  const item = ((await added.json()) as { id: number; title: string }[]).find(
    (i) => i.title === title,
  );
  expect(item).toBeTruthy();
  const me = await request.get('/api/auth/me', { headers });
  const { ulid } = (await me.json()) as { ulid: string };

  const client = await createUser(request, 'client');
  const reported = await request.post('/api/reports', {
    headers: { Authorization: `Bearer ${client.token}` },
    data: { targetType: 'portfolio_item', targetId: item!.id, reason: 'offensive' },
  });
  expect(reported.ok(), await reported.text()).toBeTruthy();
  const reportId = ((await reported.json()) as { id: number }).id;
  const admin = await createAdmin(request);
  const removed = await request.post(`/api/admin/reports/${reportId}/remove-image`, {
    headers: { Authorization: `Bearer ${admin.token}` },
    data: { note: 'Parece conteúdo ofensivo.' },
  });
  expect(removed.ok(), await removed.text()).toBeTruthy();

  // O dono vê a remoção com a nota e o prazo, e contesta com um texto de verdade.
  await openAs(page, freelancer, '/perfil');
  await settled(page);
  const row = page
    .getByTestId('moderation-card')
    .locator('[data-testid^="removal-"]', { hasText: title });
  await expect(row).toContainText('Parece conteúdo ofensivo.');
  await expect(row).toContainText('Você pode contestar até');
  await row.getByRole('button', { name: 'Contestar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Contestar remoção' });
  const field = dialog.getByLabel('Por que a remoção deve ser revertida');
  await field.fill('É meu');
  await expect(dialog.getByRole('button', { name: 'Enviar contestação' })).toBeDisabled();
  await field.fill('O trabalho é meu e a imagem mostra só a fachada que pintei.');
  await dialog.getByRole('button', { name: 'Enviar contestação' }).click();
  await expect(page.locator('.toast', { hasText: 'Contestação enviada' })).toBeVisible();
  await expect(row).toContainText('Contestação em análise');

  // O admin vê a imagem guardada e o texto, e reverte com nota.
  await openAs(page, admin, '/admin');
  await settled(page);
  const appeal = page
    .getByTestId('appeals-card')
    .locator('[data-testid^="appeal-"]', { hasText: title });
  await expect(appeal).toContainText('a fachada que pintei');
  await expect(appeal.locator('img.report-thumb')).toBeVisible();
  await appeal.getByRole('button', { name: 'Reverter' }).click();
  const decision = page.getByRole('dialog', { name: 'Reverter remoção' });
  await expect(decision.locator('img.appeal-image')).toBeVisible();
  await decision.getByLabel('Nota para o dono').fill('Imagem legítima.');
  await decision.getByRole('button', { name: 'Reverter e devolver a imagem' }).click();
  await expect(page.locator('.toast', { hasText: 'A imagem voltou para o perfil' })).toBeVisible();
  await expect(appeal).toHaveCount(0);

  // A imagem volta ao trabalho no perfil público.
  await openAs(page, client, `/freelancers/${ulid}`);
  await settled(page);
  await expect(page.locator('.portfolio-item', { hasText: title }).locator('img')).toBeVisible();
});
