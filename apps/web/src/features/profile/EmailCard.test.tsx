import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountContact } from '@escambo/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountAccessProvider } from '../../lib/account-access';
import { dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { EmailCard } from './EmailCard';

/**
 * Troca de e-mail no Perfil (RF-017): o e-mail atual, o pedido com a senha atual, o aviso
 * "confirme no novo endereço" com a opção de desistir, os erros com o foco no campo certo, e a
 * suspensão (pedir fica bloqueado; desistir, não).
 */

const api = vi.hoisted(() => ({
  accountContact: vi.fn(),
  changeEmail: vi.fn(),
  cancelEmailChange: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api }));

const contact = (o: Partial<AccountContact> = {}): AccountContact => ({
  email: 'ana@escambo.test',
  emailVerified: true,
  phone: null,
  pendingEmail: null,
  hasPassword: true,
  googleLinked: false,
  ...o,
});
const PENDING = { email: 'nova@escambo.test', expiresAt: '2026-10-20T15:00:00.000Z' };

function renderCard(status: 'active' | 'suspended' = 'active'): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountAccessProvider status={status}>
        <ToastProvider>
          <EmailCard />
        </ToastProvider>
      </AccountAccessProvider>
    </QueryClientProvider>,
  );
}

const form = async () => within(await screen.findByRole('form', { name: 'Trocar e-mail' }));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.accountContact.mockResolvedValue(contact());
});

