import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createService, createUser, openAs, settled } from './helpers';

/** Acessibilidade do perfil público do freelancer (axe, WCAG 2.1 A/AA). */

async function blocking(page: Page): Promise<string> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
    )
    .join('\n');
}

test('perfil público não tem violações bloqueantes', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 120);
  const client = await createUser(request, 'client');

  const res = await request.get(`/api/services?q=${encodeURIComponent(service.title)}`);
  const { items } = (await res.json()) as { items: { ownerUlid: string }[] };
  expect(items[0]?.ownerUlid).toBeTruthy();

  await openAs(page, client, `/freelancers/${items[0].ownerUlid}`);
  await settled(page);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await blocking(page)).toBe('');
});
