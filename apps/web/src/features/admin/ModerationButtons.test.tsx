import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { ModerationButtons } from './ModerationButtons';

const adminModerateUser = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { adminModerateUser: (ulid: string, action: string) => adminModerateUser(ulid, action) },
}));

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{ui}</ToastProvider>
  </QueryClientProvider>
);

const ULID = '01HZX3J8K2M4N6P8Q0R2S4T6V8';
const confirm = vi.fn<(message?: string) => boolean>();

beforeEach(() => {
  adminModerateUser.mockReset();
  adminModerateUser.mockResolvedValue(undefined);
  confirm.mockReset();
  confirm.mockReturnValue(true);
  vi.stubGlobal('confirm', confirm);
});
afterEach(() => vi.unstubAllGlobals());

/** Moderação de usuário no perfil (admin): toda ação passa por uma confirmação. */
describe('ModerationButtons', () => {
  it.each([
    ['Suspender', 'suspend', 'Usuário suspenso.'],
    ['Banir', 'ban', 'Usuário banido.'],
    ['Reativar', 'reactivate', 'Usuário reativado.'],
  ])(
    '%s pergunta antes, manda a ação com o ulid do perfil e avisa o resultado',
    async (label, action, done) => {
      const user = userEvent.setup();
      render(wrap(<ModerationButtons ulid={ULID} />));

      await user.click(screen.getByRole('button', { name: label }));

      expect(confirm).toHaveBeenCalledWith(`${label} este usuário?`);
      expect(adminModerateUser).toHaveBeenCalledTimes(1);
      expect(adminModerateUser).toHaveBeenCalledWith(ULID, action);
      expect(await screen.findByText(done)).toBeInTheDocument();
    },
  );

  it('recusar a confirmação não chama a API nem avisa nada', async () => {
    confirm.mockReturnValue(false);
    const user = userEvent.setup();
    render(wrap(<ModerationButtons ulid={ULID} />));

    await user.click(screen.getByRole('button', { name: 'Banir' }));

    expect(confirm).toHaveBeenCalledWith('Banir este usuário?');
    expect(adminModerateUser).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('a recusa da API vira aviso com a mensagem dela', async () => {
    adminModerateUser.mockRejectedValue(new Error('Não é possível banir um administrador.'));
    const user = userEvent.setup();
    render(wrap(<ModerationButtons ulid={ULID} />));

    await user.click(screen.getByRole('button', { name: 'Banir' }));

    expect(await screen.findByText('Não é possível banir um administrador.')).toBeInTheDocument();
    expect(screen.queryByText('Usuário banido.')).not.toBeInTheDocument();
    expect(adminModerateUser).toHaveBeenCalledWith(ULID, 'ban');
    // Os botões voltam, para o admin escolher outra ação.
    for (const name of ['Suspender', 'Banir', 'Reativar']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
  });

  it('falha sem mensagem cai no aviso genérico', async () => {
    adminModerateUser.mockRejectedValue('boom');
    const user = userEvent.setup();
    render(wrap(<ModerationButtons ulid={ULID} />));

    await user.click(screen.getByRole('button', { name: 'Suspender' }));

    expect(await screen.findByText('Erro na moderação')).toBeInTheDocument();
  });

  it('enquanto a ação não volta, os três botões ficam desabilitados', async () => {
    let release!: () => void;
    adminModerateUser.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const user = userEvent.setup();
    render(wrap(<ModerationButtons ulid={ULID} />));
    const buttons = ['Suspender', 'Banir', 'Reativar'].map((name) =>
      screen.getByRole('button', { name }),
    );
    for (const b of buttons) expect(b).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Suspender' }));
    await waitFor(() => {
      for (const b of buttons) expect(b).toBeDisabled();
    });

    release();
    expect(await screen.findByText('Usuário suspenso.')).toBeInTheDocument();
    for (const b of buttons) expect(b).toBeEnabled();
  });
});
