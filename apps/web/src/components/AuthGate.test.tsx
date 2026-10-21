import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate, backTo } from './AuthGate';

const auth = { user: null as { id: number } | null, loading: false };
vi.mock('../lib/auth', () => ({ useAuth: () => auth }));

/** Onde /login mostra o que a guarda mandou. */
function LoginProbe() {
  const { state } = useLocation();
  return <p data-testid="from">{backTo(state)}</p>;
}

function renderAt(path: string, home?: ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginProbe />} />
        <Route element={<AuthGate home={home} />}>
          <Route path="/" element={<p>início do app</p>} />
          <Route path="/admin" element={<p>painel</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.user = null;
  auth.loading = false;
});

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

describe('AuthGate', () => {
  it('sem sessão, uma rota do app manda para /login guardando caminho, busca e âncora', () => {
    renderAt('/admin?aba=saude#health-title', <h1>Landing</h1>);
    expect(screen.getByTestId('from')).toHaveTextContent('/admin?aba=saude#health-title');
    expect(screen.queryByText('painel')).not.toBeInTheDocument();
  });

  it('sem sessão, a raiz mostra a página pública no lugar do app, sem trocar o endereço', () => {
    renderAt('/', <h1>Landing</h1>);
    expect(screen.getByRole('heading', { name: 'Landing' })).toBeInTheDocument();
    expect(screen.queryByText('início do app')).not.toBeInTheDocument();
    expect(screen.queryByTestId('from')).not.toBeInTheDocument();
  });

  it('sem página pública, a raiz sem sessão também vai para o login', () => {
    renderAt('/');
    expect(screen.getByTestId('from')).toHaveTextContent('/');
  });

  it('com sessão, a raiz é o início do app (e a página pública não aparece)', () => {
    auth.user = { id: 1 };
    renderAt('/', <h1>Landing</h1>);
    expect(screen.getByText('início do app')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Landing' })).not.toBeInTheDocument();
  });

  it('enquanto a sessão é conferida, mostra o carregando, nem landing nem app', () => {
    auth.loading = true;
    renderAt('/', <h1>Landing</h1>);
    expect(screen.getByRole('status', { name: 'Carregando…' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});
