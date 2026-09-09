import { expect, test } from '@playwright/test';
import {
  completeContract,
  createAdmin,
  createService,
  createUser,
  openAs,
  settled,
  topUp,
} from './helpers';

/**
 * Financeiro: carteira pré-paga (depósito PIX no gateway simulado), proposta que reserva o
 * valor, saque do freelancer e processamento pelo admin. Roda em desktop e mobile.
 */

test('cliente deposita via PIX (simulado) e o saldo e o extrato aparecem na Carteira', async ({
  page,
  request,
}) => {
  const client = await createUser(request, 'client');
  await openAs(page, client, '/carteira');
  await settled(page);
  await expect(page.getByTestId('wallet-balance')).toHaveText('R$ 0,00');

  await page.getByRole('button', { name: 'Depositar' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: 'R$ 200,00' }).click();
  await modal.getByRole('button', { name: /Gerar cobrança PIX de R\$ 200,00/ }).click();

  // Cobrança: QR, copia e cola (BR Code válido) e, na demo, o botão de simular.
  await expect(modal.getByRole('img', { name: 'QR Code do PIX' })).toBeVisible();
  await expect(modal.getByTestId('pix-code')).toHaveValue(/^000201.*6304[0-9A-F]{4}$/);
  await expect(modal.getByText('Ambiente de demonstração')).toBeVisible();
  await modal.getByRole('button', { name: 'Simular pagamento' }).click();

  await expect(
    modal.getByRole('heading', { name: /Depósito de R\$ 200,00 confirmado/ }),
  ).toBeVisible();
  await modal.getByRole('button', { name: 'Concluir' }).click();
  await expect(page.getByTestId('wallet-balance')).toHaveText('R$ 200,00');
  await expect(
    page.getByTestId('ledger').locator('li', { hasText: 'Depósito via PIX' }),
  ).toBeVisible();
  await expect(page.getByTestId('deposits').locator('li', { hasText: 'Confirmado' })).toBeVisible();
});

test('sem saldo, o modal de contratação oferece o depósito; com saldo, a proposta reserva o valor', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 150);
  const client = await createUser(request, 'client');

  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(service.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const card = page.locator('.card.service', { hasText: service.title });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Contratar' }).click();

  // Falta tudo: envio bloqueado, depósito sugerido com o valor que falta.
  const modal = page.getByRole('dialog');
  await expect(modal.getByTestId('needs-deposit')).toContainText('Falta R$ 150,00');
  await expect(modal.getByRole('button', { name: 'Enviar proposta' })).toBeDisabled();
  await modal.getByRole('button', { name: /Depositar R\$ 150,00/ }).click();

  const deposit = page.getByRole('dialog');
  await expect(deposit.getByRole('heading', { name: 'Depositar na carteira' })).toBeVisible();
  await deposit.getByRole('button', { name: /Gerar cobrança PIX de R\$ 150,00/ }).click();
  await deposit.getByRole('button', { name: 'Simular pagamento' }).click();

  // Volta ao formulário com saldo: envia e cai na Sala; o valor fica reservado.
  const hire = page.getByRole('dialog');
  await expect(hire.getByRole('heading', { name: `Contratar: ${service.title}` })).toBeVisible();
  await expect(hire.getByTestId('needs-deposit')).toHaveCount(0);
  await hire.getByRole('button', { name: 'Enviar proposta' }).click();
  await expect(page).toHaveURL(/\/contratos\/\d+$/);
  await expect(page.getByTestId('payment-state')).toHaveText('Reservado na carteira do cliente');

  await page.goto('/carteira');
  await settled(page);
  await expect(page.getByTestId('wallet-balance')).toHaveText('R$ 0,00');
  await expect(
    page.getByTestId('ledger').locator('li', { hasText: 'Reservado para a proposta' }),
  ).toBeVisible();
});

