import { expect, test } from '@playwright/test';
import { createUser, openAs, settled, topUp } from './helpers';

/**
 * Pacotes Básico, Padrão e Premium (RF-086, RN-068, ADR 69) do começo ao fim: o freelancer publica
 * três pacotes pelo formulário, o card mostra "a partir de" com o Básico, o cliente vai à aba
 * Premium pelo teclado, compara e contrata, e a Sala mostra o pacote e as revisões dele.
 */

test('freelancer publica 3 pacotes; cliente escolhe o Premium pelo teclado e contrata', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const title = `Identidade visual e2e ${Date.now().toString(36)}`;

  await openAs(page, freelancer, '/servicos');
  await settled(page);
  await page.getByRole('button', { name: 'Novo serviço' }).click();
  const form = page.locator('form', { has: page.getByRole('heading', { name: 'Novo serviço' }) });
  await form.getByLabel('Título').fill(title);
  await form.getByLabel('Descrição').fill('Logo, cores e manual da marca para pequenos negócios.');
  await form.getByRole('checkbox', { name: /Oferecer pacotes/ }).check();
  await expect(form.getByLabel('Prazo de entrega em dias (opcional)')).toHaveCount(0);

  const fill = async (
    tier: string,
    name: string,
    price: string,
    days: string,
    revisions?: string,
    feature?: string,
  ) => {
    const group = form.getByRole('group', { name: tier });
    await group.getByLabel('Nome do pacote').fill(name);
    await group.getByLabel(/^Preço/).fill(price);
    await group.getByLabel('Prazo (dias)').fill(days);
    if (revisions) await group.getByLabel('Revisões incluídas').selectOption(revisions);
    if (feature) {
      await group.getByLabel('Itens inclusos (opcional)').fill(feature);
      await group.getByLabel('Itens inclusos (opcional)').press('Enter');
      await expect(group.getByRole('list', { name: `Itens inclusos no ${tier}` })).toContainText(
        feature,
      );
    }
  };
  await fill('Básico', 'Logo essencial', '150', '3', undefined, 'Arquivo PNG');
  await form.getByRole('button', { name: 'Adicionar o pacote Padrão' }).click();
  await fill('Padrão', 'Logo e paleta', '320', '5', '3', 'Paleta de cores');
  await form.getByRole('button', { name: 'Adicionar o pacote Premium' }).click();
  await fill('Premium', 'Identidade completa', '650', '10', '4', 'Manual da marca');
  await form.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.locator('.toast', { hasText: 'Serviço publicado!' })).toBeVisible();

  // O card da busca: "a partir de" com o Básico e quantos pacotes.
  const client = await createUser(request, 'client');
  await topUp(request, client, 700);
  await openAs(page, client, `/servicos?q=${encodeURIComponent(title)}`);
  await settled(page);
  const card = page.locator('.card.service', { hasText: title });
  await expect(card.getByTestId('packages-count')).toHaveText('3 pacotes');
  await expect(card.locator('.price')).toHaveText(/150,00$/);
  await card.getByRole('link', { name: title }).click();
  await settled(page);

  // Abas pelo teclado: foco no Básico, End leva ao Premium e mostra o painel dele.
  const picker = page.getByTestId('package-picker');
  await picker.getByRole('tab', { name: 'Básico' }).focus();
  await page.keyboard.press('End');
  await expect(picker.getByRole('tab', { name: 'Premium' })).toBeFocused();
  await expect(picker.getByRole('tab', { name: 'Premium' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const panel = picker.getByRole('tabpanel', { name: 'Premium' });
  await expect(panel).toContainText('Identidade completa');
  await expect(panel).toContainText('Entrega em 10 dias');
  await expect(panel).toContainText('4 revisões sem custo');

  // A comparação lista os itens de todos os níveis.
  const compare = page.getByTestId('package-compare');
  await expect(compare.getByRole('rowheader', { name: 'Manual da marca' })).toBeVisible();

  await panel.getByRole('button', { name: /^Continuar/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: /^Premium — Identidade completa/ })).toBeChecked();
  await expect(dialog.getByTestId('package-price')).toContainText('650,00');
  await expect(dialog.getByTestId('contract-rules-hint')).toContainText(
    'Inclui até 4 revisões sem custo (as do pacote Premium).',
  );
  await dialog.getByRole('button', { name: 'Enviar proposta' }).click();
  await expect(page).toHaveURL(/\/contratos\/\d+$/);
  await settled(page);

  // A Sala: o pacote contratado na tabela de valores e as revisões dele.
  await expect(page.getByTestId('package-kv')).toContainText('Premium — Identidade completa');
  await expect(page.getByTestId('package-kv')).toContainText('Manual da marca');
  await expect(page.getByTestId('revisions-summary')).toHaveText(
    'Revisões sem custo: 0 de 4 usadas.',
  );
});
