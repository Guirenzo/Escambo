import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { backTo, RequireAuth } from './RequireAuth';

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: null, loading: false }) }));

/** Onde /login mostra o que a guarda mandou. */
function LoginProbe() {
  const { state } = useLocation();
  return <p data-testid="from">{backTo(state)}</p>;
}

/** A guarda lembra caminho, busca e âncora; o login só volta para caminhos do próprio app (ADR 55). */
describe('backTo', () => {
  it('aceita só caminhos do app; o resto vira a home', () => {
    expect(backTo({ from: '/admin#health-title' })).toBe('/admin#health-title');
    expect(backTo({ from: '/servicos?q=logo&pagina=2' })).toBe('/servicos?q=logo&pagina=2');
    expect(backTo({ from: '//evil.example/x' })).toBe('/');
    expect(backTo({ from: 'https://evil.example' })).toBe('/');
    expect(backTo({ from: 'javascript:alert(1)' })).toBe('/');
    expect(backTo({ from: 42 })).toBe('/');
    expect(backTo(null)).toBe('/');
    expect(backTo(undefined)).toBe('/');
  });
});

describe('RequireAuth', () => {
  it('sem sessão manda para /login guardando caminho, busca e âncora', () => {
    render(
      <MemoryRouter initialEntries={['/admin?aba=saude#health-title']}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route element={<RequireAuth />}>
            <Route path="/admin" element={<p>painel</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('from')).toHaveTextContent('/admin?aba=saude#health-title');
    expect(screen.queryByText('painel')).not.toBeInTheDocument();
  });
});
