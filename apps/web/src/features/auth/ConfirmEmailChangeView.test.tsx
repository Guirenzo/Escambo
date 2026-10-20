import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmEmailChangeView } from './AccountViews';

/**
 * /confirmar-novo-email (RF-017): a troca só acontece com o clique (um leitor de links não troca o
 * e-mail de ninguém), a aba logada na mesma conta segue dentro, e sem sessão a pessoa é mandada a
 * entrar com o e-mail novo.
 */

const confirmEmailChange = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { confirmEmailChange: (token: string) => confirmEmailChange(token) },
}));

const auth = {
  user: null as { id: number; email: string } | null,
  refreshUser: vi.fn(),
};
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

const TOKEN = 'a'.repeat(40);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/confirmar-novo-email" element={<ConfirmEmailChangeView />} />
        <Route path="/login" element={<p>tela de login</p>} />
        <Route path="/perfil" element={<p>tela do perfil</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  confirmEmailChange.mockReset();
  auth.user = null;
  auth.refreshUser.mockReset();
  auth.refreshUser.mockResolvedValue(undefined);
});

describe('ConfirmEmailChangeView (/confirmar-novo-email)', () => {
  it('abrir a página não confirma nada: é preciso clicar', async () => {
    renderAt(`/confirmar-novo-email?token=${TOKEN}`);
    expect(screen.getByRole('heading', { name: 'Confirmar novo e-mail' })).toBeInTheDocument();
    expect(document.title).toBe('Confirmar novo e-mail · Escambo');
    expect(screen.getByRole('button', { name: 'Confirmar novo e-mail' })).toBeEnabled();
    await new Promise((r) => setTimeout(r, 20));
    expect(confirmEmailChange).not.toHaveBeenCalled();
  });

  it('sem login: confirma com o token e manda entrar com o e-mail novo', async () => {
    const user = userEvent.setup({ delay: null });
    confirmEmailChange.mockResolvedValue({ email: 'nova@escambo.test', session: null });
    renderAt(`/confirmar-novo-email?token=${TOKEN}`);

    await user.click(screen.getByRole('button', { name: 'Confirmar novo e-mail' }));

    const ok = await screen.findByTestId('email-change-ok');
    expect(ok).toHaveTextContent(
      'E-mail trocado para nova@escambo.test. Por segurança, as sessões abertas foram encerradas: entre com o novo e-mail.',
    );
    expect(confirmEmailChange).toHaveBeenCalledWith(TOKEN);
    expect(auth.refreshUser).not.toHaveBeenCalled();
    await user.click(screen.getByRole('link', { name: 'Entrar' }));
    expect(screen.getByText('tela de login')).toBeInTheDocument();
  });

  it('aba logada na mesma conta: renova o acesso antes, segue dentro e recarrega o usuário', async () => {
    const user = userEvent.setup({ delay: null });
    auth.user = { id: 7, email: 'ana@escambo.test' };
    confirmEmailChange.mockResolvedValue({
      email: 'nova@escambo.test',
      session: { accessToken: 'a', refreshToken: 'r' },
    });
    renderAt(`/confirmar-novo-email?token=${TOKEN}`);

    await user.click(screen.getByRole('button', { name: 'Confirmar novo e-mail' }));

    expect(await screen.findByTestId('email-change-ok')).toHaveTextContent(
      'As outras sessões foram encerradas; esta continua.',
    );
    // Uma vez antes (token de acesso em dia) e outra depois (o e-mail novo na tela).
    expect(auth.refreshUser).toHaveBeenCalledTimes(2);
    expect(auth.refreshUser.mock.invocationCallOrder[0]!).toBeLessThan(
      confirmEmailChange.mock.invocationCallOrder[0]!,
    );
    await user.click(screen.getByRole('link', { name: 'Ir para o perfil' }));
    expect(screen.getByText('tela do perfil')).toBeInTheDocument();
  });

  it('enquanto confirma, o botão fica ocupado (sem segundo envio)', async () => {
    const user = userEvent.setup({ delay: null });
    let resolve!: (v: unknown) => void;
    confirmEmailChange.mockReturnValue(new Promise((r) => (resolve = r)));
    renderAt(`/confirmar-novo-email?token=${TOKEN}`);

    await user.click(screen.getByRole('button', { name: 'Confirmar novo e-mail' }));
    expect(screen.getByRole('button', { name: 'Confirmando…' })).toBeDisabled();
    resolve({ email: 'nova@escambo.test', session: null });
    await screen.findByTestId('email-change-ok');
    expect(confirmEmailChange).toHaveBeenCalledTimes(1);
  });

  it('link vencido ou já usado: a mensagem da API, como alerta', async () => {
    const user = userEvent.setup({ delay: null });
    confirmEmailChange.mockRejectedValue(new Error('Link inválido ou vencido'));
    renderAt(`/confirmar-novo-email?token=${TOKEN}`);

    await user.click(screen.getByRole('button', { name: 'Confirmar novo e-mail' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Link inválido ou vencido');
    expect(screen.getByTestId('email-change-error')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveAttribute('href', '/login');
  });

  it('erro sem mensagem: o texto padrão; logado, o caminho volta ao perfil', async () => {
    const user = userEvent.setup({ delay: null });
    auth.user = { id: 7, email: 'ana@escambo.test' };
    confirmEmailChange.mockRejectedValue('falhou');
    renderAt(`/confirmar-novo-email?token=${TOKEN}`);

    await user.click(screen.getByRole('button', { name: 'Confirmar novo e-mail' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Link inválido ou vencido');
    expect(screen.getByRole('link', { name: 'Pedir de novo no perfil' })).toHaveAttribute(
      'href',
      '/perfil',
    );
  });

  it('link sem token: avisa e não chama a API', async () => {
    renderAt('/confirmar-novo-email');
    expect(screen.getByText('Link incompleto. Peça a troca de novo no seu Perfil.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirmar novo e-mail' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveAttribute('href', '/login');
    auth.user = { id: 7, email: 'ana@escambo.test' };
    renderAt('/confirmar-novo-email');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Ir para o perfil' })).toHaveAttribute(
        'href',
        '/perfil',
      ),
    );
    expect(confirmEmailChange).not.toHaveBeenCalled();
  });
});
