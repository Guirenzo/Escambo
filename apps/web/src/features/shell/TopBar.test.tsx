import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar, unreadLabel } from './TopBar';

/**
 * Barra superior do app: a busca global leva à busca de serviços com o texto, o sino diz quantas
 * não lidas há, e o menu da conta abre e fecha como um botão de mostrar/esconder (Esc, clique fora).
 */

/** Para onde a barra levou: a rota de destino escreve o caminho e a busca. */
function Where() {
  const { pathname, search } = useLocation();
  return <p>rota: {`${pathname}${search}`}</p>;
}

const onLogout = vi.fn();

function renderBar(o: { unread?: number; avatarUrl?: string | null; path?: string } = {}) {
  return render(
    <MemoryRouter initialEntries={[o.path ?? '/']}>
      <TopBar
        name="Ana"
        email="ana@escambo.test"
        role="Cliente"
        avatarUrl={o.avatarUrl ?? null}
        unread={o.unread ?? 0}
        onLogout={onLogout}
      />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  onLogout.mockReset();
});

describe('TopBar: busca global', () => {
  it('Enter leva à busca de serviços com o texto (codificado) e limpa o campo', async () => {
    const user = userEvent.setup();
    renderBar();
    const search = screen.getByRole('search', { name: 'Busca no Escambo' });
    const field = within(search).getByRole('searchbox', { name: 'Buscar serviços no Escambo' });
    expect(field).toHaveAttribute('placeholder', 'Buscar serviços ou tags…');
    await user.type(field, '  logo & site {Enter}');
    expect(screen.getByText('rota: /servicos?q=logo%20%26%20site')).toBeInTheDocument();
    expect(field).toHaveValue('');
  });

  it('sem texto, leva à busca de serviços sem filtro', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.type(screen.getByRole('searchbox'), '   {Enter}');
    expect(screen.getByText('rota: /servicos')).toBeInTheDocument();
  });

  it('no celular, a lupa abre e fecha o campo; Esc fecha e devolve o foco à lupa', async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    const toggle = screen.getByRole('button', { name: 'Abrir busca' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'busca-global');
    await user.click(toggle);
    expect(container.querySelector('.topbar')).toHaveClass('searching');
    expect(screen.getByRole('button', { name: 'Fechar busca' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // Aberto, o foco vai direto para o campo.
    expect(screen.getByRole('searchbox')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(container.querySelector('.topbar')).not.toHaveClass('searching');
    expect(screen.getByRole('button', { name: 'Abrir busca' })).toHaveFocus();

    // Esc com o campo fechado (desktop) não mexe em nada.
    await user.click(screen.getByRole('searchbox'));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });
});

describe('TopBar: notificações', () => {
  it('sem não lidas, o sino só abre as notificações, sem contagem', () => {
    renderBar();
    const bell = screen.getByRole('link', { name: 'Abrir notificações' });
    expect(bell).toHaveAttribute('href', '/notificacoes');
    expect(screen.queryByTestId('topbar-count')).not.toBeInTheDocument();
  });

  it('com não lidas, o nome do link diz quantas; acima de 99 o número vira "99+"', () => {
    const first = renderBar({ unread: 1 });
    expect(
      screen.getByRole('link', { name: 'Abrir notificações, 1 não lida' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('topbar-count')).toHaveTextContent(/^1$/);
    first.unmount();

    renderBar({ unread: 150, path: '/notificacoes' });
    expect(screen.getByRole('link', { name: 'Abrir notificações, 150 não lidas' })).toHaveClass(
      'active',
    );
    expect(screen.getByTestId('topbar-count')).toHaveTextContent(/^99\+$/);
  });

  it('unreadLabel: singular e plural', () => {
    expect(unreadLabel(1)).toBe('1 não lida');
    expect(unreadLabel(2)).toBe('2 não lidas');
  });
});

describe('TopBar: menu da conta', () => {
  it('abre com quem está logado, leva ao perfil e ao suporte e sai da conta', async () => {
    const user = userEvent.setup();
    renderBar({ avatarUrl: 'https://fotos.test/ana.png' });
    const button = screen.getByRole('button', { name: 'Menu da conta' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('ana@escambo.test')).not.toBeInTheDocument();

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('ana@escambo.test')).toBeInTheDocument();
    expect(screen.getByText('Cliente')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Meu perfil' })).toHaveAttribute('href', '/perfil');
    expect(screen.getByRole('link', { name: 'Ajuda e suporte' })).toHaveAttribute(
      'href',
      '/suporte',
    );

    await user.click(screen.getByRole('button', { name: 'Sair da conta' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('ir a outra tela fecha o menu', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole('button', { name: 'Menu da conta' }));
    await user.click(screen.getByRole('link', { name: 'Meu perfil' }));
    expect(screen.getByText('rota: /perfil')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Meu perfil' })).not.toBeInTheDocument();
  });

  it('Esc fecha e devolve o foco ao botão; clique fora fecha; clique dentro não', async () => {
    const user = userEvent.setup();
    renderBar();
    const button = screen.getByRole('button', { name: 'Menu da conta' });
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();

    await user.click(button);
    await user.click(screen.getByText('ana@escambo.test'));
    expect(button).toHaveAttribute('aria-expanded', 'true');
    // Outra tecla não fecha.
    await user.keyboard('a');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByText(/^rota:/));
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});
