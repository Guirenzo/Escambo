import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Category, Service } from '@escambo/types';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { foilIndex, Pack, PACK_FIRST_PAGE, PACK_SIZE } from './Pack';

const api = vi.hoisted(() => ({ listServices: vi.fn() }));
vi.mock('../../lib/api', () => ({ api }));

const CATEGORIES: Category[] = [
  { id: 1, parentId: null, name: 'Tecnologia', slug: 'tecnologia', iconUrl: null, children: [] },
];

const service = (id: number, extra: Partial<Service> = {}): Service =>
  ({
    id,
    title: `Serviço ${id}`,
    categoryId: 1,
    ownerName: `Freela ${id}`,
    priceType: 'fixed',
    price: 100 * id,
    ownerRating: null,
    ownerReviews: 0,
    ...extra,
  }) as Service;

const pack = (from: number, size = PACK_SIZE): Service[] =>
  Array.from({ length: size }, (_, i) => service(from + i));

const page = (items: Service[], n: number) => ({ items, page: n, limit: PACK_SIZE });

function renderPack() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Pack categories={CATEGORIES} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const stickers = () =>
  within(screen.getByRole('region', { name: 'Abra um pacotinho' })).queryAllByRole('link');

beforeEach(() => {
  api.listServices.mockReset();
});

describe('Pack', () => {
  it('fechado: só o botão e os quadros vazios, sem buscar nada', () => {
    renderPack();
    expect(screen.getByRole('button', { name: 'Abrir pacotinho' })).toBeEnabled();
    expect(stickers()).toHaveLength(0);
    expect(document.querySelectorAll('.pk-slot')).toHaveLength(PACK_SIZE);
    expect(api.listServices).not.toHaveBeenCalled();
  });

  it('o primeiro pacote começa depois do que a vitrine mostra (8 serviços, de 5 em 5: página 3)', () => {
    expect(PACK_FIRST_PAGE).toBe(3);
  });

  it('abrir busca cinco serviços de verdade e cada figurinha leva ao serviço', async () => {
    const user = userEvent.setup();
    api.listServices.mockResolvedValue(page(pack(11), PACK_FIRST_PAGE));
    renderPack();
    await user.click(screen.getByRole('button', { name: 'Abrir pacotinho' }));
    await waitFor(() => expect(stickers()).toHaveLength(PACK_SIZE));
    expect(api.listServices).toHaveBeenCalledWith({ limit: PACK_SIZE, page: PACK_FIRST_PAGE });
    expect(stickers()[0]).toHaveAttribute('href', '/servicos/11');
    expect(stickers()[0]).toHaveTextContent('Serviço 11');
    expect(stickers()[0]).toHaveTextContent('Freela 11');
    expect(stickers()[0]).toHaveTextContent('R$ 1.100,00');
    expect(screen.getByRole('status')).toHaveTextContent('5 serviços no pacotinho.');
  });

  it('abrir outro traz a página seguinte; pacote incompleto é o último e volta ao começo', async () => {
    const user = userEvent.setup();
    api.listServices
      .mockResolvedValueOnce(page(pack(11), PACK_FIRST_PAGE))
      .mockResolvedValueOnce(page(pack(16, 2), PACK_FIRST_PAGE + 1))
      .mockResolvedValueOnce(page(pack(1), 1));
    renderPack();
    await user.click(screen.getByRole('button', { name: 'Abrir pacotinho' }));
    await waitFor(() => expect(stickers()).toHaveLength(PACK_SIZE));
    await user.click(screen.getByRole('button', { name: 'Abrir outro pacotinho' }));
    await waitFor(() => expect(stickers()).toHaveLength(2));
    expect(api.listServices).toHaveBeenLastCalledWith({
      limit: PACK_SIZE,
      page: PACK_FIRST_PAGE + 1,
    });
    // A numeração segue a ordem da lista: o primeiro da página 4 é a figurinha 16.
    expect(stickers()[0]).toHaveTextContent('16');
    await user.click(screen.getByRole('button', { name: 'Abrir outro pacotinho' }));
    await waitFor(() => expect(stickers()).toHaveLength(PACK_SIZE));
    expect(api.listServices).toHaveBeenLastCalledWith({ limit: PACK_SIZE, page: 1 });
  });

  it('catálogo pequeno: sem nada depois da vitrine, o pacote abre do começo e é o único', async () => {
    const user = userEvent.setup();
    api.listServices.mockImplementation(({ page: n }: { page: number }) =>
      Promise.resolve(page(n === 1 ? pack(1, 3) : [], n)),
    );
    renderPack();
    await user.click(screen.getByRole('button', { name: 'Abrir pacotinho' }));
    await waitFor(() => expect(stickers()).toHaveLength(3));
    expect(api.listServices).toHaveBeenLastCalledWith({ limit: PACK_SIZE, page: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('3 serviços no pacotinho.');
    expect(screen.queryByRole('button', { name: /pacotinho/ })).not.toBeInTheDocument();
  });

  it('falha ao abrir: diz o que houve e deixa tentar de novo', async () => {
    const user = userEvent.setup();
    api.listServices.mockRejectedValueOnce(new Error('fora do ar'));
    api.listServices.mockResolvedValue(page(pack(11), PACK_FIRST_PAGE));
    renderPack();
    await user.click(screen.getByRole('button', { name: 'Abrir pacotinho' }));
    expect(await screen.findByText('Não deu para abrir o pacotinho agora.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(stickers()).toHaveLength(PACK_SIZE));
  });

  it('sem serviço publicado, o pacote diz isso', async () => {
    const user = userEvent.setup();
    api.listServices.mockImplementation(({ page: n }: { page: number }) =>
      Promise.resolve(page([], n)),
    );
    renderPack();
    await user.click(screen.getByRole('button', { name: 'Abrir pacotinho' }));
    expect(await screen.findByText('Ainda não há serviços publicados.')).toBeInTheDocument();
  });

  it('a brilhante é o serviço de quem tem a melhor nota; sem nota, a primeira', async () => {
    expect(foilIndex(pack(1))).toBe(0);
    expect(
      foilIndex([
        service(1),
        service(2, { ownerRating: 4.2, ownerReviews: 3 }),
        service(3, { ownerRating: 5, ownerReviews: 1 }),
      ]),
    ).toBe(2);
    const user = userEvent.setup();
    api.listServices.mockResolvedValue(
      page([service(11), service(12, { ownerRating: 5, ownerReviews: 2 })], PACK_FIRST_PAGE),
    );
    renderPack();
    await user.click(screen.getByRole('button', { name: 'Abrir pacotinho' }));
    await waitFor(() => expect(stickers()).toHaveLength(2));
    expect(stickers().map((a) => a.classList.contains('al-foil'))).toEqual([false, true]);
  });
});
