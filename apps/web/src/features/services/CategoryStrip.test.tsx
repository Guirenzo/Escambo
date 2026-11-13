import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Category } from '@escambo/types';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryStrip } from './CategoryStrip';

/**
 * Faixa de categorias com foto: no Início, ladrilhos que levam à busca filtrada; em Serviços,
 * pílulas que ligam o filtro (com "Todas" na frente). A foto é decorativa; o nome é o texto.
 */

const api = vi.hoisted(() => ({ categories: vi.fn() }));
vi.mock('../../lib/api', () => ({ api }));

const cat = (id: number, name: string, slug: string): Category => ({
  id,
  parentId: null,
  name,
  slug,
  iconUrl: null,
  children: [],
});

const TREE: Category[] = [
  cat(1, 'Tecnologia', 'tecnologia'),
  cat(3, 'Reformas e Reparos', 'reformas-reparos'),
  cat(9, 'Pets', 'pets'),
];

function show(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.categories.mockReset();
  api.categories.mockResolvedValue(TREE);
});

describe('CategoryStrip', () => {
  it('ladrilhos: cada categoria raiz é um link para a busca filtrada, com o nome por extenso', async () => {
    show(<CategoryStrip variant="tiles" />);
    const list = await screen.findByRole('list', { name: 'Categorias' });
    expect(
      within(list)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Tecnologia', '/servicos?categoria=1'],
      ['Reformas e Reparos', '/servicos?categoria=3'],
      ['Pets', '/servicos?categoria=9'],
    ]);
  });

  it('ladrilhos: o desenho do ofício é decorativo, sobre uma cor chapada, sem foto', async () => {
    show(<CategoryStrip variant="tiles" />);
    const tech = await screen.findByRole('link', { name: 'Tecnologia' });
    const art = tech.querySelector('.cat-art')!;
    expect(art).toHaveAttribute('aria-hidden', 'true');
    expect(art).toHaveClass('al-g-sky');
    expect(art.querySelector('svg')).not.toBeNull();
    // Sem foto nos ladrilhos: a mesma foto repetida pela tela cansa.
    expect(tech.querySelector('img')).toBeNull();
    // A cor segue a ordem das categorias; uma categoria nova usa o ícone neutro.
    const pets = screen.getByRole('link', { name: 'Pets' }).querySelector('.cat-art')!;
    expect(pets).toHaveClass('al-g-tomato');
    expect(pets.querySelector('svg')).not.toBeNull();
  });

  it('pílulas: "Todas" e as categorias como botões de ligar; a escolhida fica pressionada', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    show(<CategoryStrip variant="chips" selected={3} onSelect={onSelect} />);
    const list = await screen.findByRole('list', { name: 'Categorias' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['Todas', 'false'],
      ['Tecnologia', 'false'],
      ['Reformas e Reparos', 'true'],
      ['Pets', 'false'],
    ]);
    await user.click(screen.getByRole('button', { name: 'Tecnologia' }));
    expect(onSelect).toHaveBeenLastCalledWith(1);
    await user.click(screen.getByRole('button', { name: 'Todas' }));
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it('sem filtro, "Todas" fica pressionada; sem quem ouça, clicar não quebra', async () => {
    const user = userEvent.setup();
    show(<CategoryStrip variant="chips" />);
    expect(await screen.findByRole('button', { name: 'Todas' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Pets' }));
    expect(screen.getByRole('button', { name: 'Pets' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('sem categorias (carregando ou vazio), não mostra nada', async () => {
    api.categories.mockResolvedValue([]);
    const { container } = show(<CategoryStrip variant="tiles" />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });
});
