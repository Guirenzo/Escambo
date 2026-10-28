import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublicUser } from '@escambo/types';
import { useEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountAccessProvider } from '../lib/account-access';
import { ToastProvider } from '../lib/toast';
import {
  useEmailVerified,
  useVerifiedEmailGate,
  VerifyEmailModal,
  VerifyEmailNotice,
} from './VerifyEmail';

/**
 * Ação crítica sem e-mail confirmado (RF-006): o aviso no lugar da ação, com o reenvio do link. A
 * regra é da API; aqui só a sessão e o reenvio são de mentira.
 */

const resendVerification = vi.fn();
vi.mock('../lib/api', () => ({
  api: { resendVerification: () => resendVerification() },
}));

const auth = { user: null as PublicUser | null, missing: false };
vi.mock('../lib/auth', () => ({
  useAuth: () => {
    if (auth.missing) throw new Error('useAuth deve ser usado dentro de <AuthProvider>');
    return { user: auth.user };
  },
}));

const account = (o: Partial<PublicUser> = {}): PublicUser =>
  ({
    id: 3,
    ulid: '01J0000000000000000000USER',
    email: 'bia@escambo.test',
    role: 'client',
    status: 'active',
    emailVerified: false,
    ...o,
  }) as PublicUser;

const wrap = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>;

beforeEach(() => {
  auth.user = account();
  auth.missing = false;
  resendVerification.mockReset();
});

describe('useEmailVerified', () => {
  it('segue a conta da sessão', () => {
    expect(renderHook(() => useEmailVerified()).result.current).toBe(false);
    auth.user = account({ emailVerified: true });
    expect(renderHook(() => useEmailVerified()).result.current).toBe(true);
  });

  it('sem sessão, ou fora do AuthProvider, não trava a tela (quem decide é a API)', () => {
    auth.user = null;
    expect(renderHook(() => useEmailVerified()).result.current).toBe(true);
    auth.missing = true;
    expect(renderHook(() => useEmailVerified()).result.current).toBe(true);
  });
});

describe('VerifyEmailNotice', () => {
  it('diz o que está bloqueado e para qual endereço foi o link', () => {
    render(<VerifyEmailNotice action="contratar" />, { wrapper: wrap });
    expect(screen.getByTestId('verify-email-notice')).toHaveTextContent(
      'Confirme seu e-mail para contratar. Enviamos um link para bia@escambo.test: abra a mensagem e toque no link. Depois disso, é só voltar aqui.',
    );
    expect(screen.getByTestId('verify-email-notice')).toHaveAttribute('role', 'status');
  });

  it('"Reenviar e-mail" pede o link uma vez, mostra "Reenviando…" e confirma com o endereço', async () => {
    const user = userEvent.setup();
    let release!: (v: { sent: boolean }) => void;
    resendVerification.mockReturnValue(new Promise((resolve) => (release = resolve)));
    render(<VerifyEmailNotice action="depositar" />, { wrapper: wrap });
    await user.click(screen.getByRole('button', { name: 'Reenviar e-mail' }));
    expect(screen.getByRole('button', { name: /Reenviando…/ })).toBeDisabled();
    await act(async () => release({ sent: true }));
    expect(resendVerification).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Link reenviado para bia@escambo.test.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reenviar e-mail' })).toBeEnabled();
  });

  it('falha no reenvio vira o erro da API, e o botão volta', async () => {
    const user = userEvent.setup();
    resendVerification.mockRejectedValue(new Error('Aguarde um minuto para pedir de novo'));
    render(<VerifyEmailNotice action="sacar" />, { wrapper: wrap });
    await user.click(screen.getByRole('button', { name: 'Reenviar e-mail' }));
    expect(await screen.findByText('Aguarde um minuto para pedir de novo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reenviar e-mail' })).toBeEnabled();
  });

  it('erro técnico do navegador não aparece em inglês', async () => {
    const user = userEvent.setup();
    resendVerification.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<VerifyEmailNotice action="sacar" />, { wrapper: wrap });
    await user.click(screen.getByRole('button', { name: 'Reenviar e-mail' }));
    expect(await screen.findByText('Não foi possível reenviar')).toBeInTheDocument();
  });
});

describe('VerifyEmailModal', () => {
  it('é um diálogo com o título da ação e o aviso; fecha no X', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<VerifyEmailModal title="Contratar: Logo" action="contratar" onClose={onClose} />, {
      wrapper: wrap,
    });
    const dialog = screen.getByRole('dialog', { name: 'Contratar: Logo' });
    expect(dialog).toHaveTextContent('Confirme seu e-mail para contratar.');
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a suspensão fecha o aviso como os outros diálogos de negócio', () => {
    const onClose = vi.fn();
    render(
      <ToastProvider>
        <AccountAccessProvider status="suspended">
          <VerifyEmailModal title="Contratar" action="contratar" onClose={onClose} />
        </AccountAccessProvider>
      </ToastProvider>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
  });
});

/** Um botão que age direto, como "Aceitar" na troca, passando pelo portão. */
function Accept({ run, onReady }: { run: () => Promise<void>; onReady?: () => void }) {
  const gate = useVerifiedEmailGate();
  useEffect(() => onReady?.(), [onReady]);
  return (
    <>
      <button type="button" onClick={() => gate.guard('aceitar a troca', run)}>
        Aceitar
      </button>
      {gate.dialog}
    </>
  );
}

describe('useVerifiedEmailGate', () => {
  it('sem e-mail confirmado, o clique abre o aviso e a ação não roda', async () => {
    const user = userEvent.setup();
    const run = vi.fn().mockResolvedValue(undefined);
    render(<Accept run={run} />, { wrapper: wrap });
    await user.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(run).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Confirme seu e-mail' });
    expect(dialog).toHaveTextContent('Confirme seu e-mail para aceitar a troca.');
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('com e-mail confirmado, a ação roda e nada aparece', async () => {
    const user = userEvent.setup();
    auth.user = account({ emailVerified: true });
    const run = vi.fn().mockResolvedValue(undefined);
    render(<Accept run={run} />, { wrapper: wrap });
    await user.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a API recusa durante a ação (sessão antiga): a conta vira não confirmada e o aviso abre', async () => {
    const user = userEvent.setup();
    auth.user = account({ emailVerified: true });
    let fail!: (e: Error) => void;
    const run = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const view = render(<Accept run={run} />, { wrapper: wrap });
    await user.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(run).toHaveBeenCalledTimes(1);
    // O AuthProvider ouve o 403 email_not_verified e marca a conta antes de a ação terminar.
    auth.user = account({ emailVerified: false });
    view.rerender(<Accept run={run} />);
    await act(async () => fail(new Error('Confirme seu e-mail para continuar')));
    expect(screen.getByRole('dialog', { name: 'Confirme seu e-mail' })).toHaveTextContent(
      'Confirme seu e-mail para aceitar a troca.',
    );
  });

  it('a ação que já terminou não abre aviso depois, se a conta mudar', async () => {
    const user = userEvent.setup();
    auth.user = account({ emailVerified: true });
    const run = vi.fn().mockResolvedValue(undefined);
    const view = render(<Accept run={run} />, { wrapper: wrap });
    await user.click(screen.getByRole('button', { name: 'Aceitar' }));
    await act(async () => undefined);
    auth.user = account({ emailVerified: false });
    view.rerender(<Accept run={run} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
