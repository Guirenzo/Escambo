import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createUser, openAs, settled } from './helpers';

/**
 * Acessibilidade automatizada (axe-core, regras WCAG 2.x A/AA) nas telas principais.
 * Audita todas as telas e falha uma vez só, listando cada violação de impacto
 * `serious`/`critical` com os elementos afetados — as demais ficam no relatório.
 */

const BLOCKING = new Set(['serious', 'critical']);

async function audit(page: Page, name: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ''));
  test.info().annotations.push({
    type: 'axe',
    description: `${name}: ${results.violations.length} violação(ões), ${blocking.length} bloqueante(s)`,
  });
  return blocking.map(
    (v) =>
      `[${name}] ${v.id} (${v.impact}): ${v.help}\n` +
      v.nodes
        .slice(0, 5)
        .map((n) => `    ${n.target.join(' ')}`)
        .join('\n'),
  );
}

test('login não tem violações bloqueantes', async ({ page }) => {
  await page.goto('/login');
  expect((await audit(page, 'login')).join('\n')).toBe('');
});

test('telas autenticadas não têm violações bloqueantes', async ({ page, request }) => {
  const user = await createUser(request, 'freelancer');
  const problems: string[] = [];
  for (const [path, name] of [
    ['/', 'início'],
    ['/servicos', 'serviços'],
    ['/trocas', 'trocas'],
    ['/carteira', 'carteira'],
    ['/ranking', 'ranking'],
    ['/notificacoes', 'notificações'],
    ['/perfil', 'perfil'],
  ] as const) {
    await openAs(page, user, path);
    await settled(page);
    problems.push(...(await audit(page, name)));
  }
  expect(problems.join('\n')).toBe('');
});
