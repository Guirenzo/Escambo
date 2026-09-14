import { expect, test } from '@playwright/test';
import {
  createService,
  createUser,
  deliveredContract,
  openAs,
  pngFixture,
  settled,
} from './helpers';

/**
 * Anexos no chat (ADR 29): o freelancer manda uma imagem com legenda pela Sala, a cliente vê,
 * abre em tamanho real e responde com um PDF, que o freelancer baixa. O tipo é reconhecido pelo
 * conteúdo: "foto.png" que é HTML é recusado pela API. Desktop e mobile.
 */

const h = (t: string) => ({ Authorization: `Bearer ${t}` });

// PNG de verdade (renderiza) e um PDF de uma linha (o detector só olha o começo).
const PNG = pngFixture();
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
);

test('imagem com legenda e PDF vão e voltam entre as partes', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const service = await createService(request, freelancer, 250);
  const contractId = await deliveredContract(request, client, freelancer, service);

  // Freelancer: clipe → arquivo → legenda → enviar. A bolha mostra a imagem e a legenda.
  await openAs(page, freelancer, `/contratos/${contractId}`);
  await settled(page);
  await page
    .getByTestId('attachment-input')
    .setInputFiles({ name: 'rascunho.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByTestId('attachment-pending')).toContainText('rascunho.png');
  await page.getByPlaceholder('Legenda (opcional)…').fill('Olha o rascunho da home');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const bubble = page.getByTestId('attachment-bubble').first();
  await expect(bubble).toContainText('Olha o rascunho da home');
  await expect(bubble.getByRole('img', { name: 'rascunho.png' })).toBeVisible();
  await expect(page.getByTestId('attachment-pending')).toHaveCount(0);

  // Cliente: vê a imagem, abre em tamanho real, fecha com Esc e responde com um PDF.
  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByRole('img', { name: 'rascunho.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Abrir imagem rascunho.png' }).click();
  await expect(page.getByRole('dialog', { name: 'rascunho.png' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'rascunho.png' })).toHaveCount(0);

  await page
    .getByTestId('attachment-input')
    .setInputFiles({ name: 'briefing.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const file = page.getByRole('button', { name: 'Baixar briefing.pdf' });
  await expect(file).toBeVisible();

  // Freelancer recebe o PDF e baixa com o nome certo.
  await openAs(page, freelancer, `/contratos/${contractId}`);
  await settled(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Baixar briefing.pdf' }).click();
  expect((await download).suggestedFilename()).toBe('briefing.pdf');
});

test('API: o tipo vem do conteúdo — "foto.png" que é HTML é recusado; só as partes baixam', async ({
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const stranger = await createUser(request, 'client');
  const service = await createService(request, freelancer, 250);
  const contractId = await deliveredContract(request, client, freelancer, service);
  const url = `/api/messaging/contracts/${contractId}/attachments`;

  const html = await request.post(url, {
    headers: h(client.token),
    multipart: {
      file: { name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('<html><script>') },
    },
  });
  expect(html.status()).toBe(422);
  expect((await html.json()).error).toBe('unsupported_file_type');

  const ok = await request.post(url, {
    headers: h(client.token),
    multipart: { file: { name: 'foto.png', mimeType: 'image/png', buffer: PNG }, content: 'ok' },
  });
  expect(ok.status()).toBe(201);
  const sent = (await ok.json()) as { attachment: { url: string } };

  expect((await request.get(sent.attachment.url, { headers: h(stranger.token) })).status()).toBe(
    403,
  );
  const mine = await request.get(sent.attachment.url, { headers: h(freelancer.token) });
  expect(mine.status()).toBe(200);
  expect(mine.headers()['content-type']).toBe('image/png');
});
