import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTree, categoriesService } from './categories.service';
import { categoriesRepository, type CategoryRow } from './categories.repository';

vi.mock('./categories.repository', () => ({
  categoriesRepository: { listActive: vi.fn() },
}));

const repo = vi.mocked(categoriesRepository);

const row = (id: number, parentId: number | null, name: string): CategoryRow =>
  ({
    id,
    parent_id: parentId,
    name,
    slug: name.toLowerCase(),
    icon_url: null,
  }) as unknown as CategoryRow;

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

  it('a órfã vira raiz sem perder o parentId que tinha (o pai só não está ativo), ao lado das outras raízes', () => {
    // O repositório só traz as ativas: subcategoria de uma categoria desativada chega sem o pai.
    expect(buildTree([row(1, null, 'Tecnologia'), row(99, 88, 'Solta')])).toEqual([
      {
        id: 1,
        parentId: null,
        name: 'Tecnologia',
        slug: 'tecnologia',
        iconUrl: null,
        children: [],
      },
      { id: 99, parentId: 88, name: 'Solta', slug: 'solta', iconUrl: null, children: [] },
    ]);
  });

  it('raízes e filhos saem na ordem em que vieram do repositório (sort_order, depois nome)', () => {
    const tree = buildTree([
      row(2, null, 'Design'),
      row(1, null, 'Tecnologia'),
      row(11, 1, 'Mobile'),
      row(12, 2, 'UI'),
      row(10, 1, 'Web'),
      row(3, null, 'Aulas'),
    ]);
    expect(tree.map((c) => c.id)).toEqual([2, 1, 3]);
    expect(tree.map((c) => c.children.map((child) => child.id))).toEqual([[12], [11, 10], []]);
  });

  it('subcategoria que aparece antes do pai na lista ainda fica debaixo dele', () => {
    // A ordem é por sort_order e nome, não por hierarquia: o filho pode vir primeiro.
    const tree = buildTree([row(10, 1, 'Apps'), row(1, null, 'Tecnologia')]);
    expect(tree).toEqual([
      {
        id: 1,
        parentId: null,
        name: 'Tecnologia',
        slug: 'tecnologia',
        iconUrl: null,
        children: [
          { id: 10, parentId: 1, name: 'Apps', slug: 'apps', iconUrl: null, children: [] },
        ],
      },
    ]);
  });

  it('a árvore tem quantos níveis os dados tiverem: neto fica debaixo do filho, não na raiz', () => {
    const tree = buildTree([row(1, null, 'Tecnologia'), row(10, 1, 'Web'), row(100, 10, 'React')]);
    expect(tree.map((c) => c.id)).toEqual([1]);
    expect(tree[0]!.children.map((c) => c.id)).toEqual([10]);
    expect(tree[0]!.children[0]!.children).toEqual([
      { id: 100, parentId: 10, name: 'React', slug: 'react', iconUrl: null, children: [] },
    ]);
  });

  it('lista vazia dá árvore vazia', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('categoriesService.getTree', () => {
  beforeEach(() => vi.clearAllMocks());

  it('monta a árvore com as categorias ativas do repositório, no formato da API', async () => {
    repo.listActive.mockResolvedValue([
      row(1, null, 'Tecnologia'),
      { ...row(10, 1, 'Web'), icon_url: '/i/web.svg' } as CategoryRow,
    ]);

    expect(await categoriesService.getTree()).toEqual([
      {
        id: 1,
        parentId: null,
        name: 'Tecnologia',
        slug: 'tecnologia',
        iconUrl: null,
        children: [
          { id: 10, parentId: 1, name: 'Web', slug: 'web', iconUrl: '/i/web.svg', children: [] },
        ],
      },
    ]);
    expect(repo.listActive).toHaveBeenCalledTimes(1);
    expect(repo.listActive).toHaveBeenCalledWith();
  });

  it('sem categoria ativa, a árvore é vazia', async () => {
    repo.listActive.mockResolvedValue([]);
    expect(await categoriesService.getTree()).toEqual([]);
  });

  it('a falha do repositório sobe para quem chamou (não vira árvore vazia)', async () => {
    const boom = new Error('ER_CON_COUNT_ERROR');
    repo.listActive.mockRejectedValueOnce(boom);
    await expect(categoriesService.getTree()).rejects.toBe(boom);
  });
});
