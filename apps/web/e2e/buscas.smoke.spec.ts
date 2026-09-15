import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled } from './helpers';

/**
 * Buscas salvas (ADR 35): salvar a busca atual com alerta, reaplicar pelo chip e pelo link do
 * aviso (/servicos?busca=ID), desligar o alerta e apagar. Desktop e mobile.
 */

test('busca salva: salvar com alerta, reaplicar pelo chip e pelo link, desligar e apagar', async ({
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
  const [saved] = (await list.json()) as { id: number }[];
  await openAs(page, client, `/servicos?busca=${saved!.id}`);
  await settled(page);
  await expect(page.getByPlaceholder('Buscar serviços…')).toHaveValue(tag);
  await expect(cards).toHaveCount(1);
  await expect(page).toHaveURL(/\/servicos$/);

  // Desliga o alerta e apaga.
  await bar.getByRole('button', { name: `Alerta de ${name}` }).click();
  await expect(bar.getByRole('button', { name: `Alerta de ${name}` })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await bar.getByRole('button', { name: `Apagar ${name}` }).click();
  await expect(page.getByTestId('saved-searches')).toHaveCount(0);
});