test('freelancer saca; admin conclui na fila de saques; o status muda para o titular', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 250);
  const client = await createUser(request, 'client');
  await completeContract(request, client, freelancer, service); // 250 − 15% = 212,50 liberados

  await openAs(page, freelancer, '/carteira');
  await settled(page);
  await expect(page.getByTestId('wallet-balance')).toHaveText('R$ 212,50');
  await expect(
    page.getByTestId('ledger').locator('li', { hasText: 'Liberado do escrow' }),
  ).toBeVisible();

  const form = page.locator('form', { hasText: 'Solicitar saque' });
  await form.getByLabel('Valor (R$)').fill('100');
  await form.getByLabel('Chave PIX').fill(`pix-${freelancer.id}@escambo.test`);
  await form.getByRole('button', { name: /Sacar/ }).click();
  await expect(page.locator('.toast', { hasText: 'Saque solicitado' })).toBeVisible();
  await expect(page.getByTestId('wallet-balance')).toHaveText('R$ 112,50');
  const row = page.getByTestId('withdrawals').locator('li', { hasText: 'R$ 100,00' });
  await expect(row.locator('.pill')).toHaveText('Aguardando');

  // Admin: fila de saques com o destino completo → Concluir com referência.
  const admin = await createAdmin(request);
  await openAs(page, admin, '/admin');
  await settled(page);
  const queueRow = page.getByRole('row', { name: new RegExp(`pix-${freelancer.id}@escambo.test`) });
  await expect(queueRow).toBeVisible();
  await expect(queueRow).toContainText('Aguardando');
  await queueRow.getByRole('button', { name: 'Concluir' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Referência do pagamento (opcional)').fill('E2E-REF-1');
  await modal.getByRole('button', { name: 'Confirmar pagamento' }).click();
  await expect(page.locator('.toast', { hasText: 'Saque concluído' })).toBeVisible();
  await expect(queueRow).toHaveCount(0); // saiu dos abertos

  // Titular vê "Concluído" e a notificação.
  await openAs(page, freelancer, '/carteira');
  await settled(page);
  await expect(
    page.getByTestId('withdrawals').locator('li', { hasText: 'R$ 100,00' }).locator('.pill'),
  ).toHaveText('Concluído');
  await page.goto('/notificacoes');
  await expect(page.locator('.list li', { hasText: 'Saque de R$ 100,00 concluído' })).toBeVisible();
});

test('saque falho é estornado pelo admin; saque aguardando pode ser cancelado pelo titular', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  await topUp(request, freelancer, 200);
  const ask = async (amount: number, key: string) => {
    const res = await request.post('/api/withdrawals', {
      headers: { Authorization: `Bearer ${freelancer.token}` },
      data: { amount, method: 'pix', pixKey: key },
    });
    expect(res.ok()).toBeTruthy();
  };
  await ask(50, `falha-${freelancer.id}@escambo.test`);
  await ask(30, `cancela-${freelancer.id}@escambo.test`);

  const admin = await createAdmin(request);
  await openAs(page, admin, '/admin');
  await settled(page);
  const row = page.getByRole('row', { name: new RegExp(`falha-${freelancer.id}@escambo.test`) });
  await row.getByRole('button', { name: 'Falhar' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Motivo (o titular recebe)').fill('Chave PIX inexistente');
  await modal.getByRole('button', { name: 'Marcar como falho e estornar' }).click();
  await expect(page.locator('.toast', { hasText: 'voltou para a carteira' })).toBeVisible();

  await openAs(page, freelancer, '/carteira');
  await settled(page);
  await expect(page.getByTestId('wallet-balance')).toHaveText('R$ 170,00'); // 200 − 30 (o de 50 voltou)
  const pending = page.getByTestId('withdrawals').locator('li', { hasText: 'R$ 30,00' });
  await pending.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.locator('.toast', { hasText: 'Saque cancelado' })).toBeVisible();
  await expect(page.getByTestId('wallet-balance')).toHaveText('R$ 200,00');
  await expect(pending.locator('.pill')).toHaveText('Cancelado');
});
