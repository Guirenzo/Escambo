import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccountAccessProvider } from '../lib/account-access';
import { BusinessButton, BusinessForm, BusinessIconButton, BusinessModal } from './BusinessActions';

describe('controles durante suspensão', () => {
  it('desativa comandos e formulário já aberto; mantém consulta e volta ao reativar', async () => {
    const action = vi.fn();
    const submit = vi.fn((event) => event.preventDefault());
    const tree = (status: 'active' | 'suspended') => (
      <AccountAccessProvider status={status}>
        <a href="/perfil">Ver perfil</a>
        <button onClick={action}>Consultar</button>
        <BusinessButton onClick={action}>Contratar</BusinessButton>
        <BusinessIconButton onClick={action}>Favoritar</BusinessIconButton>
        <BusinessForm aria-label="Editar perfil" onSubmit={submit}>
          <input aria-label="Nome" defaultValue="Ana" />
          <button type="submit">Salvar</button>
        </BusinessForm>
      </AccountAccessProvider>
    );
    const view = render(tree('active'));
    expect(screen.getByRole('button', { name: 'Contratar' })).toBeEnabled();
    view.rerender(tree('suspended'));
    expect(screen.getByRole('button', { name: 'Contratar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Favoritar' })).toBeDisabled();
    expect(screen.getByLabelText('Nome')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: 'Editar perfil' }));
    expect(submit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Consultar' }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Ver perfil' })).toHaveAttribute('href', '/perfil');
    view.rerender(tree('active'));
    expect(screen.getByLabelText('Nome')).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('remove o modal de negócio se a suspensão chegar com ele aberto', () => {
    const tree = (status: 'active' | 'suspended') => (
      <AccountAccessProvider status={status}>
        <BusinessModal title="Confirmar contratação" onClose={vi.fn()}>
          <button>Confirmar</button>
        </BusinessModal>
      </AccountAccessProvider>
    );
    const view = render(tree('active'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.rerender(tree('suspended'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
