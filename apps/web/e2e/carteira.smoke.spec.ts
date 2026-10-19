import { expect, test } from '@playwright/test';
import { createAdmin, createUser, openAs, settled, topUp, verifyEmail } from './helpers';

/**
 * Carteira: saque por transferência bancária (RF-045) e extrato de R$ por período (RF-047).
 * Roda em desktop e mobile.
 */

test('freelancer saca por transferência bancária e filtra o extrato por período', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const admin = await createAdmin(request);
  await verifyEmail(request, freelancer, admin); // saque exige e-mail confirmado
  await topUp(request, freelancer, 200);

  await openAs(page, freelancer, '/carteira');
  await settled(page);
  const form = page.locator('form', { hasText: 'Solicitar saque' });
  await form.getByLabel('Receber por').selectOption('bank');
  await expect(form.getByLabel('Chave PIX')).toHaveCount(0);
  await form.getByLabel('Valor (R$)').fill('80');
  await form.getByLabel('Banco', { exact: true }).fill('Banco do Brasil');
  await form.getByLabel('Agência', { exact: true }).fill('1234');
  await form.getByLabel('Conta', { exact: true }).fill('56789-0');
  await form.getByRole('button', { name: /Sacar/ }).click();

  await expect(page.locator('.toast', { hasText: 'Saque solicitado' })).toBeVisible();
  await expect(page.getByTestId('wallet-balance')).toHaveText('R$ 120,00');
  const row = page.getByTestId('withdrawals').locator('li', { hasText: 'R$ 80,00' });
  await expect(row).toContainText('Conta · ••••89-0');
  await expect(row.locator('.pill')).toHaveText('Aguardando');

  // Extrato por período: o depósito e o saque são de hoje; janeiro de 2020 não tem nada.
  const ledger = page.getByTestId('ledger');
  await expect(ledger.locator('li', { hasText: 'Saque solicitado' })).toBeVisible();
  const period = page.getByRole('group', { name: 'Período do extrato' });
  await period.getByLabel('De').fill('2020-01-01');
  await period.getByLabel('Até').fill('2020-01-31');
  await expect(page.getByText('Nenhuma movimentação em reais nesse período.')).toBeVisible();

  await period.getByRole('button', { name: 'Limpar período' }).click();
  await expect(ledger.locator('li', { hasText: 'Saque solicitado' })).toBeVisible();
  await expect(ledger.locator('li', { hasText: 'Depósito via PIX' })).toBeVisible();
});
