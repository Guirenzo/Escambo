import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountAccessProvider } from '../../lib/account-access';
import { ToastProvider } from '../../lib/toast';
import { SenhaCard } from './SenhaCard';

/**
 * Troca de senha no Perfil (RF-017): os três campos com rótulo, a conferência da confirmação antes
 * de chamar a API, o erro da senha atual com o foco de volta no campo, e o sucesso que limpa o
 * formulário. Vale também com a conta suspensa (segurança da conta).
 */

const changePassword = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { changePassword: (body: unknown) => changePassword(body) },
}));

function renderCard(status: 'active' | 'suspended' = 'active'): void {
  render(
    <AccountAccessProvider status={status}>
      <ToastProvider>
        <SenhaCard />
      </ToastProvider>
    </AccountAccessProvider>,
  );
}

const fields = () => ({
  current: screen.getByLabelText('Senha atual'),
  next: screen.getByLabelText('Nova senha'),
  confirm: screen.getByLabelText('Confirmar nova senha'),
});

// Em bloco: devolver o mock faria o vitest chamá-lo como limpeza ao fim de cada teste.
beforeEach(() => {
  changePassword.mockReset();
});

describe('SenhaCard', () => {
  it('tem os três campos de senha com rótulo, os preenchimentos certos e a regra de 8 caracteres', () => {
    renderCard();
    expect(screen.getByRole('heading', { name: 'Senha' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Trocar senha' })).toBeInTheDocument();
    const { current, next, confirm } = fields();
    for (const f of [current, next, confirm]) expect(f).toHaveAttribute('type', 'password');
    expect(current).toHaveAttribute('autocomplete', 'current-password');
    expect(next).toHaveAttribute('autocomplete', 'new-password');
    expect(next).toHaveAttribute('minlength', '8');
    expect(confirm).toHaveAttribute('minlength', '8');
    expect(
      screen.getByText(
        'Ao trocar, as outras sessões abertas são encerradas e esta continua. Você recebe um aviso por e-mail.',
      ),
    ).toBeInTheDocument();
  });

  it('troca a senha com a atual e a nova, avisa e limpa o formulário', async () => {
    const user = userEvent.setup({ delay: null });
    changePassword.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    renderCard();
    const { current, next, confirm } = fields();

    await user.type(current, 'senha-antiga-1');
    await user.type(next, 'senha-nova-123');
    await user.type(confirm, 'senha-nova-123');
    await user.click(screen.getByRole('button', { name: 'Trocar senha' }));

    await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: 'senha-antiga-1',
      newPassword: 'senha-nova-123',
    });
    expect(
      await screen.findByText('Senha alterada. As outras sessões foram encerradas.'),
    ).toBeInTheDocument();
    expect(current).toHaveValue('');
    expect(next).toHaveValue('');
    expect(confirm).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('confirmação diferente: não chama a API, mostra o erro e põe o foco na confirmação', async () => {
    const user = userEvent.setup({ delay: null });
    renderCard();
    const { current, next, confirm } = fields();

    await user.type(current, 'senha-antiga-1');
    await user.type(next, 'senha-nova-123');
    await user.type(confirm, 'senha-nova-999');
    await user.click(screen.getByRole('button', { name: 'Trocar senha' }));

    expect(screen.getByRole('alert')).toHaveTextContent('As senhas não conferem');
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAttribute('aria-describedby', 'senha-erro');
    // Só o campo a corrigir fica marcado como inválido, com o erro como descrição.
    expect(confirm).toHaveAttribute('aria-invalid', 'true');
    expect(confirm).toHaveAccessibleDescription('As senhas não conferem');
    expect(current).toHaveAttribute('aria-invalid', 'false');
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('nova igual à atual: não chama a API e põe o foco na nova senha', async () => {
    const user = userEvent.setup({ delay: null });
    renderCard();
    const { current, next, confirm } = fields();

    await user.type(current, 'mesma-senha-1');
    await user.type(next, 'mesma-senha-1');
    await user.type(confirm, 'mesma-senha-1');
    await user.click(screen.getByRole('button', { name: 'Trocar senha' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'A nova senha precisa ser diferente da atual',
    );
    expect(next).toHaveFocus();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('senha atual errada: mostra a mensagem da API, mantém o que foi digitado e volta o foco para a atual', async () => {
    const user = userEvent.setup({ delay: null });
    changePassword.mockRejectedValue(
      Object.assign(new Error('Senha atual incorreta'), { code: 'wrong_password' }),
    );
    renderCard();
    const { current, next } = fields();

    await user.type(current, 'errada-123');
    await user.type(next, 'senha-nova-123');
    await user.type(fields().confirm, 'senha-nova-123');
    await user.click(screen.getByRole('button', { name: 'Trocar senha' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Senha atual incorreta');
    expect(current).toHaveFocus();
    expect(current).toHaveValue('errada-123');
    expect(next).toHaveValue('senha-nova-123');
    expect(screen.getByRole('button', { name: 'Trocar senha' })).toBeEnabled();
  });

  it('outro erro da API: mostra a mensagem sem mudar o foco; erro sem mensagem cai no texto padrão', async () => {
    const user = userEvent.setup({ delay: null });
    changePassword.mockRejectedValueOnce(
      new Error('Muitas tentativas. Tente novamente em alguns minutos.'),
    );
    changePassword.mockRejectedValueOnce('falhou');
    renderCard();
    const { current, next, confirm } = fields();
    await user.type(current, 'senha-antiga-1');
    await user.type(next, 'senha-nova-123');
    await user.type(confirm, 'senha-nova-123');

    await user.click(screen.getByRole('button', { name: 'Trocar senha' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Muitas tentativas. Tente novamente em alguns minutos.',
    );
    expect(current).not.toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Trocar senha' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Erro ao trocar a senha'),
    );
  });

  it('enquanto salva, o botão fica desligado e diz "Salvando…"', async () => {
    const user = userEvent.setup({ delay: null });
    let finish!: () => void;
    changePassword.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderCard();
    const { current, next, confirm } = fields();
    await user.type(current, 'senha-antiga-1');
    await user.type(next, 'senha-nova-123');
    await user.type(confirm, 'senha-nova-123');
    await user.click(screen.getByRole('button', { name: 'Trocar senha' }));

    expect(await screen.findByRole('button', { name: 'Salvando…' })).toBeDisabled();
    finish();
    expect(await screen.findByRole('button', { name: 'Trocar senha' })).toBeEnabled();
  });

  it('conta suspensa ainda troca a senha: o formulário não é bloqueado', async () => {
    const user = userEvent.setup({ delay: null });
    changePassword.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    renderCard('suspended');
    const { current, next, confirm } = fields();
    expect(current).toBeEnabled();

    await user.type(current, 'senha-antiga-1');
    await user.type(next, 'senha-nova-123');
    await user.type(confirm, 'senha-nova-123');
    await user.click(screen.getByRole('button', { name: 'Trocar senha' }));

    await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
  });
});

describe('SenhaCard: conta sem senha (RF-002)', () => {
  it('conta do Google sem senha: em vez do formulário, o caminho para criar uma', () => {
    render(
      <MemoryRouter>
        <SenhaCard hasPassword={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Senha' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Trocar senha' })).toBeNull();
    expect(screen.queryByLabelText('Senha atual')).toBeNull();
    expect(screen.getByTestId('sem-senha')).toHaveTextContent('Sua conta ainda não tem senha');
    expect(screen.getByRole('link', { name: 'Criar uma senha' })).toHaveAttribute(
      'href',
      '/esqueci-senha',
    );
  });
});
