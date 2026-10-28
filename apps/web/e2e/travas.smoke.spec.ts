import { expect, test } from '@playwright/test';
import { expectAccessible } from './a11y.helpers';
import {
  completeContract,
  createService,
  createUser,
  openAs,
  settled,
  topUp,
  verifyEmail,
} from './helpers';

/**
 * As travas da 1.52, desktop e mobile. RF-006: sem e-mail confirmado, o botão de uma ação crítica
 * continua à mostra e abre o aviso com o reenvio do link; confirmado pelo link, a ação volta.
 * RF-062: sem contratação nem troca em aberto entre os dois, a Sala troca o compositor por uma
 * faixa só de leitura, e uma proposta nova reabre a conversa na hora.
 */

test('sem e-mail confirmado, "Contratar" abre o aviso com o reenvio; confirmado, a proposta abre', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 150);
  const client = await createUser(request, 'client', { verified: false });

  await openAs(page, client, `/servicos/${service.id}`);
  await settled(page);
  await page.getByRole('button', { name: 'Contratar' }).first().click();
  const dialog = page.getByRole('dialog', { name: `Contratar: ${service.title}` });
  const notice = dialog.getByTestId('verify-email-notice');
  await expect(notice).toContainText('Confirme seu e-mail para contratar.');
  await expect(notice).toContainText(client.email);
  await expect(dialog.getByRole('button', { name: 'Enviar proposta' })).toHaveCount(0);
  await expectAccessible(page, 'aviso de e-mail no lugar da proposta', {
    include: '[role="dialog"]',
  });

  await notice.getByRole('button', { name: 'Reenviar e-mail' }).click();
  await expect(page.locator('.toast', { hasText: 'Link reenviado' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Fechar' }).click();

  // Confirmado pelo link da caixa de saída: a tela relê a conta e a proposta abre.
  await verifyEmail(request, client);
  await openAs(page, client, `/servicos/${service.id}`);
  await settled(page);
  await page.getByRole('button', { name: 'Contratar' }).first().click();
  await expect(page.getByRole('button', { name: 'Enviar proposta' })).toBeVisible();
  await expect(page.getByTestId('verify-email-notice')).toHaveCount(0);
});

test('conversa encerrada: a faixa toma o lugar do compositor e uma proposta nova reabre ao vivo', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 150);
  const client = await createUser(request, 'client');
  const contractId = await completeContract(request, client, freelancer, service);

  // A cliente vê o atalho para contratar de novo.
  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  const band = page.getByTestId('chat-closed');
  await expect(band).toContainText('Conversa encerrada.');
  await expect(band.getByRole('link', { name: 'Contratar de novo' })).toHaveAttribute(
    'href',
    `/servicos/${service.id}`,
  );
  await expect(page.getByPlaceholder('Escreva uma mensagem…')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Anexar arquivo' })).toHaveCount(0);
  await expectAccessible(page, 'conversa encerrada', { include: '.card.chat' });

  // O freelancer está na Sala encerrada quando a cliente manda outra proposta: reabre sem recarregar.
  await openAs(page, freelancer, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByTestId('chat-closed')).toBeVisible();
  await topUp(request, client, 150);
  const created = await request.post('/api/contracts', {
    headers: { Authorization: `Bearer ${client.token}` },
    data: {
      freelancerId: freelancer.id,
      serviceId: service.id,
      title: `${service.title} (de novo)`,
      description: 'Segunda contratação, para a conversa voltar.',
      price: 150,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  await expect(page.getByTestId('chat-closed')).toHaveCount(0);
  await page.getByPlaceholder('Escreva uma mensagem…').fill('Vi a proposta nova, combinado!');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(
    page.locator('.bubble.mine', { hasText: 'Vi a proposta nova, combinado!' }),
  ).toBeVisible();
});
