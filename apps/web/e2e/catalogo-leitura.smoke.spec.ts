import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  createService,
  createUser,
  deliveredContract,
  openAs,
  settled,
  type TestUser,
} from './helpers';

/**
 * 1.44.0 (ADR 62): a tag leva à busca e ao detalhe do serviço, a visita conta para o dono (RF-024,
 * RF-029), "remoto e presencial" aparece no filtro presencial (RF-023), e a mensagem enviada vira
 * "Lida" na hora em que o outro lado lê (RF-059).
 */

const unique = (): string => Math.random().toString(36).slice(2, 8);

async function call<T>(
  request: APIRequestContext,
  method: 'get' | 'post' | 'patch',
  path: string,
  user: TestUser,
  data?: unknown,
): Promise<T> {
  const res = await request[method](`/api${path}`, {
    data,
    headers: { Authorization: `Bearer ${user.token}` },
  });
  expect(res.ok(), `${method.toUpperCase()} ${path} → ${res.status()} ${await res.text()}`).toBe(
    true,
  );
  return (await res.json()) as T;
}

test('tag leva à busca e ao detalhe, a visita conta para o dono e "os dois" aparece no filtro presencial', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const service = await createService(request, freelancer, 180);
  const tag = `e2e ${unique()}`;
  await call(request, 'patch', `/services/${service.id}`, freelancer, {
    tags: [tag, 'Identidade Visual'],
    modality: 'both',
  });

  // O link de uma tag (/servicos?q=...) busca por ela.
  await openAs(page, client, `/servicos?q=${encodeURIComponent(tag)}`);
  await settled(page);
  const card = page.locator('.card', { hasText: service.title }).first();
  await expect(card).toBeVisible();
  await expect(card.getByRole('link', { name: tag })).toBeVisible();

  // "Remoto e presencial" entra no filtro presencial também.
  await page.getByLabel('Filtrar por modalidade').selectOption({ label: 'presencial' });
  await expect(page.locator('.card', { hasText: service.title }).first()).toBeVisible();

  // O título abre o detalhe, com as tags; a visita de quem não é o dono conta.
  await page.getByRole('link', { name: service.title }).first().click();
  await expect(page).toHaveURL(new RegExp(`/servicos/${service.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: service.title })).toBeVisible();
  await expect(page.getByRole('link', { name: 'identidade visual' })).toBeVisible();

  const mine = await call<
    { items?: { id: number; viewsCount?: number }[] } | { id: number; viewsCount?: number }[]
  >(request, 'get', '/services/mine', freelancer);
  const list = Array.isArray(mine) ? mine : (mine.items ?? []);
  expect(list.find((s) => s.id === service.id)?.viewsCount).toBe(1);
});

test('mensagem enviada aparece como "Enviada" e vira "Lida" quando o outro lado lê', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 220);
  const client = await createUser(request, 'client');
  const contractId = await deliveredContract(request, client, freelancer, service);
  const text = `Recebi, vou olhar hoje ${unique()}`;
  await call(request, 'post', `/messaging/contracts/${contractId}`, client, { content: text });

  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  const bubble = page.locator('.bubble', { hasText: text });
  await expect(bubble).toContainText('Enviada');

  // O freelancer abre a conversa: o "Lida" chega pelo tempo real, sem recarregar.
  await call(request, 'post', `/messaging/contracts/${contractId}/read`, freelancer, {});
  await expect(bubble).toContainText('Lida');
  await expect(bubble).not.toContainText('Enviada');
});
