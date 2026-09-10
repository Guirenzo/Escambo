import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { pageTitle, RouteAnnouncer, usePageTitle } from './title';

function Tela({ title }: { title?: string }) {
  usePageTitle(title);
  return <p>conteúdo</p>;
}

describe('pageTitle', () => {
  it('compõe "tela · marca" e cai na marca sem tela', () => {
    expect(pageTitle('Carteira')).toBe('Carteira · Escambo');
    expect(pageTitle()).toBe('Escambo — o iFood dos serviços');
  });
});

describe('usePageTitle', () => {
  it('escreve o título da tela no documento', () => {
    render(<Tela title="Serviços" />);
    expect(document.title).toBe('Serviços · Escambo');
  });
});

describe('RouteAnnouncer', () => {
  it('expõe uma região viva discreta para o leitor de tela', () => {
    render(
      <MemoryRouter initialEntries={['/carteira']}>
        <Routes>
          <Route path="/carteira" element={<Tela title="Carteira" />} />
        </Routes>
        <RouteAnnouncer />
      </MemoryRouter>,
    );
    const live = screen.getByTestId('route-announcer');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveClass('sr-only');
  });
});
