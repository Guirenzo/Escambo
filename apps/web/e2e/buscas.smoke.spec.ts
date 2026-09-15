import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled } from './helpers';

/**
 * Buscas salvas (ADR 35 e 37): salvar a busca atual com alerta diário, reaplicar pelo chip e pelo
 * link do aviso (/servicos?busca=ID), editar nome e frequência, desligar o alerta e apagar.
 * Desktop e mobile.
 */

test('busca salva: salvar com alerta diário, reaplicar, editar a frequência, desligar e apagar', async ({
  page,
  request,
}) => {
  const tag = `Salva ${Date.now().toString(36)}`;
  const name = `${tag} até 500`;
  const freelancer = await createUser(request, 'freelancer');
  await createService(request, freelancer, 300, 0, { title: `${tag} barato` });
  await createService(request, freelancer, 900, 0, { title: `${tag} caro` });
  const client = await createUser(request, 'client');

  await openAs(page, client, '/servicos');
  await settled(page);
  // Sem texto nem filtro não há o que salvar.
  await expect(page.getByRole('button', { name: 'Salvar busca' })).toBeDisabled();

  await page.getByPlaceholder('Buscar serviços…').fill(tag);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const cards = page.locator('.card.service', { hasText: tag });
  await expect(cards).toHaveCount(2);
  await page.getByTestId('filters').getByLabel('Preço máximo').fill('500');
  await expect(cards).toHaveCount(1);

  await page.getByRole('button', { name: 'Salvar busca' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Nome')).toHaveValue(tag);
  await dialog.getByLabel('Nome').fill(name);
  await expect(dialog.getByRole('switch', { name: 'Me avisar de serviços novos' })).toBeChecked();
  // Frequência (ADR 37): de hora em hora vem marcada; esta busca fica com o resumo diário.
  await expect(dialog.getByRole('radio', { name: /^De hora em hora/ })).toBeChecked();
  await dialog.getByRole('radio', { name: /^Uma vez por dia/ }).check();
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.toast', { hasText: 'Busca salva' })).toBeVisible();
  const bar = page.getByTestId('saved-searches');
  await expect(bar.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(bar.getByRole('button', { name: `Alerta de ${name}` })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Limpa tudo e reaplica pelo chip: texto e preço voltam, e a lista também.
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await page.getByPlaceholder('Buscar serviços…').fill('');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await bar.getByRole('button', { name, exact: true }).click();
  await expect(page.getByPlaceholder('Buscar serviços…')).toHaveValue(tag);
  await expect(page.getByTestId('filters').getByLabel('Preço máximo')).toHaveValue('500');
  await expect(cards).toHaveCount(1);

  // Link do aviso: /servicos?busca=ID aplica a mesma busca numa visita nova e limpa a URL.
  const list = await request.get('/api/saved-searches', {
    headers: { Authorization: `Bearer ${client.token}` },
  });
  const [saved] = (await list.json()) as { id: number; alertFrequency: string }[];
  expect(saved!.alertFrequency).toBe('daily');
  await openAs(page, client, `/servicos?busca=${saved!.id}`);
  await settled(page);
  await expect(page.getByPlaceholder('Buscar serviços…')).toHaveValue(tag);
  await expect(cards).toHaveCount(1);
  await expect(page).toHaveURL(/\/servicos$/);

  // Edita: a frequência salva vem marcada; troca o nome e passa a avisar na hora.
  await bar.getByRole('button', { name: `Editar ${name}` }).click();
  const edit = page.getByRole('dialog');
  await expect(edit.getByRole('radio', { name: /^Uma vez por dia/ })).toBeChecked();
  const renamed = `${tag} na hora`;
  await edit.getByLabel('Nome').fill(renamed);
  await edit.getByRole('radio', { name: /^Na hora/ }).check();
  await edit.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.toast', { hasText: 'Busca atualizada' })).toBeVisible();
  await expect(bar.getByRole('button', { name: renamed, exact: true })).toBeVisible();
  const after = await request.get('/api/saved-searches', {
    headers: { Authorization: `Bearer ${client.token}` },
  });
  expect(((await after.json()) as { alertFrequency: string }[])[0]!.alertFrequency).toBe('instant');

  // Desliga o alerta e apaga.
  await bar.getByRole('button', { name: `Alerta de ${renamed}` }).click();
  await expect(bar.getByRole('button', { name: `Alerta de ${renamed}` })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await bar.getByRole('button', { name: `Apagar ${renamed}` }).click();
  await expect(page.getByTestId('saved-searches')).toHaveCount(0);
});
