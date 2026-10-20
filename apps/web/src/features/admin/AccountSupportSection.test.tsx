import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminAccountLookup } from '@escambo/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dt } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { AccountSupportSection } from './AccountSupportSection';

/**
 * Atendimento: conta (RF-090, ADR 66). O admin acha a conta pelo e-mail e, se ela tem a
 * verificação em duas etapas, pode desativá-la com um motivo de 10 a 500 caracteres; a busca
 * passa a mostrar a conta já sem ela.
 */

const api = vi.hoisted(() => ({ adminAccountLookup: vi.fn(), adminResetMfa: vi.fn() }));
vi.mock('../../lib/api', () => ({ api }));

const accountOf = (o: Partial<AdminAccountLookup> = {}): AdminAccountLookup => ({
  ulid: '01JCARLA',
  email: 'carla@escambo.test',
  role: 'freelancer',
  status: 'suspended',
  mfaEnabled: true,
  createdAt: '2026-03-02T12:00:00.000Z',
  ...o,
});

const notFound = () =>
  Object.assign(new Error('Conta não encontrada.'), { status: 404, code: 'not_found' });

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AccountSupportSection />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function search(user: ReturnType<typeof userEvent.setup>, email: string) {
  const field = screen.getByLabelText('E-mail da conta');
  await user.clear(field);
  await user.type(field, email);
  await user.click(screen.getByRole('button', { name: 'Buscar' }));
}

beforeEach(() => {
  api.adminAccountLookup.mockReset();
  api.adminResetMfa.mockReset();
});

describe('AccountSupportSection: busca', () => {
  it('cartão com título, explicação e a busca por e-mail; nada é buscado antes de pedir', () => {
    renderSection();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Atendimento: conta' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Buscar conta por e-mail' })).toBeInTheDocument();
    const field = screen.getByLabelText('E-mail da conta');
    expect(field).toHaveAttribute('type', 'email');
    expect(field).toBeRequired();
    expect(screen.getByTestId('lookup-result')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('lookup-result')).toHaveTextContent('');
    expect(api.adminAccountLookup).not.toHaveBeenCalled();
  });

  it('conta achada: e-mail, tipo, situação, criação e a 2FA, com o botão de desativar', async () => {
    const user = userEvent.setup();
    api.adminAccountLookup.mockResolvedValue(accountOf());
    renderSection();

    await search(user, '  carla@escambo.test ');

    expect(await screen.findByTestId('lookup-account')).toBeInTheDocument();
    expect(api.adminAccountLookup).toHaveBeenCalledWith('carla@escambo.test');
    expect(screen.getByTestId('lookup-result')).toHaveTextContent('Conta encontrada.');
    const details = screen.getByTestId('lookup-account');
    expect(within(details).getByText('E-mail').nextElementSibling).toHaveTextContent(
      'carla@escambo.test',
    );
    expect(within(details).getByText('Tipo de conta').nextElementSibling).toHaveTextContent(
      'Freelancer',
    );
    expect(within(details).getByText('Situação').nextElementSibling).toHaveTextContent('Suspensa');
    expect(within(details).getByText('Criada em').nextElementSibling).toHaveTextContent(
      dt('2026-03-02T12:00:00.000Z'),
    );
    expect(screen.getByTestId('lookup-mfa')).toHaveTextContent('Ativa');
    expect(
      screen.getByRole('button', { name: 'Desativar verificação em duas etapas' }),
    ).toBeInTheDocument();
  });

  it('conta sem 2FA: diz que está desativada e não oferece o botão', async () => {
    const user = userEvent.setup();
    api.adminAccountLookup.mockResolvedValue(
      accountOf({ mfaEnabled: false, role: 'admin', status: 'active' }),
    );
    renderSection();

    await search(user, 'carla@escambo.test');

    expect(await screen.findByTestId('lookup-mfa')).toHaveTextContent('Desativada');
    expect(screen.getByTestId('lookup-account')).toHaveTextContent('Administração');
    expect(screen.getByTestId('lookup-account')).toHaveTextContent('Ativa');
    expect(
      screen.queryByRole('button', { name: 'Desativar verificação em duas etapas' }),
    ).not.toBeInTheDocument();
  });

  it('nenhuma conta com o e-mail: a região viva diz isso, sem erro', async () => {
    const user = userEvent.setup();
    api.adminAccountLookup.mockRejectedValue(notFound());
    renderSection();

    await search(user, 'ninguem@escambo.test');

    await waitFor(() =>
      expect(screen.getByTestId('lookup-result')).toHaveTextContent(
        'Nenhuma conta com o e-mail ninguem@escambo.test.',
      ),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lookup-account')).not.toBeInTheDocument();
  });

  it('falha na busca: o erro com "Tentar de novo"', async () => {
    const user = userEvent.setup();
    api.adminAccountLookup
      .mockRejectedValueOnce(new Error('Serviço indisponível no momento.'))
      .mockResolvedValueOnce(accountOf());
    renderSection();

    await search(user, 'carla@escambo.test');

    expect(await screen.findByRole('alert')).toHaveTextContent('Serviço indisponível no momento.');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByTestId('lookup-account')).toBeInTheDocument();
  });

  it('buscar o mesmo e-mail de novo consulta outra vez (a conta pode ter mudado)', async () => {
    const user = userEvent.setup();
    api.adminAccountLookup.mockResolvedValue(accountOf());
    renderSection();

    await search(user, 'carla@escambo.test');
    await screen.findByTestId('lookup-account');
    await search(user, 'carla@escambo.test');

    await waitFor(() => expect(api.adminAccountLookup).toHaveBeenCalledTimes(2));
  });

  it('enquanto busca, o botão fica desabilitado e a região diz "Buscando…"', async () => {
    const user = userEvent.setup();
    api.adminAccountLookup.mockReturnValue(new Promise(() => undefined));
    renderSection();

    await search(user, 'carla@escambo.test');

    expect(screen.getByTestId('lookup-result')).toHaveTextContent('Buscando…');
    expect(screen.getByRole('button', { name: 'Buscar' })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
  });
});

