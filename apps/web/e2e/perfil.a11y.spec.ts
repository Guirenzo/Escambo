import { expect, test } from '@playwright/test';
import { expectAccessible } from './a11y.helpers';
import { createService, createUser, openAs, settled } from './helpers';

/**
 * Acessibilidade do perfil público do freelancer (axe, WCAG 2.1 A/AA): qualquer violação WCAG
 * reprova, de qualquer impacto (a11y.helpers.ts).
 */

test('perfil público não tem violações WCAG', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 120);
  const client = await createUser(request, 'client');

  const res = await request.get(`/api/services?q=${encodeURIComponent(service.title)}`);
  const { items } = (await res.json()) as { items: { ownerUlid: string }[] };
  expect(items[0]?.ownerUlid).toBeTruthy();

  await openAs(page, client, `/freelancers/${items[0].ownerUlid}`);
  await settled(page);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectAccessible(page, 'perfil público');
});
