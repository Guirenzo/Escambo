import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Auditoria automática de acessibilidade (axe-core) compartilhada pelos specs de acessibilidade.
 *
 * Regra do CI (docs/acessibilidade.md): qualquer violação de regra com etiqueta WCAG 2.0/2.1 A ou AA
 * reprova, seja qual for o impacto que o axe atribui (critical, serious, moderate ou minor). As
 * regras de boa prática do axe (etiqueta `best-practice`, que não correspondem a um critério WCAG,
 * como "todo conteúdo dentro de um landmark") e os itens que o axe não consegue decidir sozinho
 * (`incomplete`, por exemplo contraste sobre fundo com gradiente) ficam só no relatório, como
 * anotação do teste, para a revisão manual.
 */

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const describe = (
  name: string,
  v: { id: string; impact?: string | null; help: string; nodes: { target: unknown[] }[] },
): string =>
  `[${name}] ${v.id} (${v.impact ?? 'sem impacto'}): ${v.help}\n` +
  v.nodes
    .slice(0, 6)
    .map((n) => `    ${n.target.map(String).join(' ')}`)
    .join('\n');

/**
 * Roda o axe na página como está agora e devolve as violações WCAG (vazio = passou). Boa prática e
 * "precisa de revisão" entram como anotação.
 */
export async function audit(
  page: Page,
  name: string,
  opts: { include?: string; exclude?: string[] } = {},
): Promise<string[]> {
  let builder = new AxeBuilder({ page }).withTags([...WCAG_TAGS, 'best-practice']);
  if (opts.include) builder = builder.include(opts.include);
  for (const sel of opts.exclude ?? []) builder = builder.exclude(sel);
  const results = await builder.analyze();
  const isWcag = (tags: string[]): boolean => tags.some((t) => WCAG_TAGS.includes(t));
  const failing = results.violations.filter((v) => isWcag(v.tags));
  const advisory = results.violations.filter((v) => !isWcag(v.tags));
  const review = results.incomplete.filter((v) => isWcag(v.tags));
  test.info().annotations.push({
    type: 'axe',
    description:
      `${name}: ${failing.length} violação(ões) WCAG` +
      (advisory.length ? `; boa prática: ${advisory.map((v) => v.id).join(', ')}` : '') +
      (review.length
        ? `; revisar à mão: ${review.map((v) => `${v.id} (${v.nodes.length})`).join(', ')}`
        : ''),
  });
  return failing.map((v) => describe(name, v));
}

/** Atalho: a página não pode ter nenhuma violação WCAG agora. */
export async function expectAccessible(
  page: Page,
  name: string,
  opts?: { include?: string; exclude?: string[] },
): Promise<void> {
  const problems = await audit(page, name, opts);
  expect(problems.join('\n')).toBe('');
}
