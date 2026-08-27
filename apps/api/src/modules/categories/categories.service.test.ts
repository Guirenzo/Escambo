import { describe, expect, it } from 'vitest';
import { buildTree } from './categories.service';
import type { CategoryRow } from './categories.repository';

const row = (id: number, parentId: number | null, name: string): CategoryRow =>
  ({ id, parent_id: parentId, name, slug: name.toLowerCase(), icon_url: null }) as unknown as CategoryRow;

describe('buildTree', () => {
  it('agrupa subcategorias sob suas raízes', () => {
    const tree = buildTree([
      row(1, null, 'Tecnologia'),
      row(2, null, 'Design'),
      row(10, 1, 'Web'),
      row(11, 1, 'Mobile'),
      row(12, 2, 'UI'),
    ]);

    expect(tree).toHaveLength(2);
    const tech = tree.find((c) => c.id === 1)!;
    expect(tech.children.map((c) => c.id)).toEqual([10, 11]);
    const design = tree.find((c) => c.id === 2)!;
    expect(design.children.map((c) => c.id)).toEqual([12]);
  });

  it('trata órfãos (pai inexistente) como raiz', () => {
    const tree = buildTree([row(99, 88, 'Órfã')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe(99);
  });
});
