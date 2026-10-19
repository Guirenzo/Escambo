import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountContact } from '@escambo/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountAccessProvider } from '../../lib/account-access';
import { ToastProvider } from '../../lib/toast';
import { formatPhone } from './contact';
import { TelefoneCard } from './TelefoneCard';

/**
 * Telefone no Perfil (RF-017): opcional, só o titular vê, aparece formatado, vai à API como
 * digitado (ela valida e guarda em E.164), o erro volta ao campo e dá para remover.
 */

const api = vi.hoisted(() => ({ accountContact: vi.fn(), updatePhone: vi.fn() }));
vi.mock('../../lib/api', () => ({ api }));

const contact = (phone: string | null): AccountContact => ({
  email: 'ana@escambo.test',
  emailVerified: true,
  phone,
  pendingEmail: null,
});

function renderCard(status: 'active' | 'suspended' = 'active'): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountAccessProvider status={status}>
        <ToastProvider>
          <TelefoneCard />
        </ToastProvider>
      </AccountAccessProvider>
    </QueryClientProvider>,
  );
}

const field = () => screen.findByLabelText('Telefone com DDD');

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe('formatPhone', () => {
  it('E.164 do Brasil vira "(DDD) número"; outro formato aparece como veio', () => {
    expect(formatPhone('+5547999991234')).toBe('(47) 99999-1234');
    expect(formatPhone('+554734331234')).toBe('(47) 3433-1234');
    expect(formatPhone('+14155550100')).toBe('+14155550100');
  });
});

describe('TelefoneCard', () => {
  it('campo com rótulo, tipo tel e a dica de que só o titular vê; sem telefone, nada para remover', async () => {
    api.accountContact.mockResolvedValue(contact(null));
    renderCard();
    const input = await field();
    expect(input).toHaveAttribute('type', 'tel');
    expect(input).toHaveAttribute('autocomplete', 'tel-national');
    expect(input).toHaveValue('');
    expect(input).toHaveAccessibleDescription(
      'Opcional. Só você vê este número: ele não aparece no seu perfil público. Use um número do Brasil com DDD.',
    );
    expect(screen.queryByRole('button', { name: 'Remover telefone' })).toBeNull();
  });

  it('salva o que foi digitado e mostra o número já formatado que a API devolveu', async () => {
    const user = userEvent.setup({ delay: null });
    api.accountContact.mockResolvedValue(contact(null));
    api.updatePhone.mockResolvedValue(contact('+5547999991234'));
    renderCard();
    const input = await field();

    await user.type(input, '47 99999 1234');
    await user.click(screen.getByRole('button', { name: 'Salvar telefone' }));

    await waitFor(() => expect(api.updatePhone).toHaveBeenCalledWith('47 99999 1234'));
    expect(await screen.findByText('Telefone salvo.')).toBeInTheDocument();
    expect(input).toHaveValue('(47) 99999-1234');
  });

  it('número inválido: a mensagem da API no campo, com o foco nele, e o valor digitado fica', async () => {
    const user = userEvent.setup({ delay: null });
    api.accountContact.mockResolvedValue(contact(null));
    api.updatePhone.mockRejectedValue(
      new Error('Telefone inválido: use um número do Brasil com DDD, como (47) 99999-1234'),
    );
    renderCard();
    const input = await field();

    await user.type(input, '123');
    await user.click(screen.getByRole('button', { name: 'Salvar telefone' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Telefone inválido');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveValue('123');
  });

  it('com telefone salvo: aparece formatado, salvar sem mexer não apaga, e "Remover telefone" apaga', async () => {
    const user = userEvent.setup({ delay: null });
    api.accountContact.mockResolvedValue(contact('+5547999991234'));
    api.updatePhone.mockResolvedValueOnce(contact('+5547999991234'));
    api.updatePhone.mockResolvedValueOnce(contact(null));
    renderCard();
    const input = await field();
    expect(input).toHaveValue('(47) 99999-1234');

    await user.click(screen.getByRole('button', { name: 'Salvar telefone' }));
    await waitFor(() => expect(api.updatePhone).toHaveBeenLastCalledWith('(47) 99999-1234'));

    await user.click(screen.getByRole('button', { name: 'Remover telefone' }));
    await waitFor(() => expect(api.updatePhone).toHaveBeenLastCalledWith(null));
    expect(await screen.findByText('Telefone removido.')).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Remover telefone' })).toBeNull();
  });

  it('apagar o campo e salvar remove o telefone', async () => {
    const user = userEvent.setup({ delay: null });
    api.accountContact.mockResolvedValue(contact('+5547999991234'));
    api.updatePhone.mockResolvedValue(contact(null));
    renderCard();
    await user.clear(await field());
    await user.click(screen.getByRole('button', { name: 'Salvar telefone' }));
    await waitFor(() => expect(api.updatePhone).toHaveBeenCalledWith(null));
  });

  it('falha sem mensagem da API: o texto padrão; contato que não carrega: erro e "Tentar de novo"', async () => {
    const user = userEvent.setup({ delay: null });
    api.accountContact.mockRejectedValueOnce(new Error('Contato indisponível'));
    api.accountContact.mockResolvedValue(contact(null));
    api.updatePhone.mockRejectedValue('falhou');
    renderCard();

    const failed = await screen.findByRole('alert');
    expect(failed).toHaveTextContent('Contato indisponível');
    await user.click(within(failed).getByRole('button', { name: 'Tentar de novo' }));
    await user.type(await field(), '47999991234');
    await user.click(screen.getByRole('button', { name: 'Salvar telefone' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Erro ao salvar o telefone');
  });

  it('conta suspensa: o campo e os botões ficam bloqueados', async () => {
    api.accountContact.mockResolvedValue(contact('+5547999991234'));
    renderCard('suspended');
    const formEl = within(await screen.findByRole('form', { name: 'Telefone da conta' }));
    expect(formEl.getByLabelText('Telefone com DDD')).toBeDisabled();
    expect(formEl.getByRole('button', { name: 'Salvar telefone' })).toBeDisabled();
    expect(formEl.getByRole('button', { name: 'Remover telefone' })).toBeDisabled();
  });
});
