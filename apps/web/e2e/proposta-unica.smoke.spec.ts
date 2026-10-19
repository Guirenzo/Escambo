import { expect, test } from '@playwright/test';
import { createService, createUser, openAs, settled, topUp } from './helpers';

for (const mode of ['cash', 'credits'] as const) {
  test(`proposta única em ${mode}: mantém formulário, saldo e link para contratação existente`, async ({
    page,
    request,
  }, info) => {
    const freelancer = await createUser(request, 'freelancer');
    const service = await createService(request, freelancer, 100);
    const client = await createUser(request, 'client');
    await topUp(request, client, 500);
    const headers = { Authorization: `Bearer ${client.token}` };
    const first = await request.post('/api/contracts', {
      headers,
      data: {
        freelancerId: freelancer.id,
        serviceId: service.id,
        title: service.title,
        description: 'Contratação original para conferir proposta única.',
        price: 100,
        paymentMode: mode,
      },
    });
    expect(first.status(), await first.text()).toBe(201);
    const { id } = (await first.json()) as { id: number };
    const beforeResponse = await request.get('/api/wallet', { headers });
    expect(beforeResponse.ok()).toBe(true);
    const before = await beforeResponse.json();
    await openAs(page, client, '/servicos');
    await settled(page);
    await page.getByPlaceholder('Buscar serviços…').fill(service.title);
    await page.getByRole('button', { name: 'Buscar' }).click();
    const card = page.locator('.card.service', { hasText: service.title });
    await card.getByRole('button', { name: 'Contratar' }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Título', { exact: true }).fill('Outro trabalho com o mesmo freelancer');
    if (mode === 'credits') await modal.getByText('Créditos Escambo', { exact: true }).click();
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/api/contracts') && r.request().method() === 'POST',
    );
    await modal.getByRole('button', { name: 'Enviar proposta' }).click();
    const rejected = await response;
    expect(rejected.status()).toBe(409);
    expect(rejected.request().postDataJSON().paymentMode).toBe(mode);
    await expect(modal.getByLabel('Título', { exact: true })).toHaveValue(
      'Outro trabalho com o mesmo freelancer',
    );
    const existing = modal.getByRole('link', { name: 'Abrir contratação existente' });
    await expect(existing).toHaveAttribute('href', `/contratos/${id}`);
    await expect(page).toHaveURL(/\/servicos$/);
    expect(await (await request.get('/api/wallet', { headers })).json()).toEqual(before);
    await existing.scrollIntoViewIfNeeded();
    await expect(existing).toBeVisible();
    await page.screenshot({ path: info.outputPath(`proposta-unica-${mode}.png`), fullPage: true });
    await existing.click();
    await expect(page).toHaveURL(new RegExp(`/contratos/${id}$`));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const cancelled = await request.post(`/api/contracts/${id}/cancel`, { headers, data: {} });
    expect(cancelled.ok(), await cancelled.text()).toBe(true);
    const next = await request.post('/api/contracts', {
      headers,
      data: {
        freelancerId: freelancer.id,
        title: 'Próximo trabalho',
        description: 'Nova contratação após encerrar a anterior.',
        price: 100,
        paymentMode: mode,
      },
    });
    expect(next.status(), await next.text()).toBe(201);
  });
}
