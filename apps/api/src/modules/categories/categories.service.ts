import type { Category } from '@escambo/types';
import { categoriesRepository, type CategoryRow } from './categories.repository';

/** Monta a árvore de categorias (raízes com filhos) a partir da lista plana. */
export function buildTree(rows: CategoryRow[]): Category[] {
  const byId = new Map<number, Category>();
  const roots: Category[] = [];

  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      slug: r.slug,
      iconUrl: r.icon_url,
      children: [],
    });
  }
  for (const r of rows) {
    const node = byId.get(r.id)!;
    const parent = r.parent_id != null ? byId.get(r.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export const categoriesService = {
  async getTree(): Promise<Category[]> {
    return buildTree(await categoriesRepository.listActive());
  },
};