describe('AccountSupportSection: desativar a 2FA de uma conta', () => {
  async function openReset(user: ReturnType<typeof userEvent.setup>) {
    api.adminAccountLookup.mockResolvedValue(accountOf());
    renderSection();
    await search(user, 'carla@escambo.test');
    await user.click(
      await screen.findByRole('button', { name: 'Desativar verificação em duas etapas' }),
    );
    return screen.getByRole('dialog', { name: 'Desativar a verificação em duas etapas' });
  }

  it('o diálogo diz o que acontece e pede o motivo, com a regra de tamanho', async () => {
    const user = userEvent.setup();
    const dialog = await openReset(user);

    expect(dialog).toHaveTextContent('carla@escambo.test');
    expect(dialog).toHaveTextContent('as sessões abertas da conta caem');
    const reason = within(dialog).getByLabelText('Motivo (fica no registro do atendimento)');
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute('maxlength', '500');
    expect(reason).toHaveAccessibleDescription(
      'De 10 a 500 caracteres. Ex.: perdeu o celular; titularidade confirmada no chamado de suporte.',
    );
  });

  it('motivo curto demais nem vai à API: erro ligado ao campo, com o foco', async () => {
    const user = userEvent.setup();
    const dialog = await openReset(user);
    const reason = within(dialog).getByLabelText('Motivo (fica no registro do atendimento)');

    await user.type(reason, '  curto   ');
    await user.click(within(dialog).getByRole('button', { name: 'Desativar' }));

    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('Escreva o motivo com pelo menos 10 caracteres.');
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(reason.getAttribute('aria-describedby')).toContain(alert.id);
    expect(reason).toHaveFocus();
    expect(api.adminResetMfa).not.toHaveBeenCalled();
  });

  it('com o motivo, desativa, avisa e a busca mostra a conta já sem a 2FA', async () => {
    const user = userEvent.setup();
    const dialog = await openReset(user);
    api.adminResetMfa.mockResolvedValue(undefined);
    api.adminAccountLookup.mockResolvedValue(accountOf({ mfaEnabled: false }));

    await user.type(
      within(dialog).getByLabelText('Motivo (fica no registro do atendimento)'),
      '  Perdeu o celular; titularidade confirmada no chamado 42.  ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Desativar' }));

    expect(
      await screen.findByText(
        'Verificação em duas etapas desativada. As sessões da conta caíram e o titular foi avisado por e-mail.',
      ),
    ).toBeInTheDocument();
    expect(api.adminResetMfa).toHaveBeenCalledWith(
      '01JCARLA',
      'Perdeu o celular; titularidade confirmada no chamado 42.',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('lookup-mfa')).toHaveTextContent('Desativada'));
  });

  it('recusa da API (a própria conta, por exemplo): a mensagem fica no diálogo, sem marcar o motivo', async () => {
    const user = userEvent.setup();
    const dialog = await openReset(user);
    api.adminResetMfa.mockRejectedValue(
      Object.assign(new Error('Use o seu Perfil para mexer na sua própria verificação.'), {
        code: 'cannot_reset_self',
      }),
    );
    const reason = within(dialog).getByLabelText('Motivo (fica no registro do atendimento)');

    await user.type(reason, 'Teste com a minha própria conta.');
    await user.click(within(dialog).getByRole('button', { name: 'Desativar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Use o seu Perfil para mexer na sua própria verificação.',
    );
    expect(reason).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('falha técnica sem mensagem útil vira o texto de reserva', async () => {
    const user = userEvent.setup();
    const dialog = await openReset(user);
    api.adminResetMfa.mockRejectedValue(new TypeError('Failed to fetch'));

    await user.type(
      within(dialog).getByLabelText('Motivo (fica no registro do atendimento)'),
      'Perdeu o celular e os códigos.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Desativar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Não foi possível desativar. Tente de novo.',
    );
  });

  it('enquanto desativa, o botão mostra "Desativando…" desabilitado', async () => {
    const user = userEvent.setup();
    const dialog = await openReset(user);
    api.adminResetMfa.mockReturnValue(new Promise(() => undefined));

    await user.type(
      within(dialog).getByLabelText('Motivo (fica no registro do atendimento)'),
      'Perdeu o celular e os códigos.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Desativar' }));

    expect(await within(dialog).findByRole('button', { name: /Desativando…/ })).toBeDisabled();
  });

  it('fechar o diálogo não desativa nada', async () => {
    const user = userEvent.setup();
    const dialog = await openReset(user);

    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.adminResetMfa).not.toHaveBeenCalled();
  });
});
