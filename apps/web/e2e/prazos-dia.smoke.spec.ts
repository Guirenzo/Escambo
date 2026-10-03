import { expect, test } from '@playwright/test';
import {
  createService,
  createUser,
  deadlineTextPlus,
  inputDatePlusIn,
  openAs,
  settled,
  topUp,
} from './helpers';

/**
 * O prazo é um dia no horário de quem entrega (ADR 58, RN-080): a cliente, em Brasília, contrata um
 * freelancer em Manaus. O modal escolhe o dia no fuso dele e diz de qual horário se trata; a Sala
 * mostra o mesmo dia às duas partes, com "(horário de Manaus)" só para a cliente; a API grava o fim
 * do dia em Manaus. Depois da revisão pedida, as duas partes veem desde quando (RN-081). Desktop e
 * mobile.
 */

const h = (t: string) => ({ Authorization: `Bearer ${t}` });
const MANAUS = 'America/Manaus';

test('prazo no horário de quem entrega: o mesmo dia para as duas partes, com a nota só para quem está em outro relógio', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const prefs = await request.put('/api/notifications/preferences', {
    headers: h(freelancer.token),
    data: { timezone: MANAUS },
  });
  expect(prefs.ok(), await prefs.text()).toBeTruthy();
  const service = await createService(request, freelancer, 300); // prazo do serviço: 3 dias
  const client = await createUser(request, 'client');
  await topUp(request, client, 300);

  // Modal: o dia é o de Manaus (mínimo amanhã lá) e a dica diz de qual horário se trata.
  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(service.title);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const card = page.locator('.card.service', { hasText: service.title });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Contratar' }).click();
  const modal = page.getByRole('dialog');
  const date = modal.getByLabel('Prazo de entrega');
  await expect(date).toHaveValue(inputDatePlusIn(MANAUS, 3));
  await expect(date).toHaveAttribute('min', inputDatePlusIn(MANAUS, 1));
  const hint = modal.getByTestId('deadline-hint');
  await expect(hint).toContainText(
    'Vale até 23:59 do dia, no horário de Manaus (de quem entrega).',
  );
  await expect(hint).toContainText('a partir das 9h do dia seguinte, também no horário de Manaus,');
  await date.fill(inputDatePlusIn(MANAUS, 5));
  await modal.getByRole('button', { name: 'Enviar proposta' }).click();
  await expect(page).toHaveURL(/\/contratos\/\d+$/);
  const contractId = Number(page.url().split('/').pop());

  // A API grava 23:59:59 de Manaus (03:59:59Z do dia seguinte) e diz o fuso do prazo.
  const got = await request.get(`/api/contracts/${contractId}`, { headers: h(client.token) });
  expect(got.ok(), await got.text()).toBeTruthy();
  const contract = (await got.json()) as { deadlineAt: string; deadlineZone: string };
  expect(contract.deadlineZone).toBe(MANAUS);
  expect(contract.deadlineAt).toMatch(/T03:59:59(\.000)?Z$/);

  // Cliente em Brasília: o dia de Manaus, com a nota.
  await expect(page.getByTestId('deadline-date')).toHaveText(deadlineTextPlus(5, MANAUS));
  await expect(page.getByTestId('deadline-zone')).toHaveText('(horário de Manaus)');
  await expect(page.getByTestId('deadline-kv')).toHaveText(
    `${deadlineTextPlus(5, MANAUS)} (horário de Manaus)`,
  );

  // Freelancer em Manaus: o mesmo dia, sem nota.
  const acc = await request.post(`/api/contracts/${contractId}/accept`, {
    headers: h(freelancer.token),
  });
  expect(acc.ok(), await acc.text()).toBeTruthy();
  await openAs(page, freelancer, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByTestId('deadline-date')).toHaveText(deadlineTextPlus(5, MANAUS));
  await expect(page.getByTestId('deadline-zone')).toHaveCount(0);

  // Entrega e revisão: as duas partes veem desde quando a revisão está pedida.
  const del = await request.post(`/api/contracts/${contractId}/deliver`, {
    headers: h(freelancer.token),
    data: { message: 'Primeira versão na pasta combinada.' },
  });
  expect(del.ok(), await del.text()).toBeTruthy();
  const rev = await request.post(`/api/contracts/${contractId}/request-revision`, {
    headers: h(client.token),
    data: { note: 'Falta a versão em preto e branco' },
  });
  expect(rev.ok(), await rev.text()).toBeTruthy();
  await page.reload();
  await settled(page);
  await expect(page.getByTestId('revision-since')).toContainText('Revisão pedida em');
  await expect(page.getByTestId('revision-since')).toContainText(': registre a nova entrega.');

  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByTestId('revision-since')).toContainText(
    'Não há hora-limite: nada muda sozinho.',
  );
});
