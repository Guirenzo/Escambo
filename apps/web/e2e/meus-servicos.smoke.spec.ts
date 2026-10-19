import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled } from './helpers';

/**
 * "Meus serviços" (RF-030) e o cadastro completo (RF-022 e RF-023): o freelancer pausa e reativa
 * pela web, o pausado some da busca mas continua na lista dele, e a edição grava tipo de preço,
 * prazo e modalidade.
 */

test('freelancer pausa, vê o pausado em "Meus serviços", reativa e edita o serviço', async ({
  page,
  request,
}) => {
  const me = await createUser(request, 'freelancer');
  const svc = await createService(request, me, 150);

  await openAs(page, me, '/servicos');
  await settled(page);
  await page.getByRole('tab', { name: 'Meus serviços' }).click();
  await settled(page);
  const card = page.locator('.card.service', { hasText: svc.title });
  await expect(card).toBeVisible();

  // Pausar: sai da busca, continua na lista do dono marcado como pausado.
  await card.getByRole('button', { name: 'Pausar' }).click();
  await expect(page.locator('.toast', { hasText: 'saiu da busca' })).toBeVisible();
  await expect(card.getByText('Pausado', { exact: true })).toBeVisible();
  await expect(card.getByTestId('paused-note')).toBeVisible();

  await page.getByRole('tab', { name: 'Buscar serviços' }).click();
  await page.getByPlaceholder('Buscar serviços…').fill(svc.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await settled(page);
  await expect(page.locator('.card.service', { hasText: svc.title })).toHaveCount(0);

  // Reativar: volta para a busca.
  await page.getByRole('tab', { name: 'Meus serviços' }).click();
  await card.getByRole('button', { name: 'Reativar' }).click();
  await expect(page.locator('.toast', { hasText: 'voltou para a busca' })).toBeVisible();
  await page.getByRole('tab', { name: 'Buscar serviços' }).click();
  await settled(page);
  await expect(page.locator('.card.service', { hasText: svc.title })).toBeVisible();

  // Editar: por hora, prazo de 2 dias e presencial.
  await page.getByRole('tab', { name: 'Meus serviços' }).click();
  await card.getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar serviço' });
  await dialog.getByLabel('Tipo de preço').selectOption('hourly');
  await dialog.getByLabel('Preço por hora (R$)').fill('70');
  await dialog.getByLabel('Prazo de entrega em dias (opcional)').fill('2');
  await dialog.getByLabel('Modalidade').selectOption('onsite');
  await dialog.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.locator('.toast', { hasText: 'Serviço atualizado!' })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(card.locator('.price')).toHaveText(/70,00\/h$/);
  await expect(card).toContainText('2 dias');
  await expect(card.getByText('presencial', { exact: true })).toBeVisible();
});

test('novo serviço a combinar e presencial sai sem preço no card', async ({ page, request }) => {
  const me = await createUser(request, 'freelancer');
  const title = `A combinar e2e ${Date.now()}`;

  await openAs(page, me, '/servicos');
  await settled(page);
  await page.getByRole('button', { name: 'Novo serviço' }).click();
  const form = page.locator('form', { has: page.getByRole('heading', { name: 'Novo serviço' }) });
  await form.getByLabel('Título').fill(title);
  await form.getByLabel('Descrição').fill('Orçamento depois de conversar sobre o projeto.');
  await form.getByLabel('Tipo de preço').selectOption('negotiable');
  await expect(
    form.getByText('Sem preço no anúncio: o valor é combinado na proposta.'),
  ).toBeVisible();
  await form.getByLabel('Modalidade').selectOption('onsite');
  await form.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.locator('.toast', { hasText: 'Serviço publicado!' })).toBeVisible();

  await page.getByRole('tab', { name: 'Meus serviços' }).click();
  await settled(page);
  const card = page.locator('.card.service', { hasText: title });
  await expect(card.locator('.price')).toHaveText('a combinar');
  await expect(card.getByText('presencial', { exact: true })).toBeVisible();
});