describe('EmailCard', () => {
  it('mostra o e-mail atual e o formulário com rótulos, tipo e preenchimento certos', async () => {
    renderCard();
    expect(screen.getByRole('heading', { name: 'E-mail' })).toBeInTheDocument();
    expect(await screen.findByTestId('email-atual')).toHaveTextContent(
      'E-mail de acesso: ana@escambo.test (confirmado)',
    );
    const f = await form();
    expect(f.getByLabelText('Novo e-mail')).toHaveAttribute('type', 'email');
    expect(f.getByLabelText('Novo e-mail')).toHaveAttribute('autocomplete', 'email');
    expect(f.getByLabelText('Senha atual')).toHaveAttribute('type', 'password');
    expect(f.getByLabelText('Senha atual')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.queryByTestId('email-pendente')).toBeNull();
  });

  it('e-mail ainda não confirmado aparece assim', async () => {
    api.accountContact.mockResolvedValue(contact({ emailVerified: false }));
    renderCard();
    expect(await screen.findByTestId('email-atual')).toHaveTextContent('(ainda não confirmado)');
  });

  it('pede a troca com a senha atual, limpa o formulário e mostra "confirme no novo endereço"', async () => {
    const user = userEvent.setup({ delay: null });
    api.changeEmail.mockResolvedValue(PENDING);
    renderCard();
    const f = await form();

    await user.type(f.getByLabelText('Novo e-mail'), '  nova@escambo.test ');
    await user.type(f.getByLabelText('Senha atual'), 'senha-atual-1');
    await user.click(f.getByRole('button', { name: 'Trocar e-mail' }));

    await waitFor(() =>
      expect(api.changeEmail).toHaveBeenCalledWith({
        currentPassword: 'senha-atual-1',
        newEmail: 'nova@escambo.test',
      }),
    );
    const pending = await screen.findByTestId('email-pendente');
    expect(pending).toHaveAttribute('role', 'status');
    expect(pending).toHaveTextContent(
      `Confirme no novo endereço: enviamos um link para nova@escambo.test, válido até ${dtm(PENDING.expiresAt)}. Até lá, você entra com o e-mail atual.`,
    );
    expect(
      await screen.findByText('Pedido enviado. Confirme pelo link que mandamos ao novo endereço.'),
    ).toBeInTheDocument();
    expect(f.getByLabelText('Novo e-mail')).toHaveValue('');
    expect(f.getByLabelText('Senha atual')).toHaveValue('');
  });

  it('o mesmo e-mail de agora é recusado na tela, sem chamar a API', async () => {
    const user = userEvent.setup({ delay: null });
    renderCard();
    const f = await form();
    await user.type(f.getByLabelText('Novo e-mail'), 'ANA@escambo.test');
    await user.type(f.getByLabelText('Senha atual'), 'x');
    await user.click(f.getByRole('button', { name: 'Trocar e-mail' }));

    expect(await f.findByRole('alert')).toHaveTextContent('Este já é o e-mail da sua conta');
    expect(f.getByLabelText('Novo e-mail')).toHaveFocus();
    expect(f.getByLabelText('Novo e-mail')).toHaveAttribute('aria-describedby', 'email-erro');
    expect(api.changeEmail).not.toHaveBeenCalled();
  });

  it('senha errada: a mensagem da API e o foco de volta na senha; outro erro leva ao e-mail', async () => {
    const user = userEvent.setup({ delay: null });
    api.changeEmail.mockRejectedValueOnce(
      Object.assign(new Error('Senha atual incorreta'), { code: 'wrong_password' }),
    );
    renderCard();
    const f = await form();
    await user.type(f.getByLabelText('Novo e-mail'), 'nova@escambo.test');
    await user.type(f.getByLabelText('Senha atual'), 'errada');
    await user.click(f.getByRole('button', { name: 'Trocar e-mail' }));

    expect(await f.findByRole('alert')).toHaveTextContent('Senha atual incorreta');
    expect(f.getByLabelText('Senha atual')).toHaveFocus();
    // O campo errado é o marcado como inválido, com o erro como descrição.
    expect(f.getByLabelText('Senha atual')).toHaveAttribute('aria-invalid', 'true');
    expect(f.getByLabelText('Senha atual')).toHaveAccessibleDescription('Senha atual incorreta');
    expect(f.getByLabelText('Novo e-mail')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByTestId('email-pendente')).toBeNull();

    api.changeEmail.mockRejectedValueOnce(
      Object.assign(new Error('Contas de administração não trocam o e-mail pelo perfil'), {
        code: 'admin_email_locked',
      }),
    );
    await user.click(f.getByRole('button', { name: 'Trocar e-mail' }));
    await waitFor(() =>
      expect(f.getByRole('alert')).toHaveTextContent(
        'Contas de administração não trocam o e-mail pelo perfil',
      ),
    );
    expect(f.getByLabelText('Novo e-mail')).toHaveFocus();
  });

  it('pedido pendente: "Cancelar troca" desiste pela API e o aviso some', async () => {
    const user = userEvent.setup({ delay: null });
    api.accountContact.mockResolvedValue(contact({ pendingEmail: PENDING }));
    api.cancelEmailChange.mockResolvedValue(undefined);
    renderCard();

    const pending = await screen.findByTestId('email-pendente');
    await user.click(within(pending).getByRole('button', { name: 'Cancelar troca' }));

    await waitFor(() => expect(screen.queryByTestId('email-pendente')).toBeNull());
    expect(api.cancelEmailChange).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Troca de e-mail cancelada. O link enviado não vale mais.'),
    ).toBeInTheDocument();
  });

  it('cancelar que falha mantém o aviso e mostra o erro', async () => {
    const user = userEvent.setup({ delay: null });
    api.accountContact.mockResolvedValue(contact({ pendingEmail: PENDING }));
    api.cancelEmailChange.mockRejectedValue(new Error('Sem conexão com o servidor.'));
    renderCard();

    const pending = await screen.findByTestId('email-pendente');
    await user.click(within(pending).getByRole('button', { name: 'Cancelar troca' }));

    expect(await screen.findByText('Sem conexão com o servidor.')).toBeInTheDocument();
    expect(screen.getByTestId('email-pendente')).toBeInTheDocument();
  });

  it('falhas sem mensagem da API: os textos padrão do pedido e do cancelamento', async () => {
    const user = userEvent.setup({ delay: null });
    api.accountContact.mockResolvedValue(contact({ pendingEmail: PENDING }));
    api.changeEmail.mockRejectedValue('falhou');
    api.cancelEmailChange.mockRejectedValue('falhou');
    renderCard();
    const f = await form();
    await user.type(f.getByLabelText('Novo e-mail'), 'nova@escambo.test');
    await user.type(f.getByLabelText('Senha atual'), 'x');
    await user.click(f.getByRole('button', { name: 'Trocar e-mail' }));
    expect(await f.findByRole('alert')).toHaveTextContent('Erro ao pedir a troca de e-mail');

    await user.click(screen.getByRole('button', { name: 'Cancelar troca' }));
    expect(await screen.findByText('Erro ao cancelar a troca')).toBeInTheDocument();
  });

  it('conta suspensa: o pedido fica bloqueado, mas dá para desistir do pendente', async () => {
    api.accountContact.mockResolvedValue(contact({ pendingEmail: PENDING }));
    renderCard('suspended');
    const f = await form();
    expect(f.getByLabelText('Novo e-mail')).toBeDisabled();
    expect(f.getByRole('button', { name: 'Trocar e-mail' })).toBeDisabled();
    expect(
      within(screen.getByTestId('email-pendente')).getByRole('button', { name: 'Cancelar troca' }),
    ).toBeEnabled();
  });

  it('contato que não carrega: o erro fica no cartão, com "Tentar de novo"', async () => {
    const user = userEvent.setup({ delay: null });
    api.accountContact.mockRejectedValueOnce(new Error('Contato indisponível'));
    renderCard();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Contato indisponível');
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByTestId('email-atual')).toBeInTheDocument();
  });
});
