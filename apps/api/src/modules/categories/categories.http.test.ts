import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routerApp } from '../../test-support/http';
import { categoriesRoutes } from './categories.routes';

const { service } = vi.hoisted(() => ({ service: { getTree: vi.fn() } }));
vi.mock('./categories.service', () => ({ categoriesService: service }));

const app = routerApp('/api/categories', categoriesRoutes);

/** Rota e controller das categorias: a árvore é pública e sai como o service montou. */
describe('categorias: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /api/categories devolve a árvore sem exigir login', async () => {
    const tree = [
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
    ];
    service.getTree.mockResolvedValue(tree);

    const res = await request(app).get('/api/categories').expect(200);

    expect(res.body).toEqual(tree);
    expect(service.getTree).toHaveBeenCalledTimes(1);
    expect(service.getTree).toHaveBeenCalledWith();
  });

  it('é pública de verdade: responde mesmo com token inválido, e nada da URL muda o que é pedido ao service', async () => {
    const tree = [{ id: 2, parentId: null, name: 'Design', slug: 'design', iconUrl: null }];
    service.getTree.mockResolvedValue(tree);

    const res = await request(app)
      .get('/api/categories?includeInactive=true&parentId=1')
      .set({ Authorization: 'Bearer nao-e-um-jwt' })
      .expect(200);

    expect(res.body).toEqual(tree);
    // Sem argumentos: não há filtro que o visitante controle (inativas não aparecem por parâmetro).
    expect(service.getTree.mock.calls).toEqual([[]]);
  });

  it('sem categorias ativas, devolve a lista vazia (e não 404)', async () => {
    service.getTree.mockResolvedValue([]);
    const res = await request(app).get('/api/categories').expect(200);
    expect(res.body).toEqual([]);
  });

  it('falha ao montar a árvore vira 500 sem expor o erro (RNF-039)', async () => {
    service.getTree.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3306'));
    const res = await request(app).get('/api/categories').expect(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
  });

  it('só existe a listagem: categoria por id e escrita caem no 404 padrão', async () => {
    const porId = await request(app).get('/api/categories/1').expect(404);
    expect(porId.body.error).toBe('not_found');
    const escrita = await request(app).post('/api/categories').send({ name: 'Nova' }).expect(404);
    expect(escrita.body.error).toBe('not_found');
    expect(service.getTree).not.toHaveBeenCalled();
  });
});
