import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { categoriesRepository } from './categories.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/** Repository das categorias sem banco: o que a listagem pede e o que devolve. */
describe('categoriesRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('lista só as categorias ativas, na ordem do cadastro (sort_order) e depois por nome', async () => {
    const rows = [
      { id: 1, parent_id: null, name: 'Tecnologia', slug: 'tecnologia', icon_url: null },
      { id: 10, parent_id: 1, name: 'Web', slug: 'web', icon_url: '/i/web.svg' },
    ];
    fakeDb.reply(rows);

    expect(await categoriesRepository.listActive()).toBe(rows);

    expect(fakeDb.calls).toHaveLength(1);
    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toBe(
      'SELECT id, parent_id, name, slug, icon_url FROM service_categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC',
    );
    // Sem parâmetros: nada do usuário entra nessa consulta.
    expect(params).toBeUndefined();
  });

  it('sem categoria ativa, devolve a lista vazia', async () => {
    expect(await categoriesRepository.listActive()).toEqual([]);
  });

  it('a falha do banco sobe para quem chamou', async () => {
    const boom = new Error('ER_CON_COUNT_ERROR');
    fakeDb.reply(boom);
    await expect(categoriesRepository.listActive()).rejects.toBe(boom);
  });
});
