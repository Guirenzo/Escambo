import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublicUser } from '@escambo/types';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { TimezoneBanner } from './TimezoneBanner';

/**
 * Sugestão única de fuso (ADR 51): o aparelho está em outro fuso do Brasil e a conta nunca
 * escolheu. As duas respostas gravam a escolha na conta (é isso que faz a pergunta não voltar).
 */

const updateEmailPreference = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { updateEmailPreference: (body: unknown) => updateEmailPreference(body) },
}));

const refreshUser = vi.fn();
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ refreshUser }) }));

const wrap = (ui: ReactNode) => <ToastProvider>{ui}</ToastProvider>;

const account = (o: Partial<PublicUser> = {}): PublicUser => ({
  id: 1,
  ulid: '01J0000000000000000000USER',
  email: 'ana@escambo.test',
  role: 'client',
  emailVerified: true,
  emailFrequency: 'instant',
  digestHour: 8,
  timezone: 'America/Sao_Paulo',
  timezoneChosen: false,
  quietHours: null,
  quietPass: null,
  ...o,
});

beforeEach(() => {
  updateEmailPreference.mockReset();
  updateEmailPreference.mockResolvedValue({});
  refreshUser.mockReset();
  refreshUser.mockResolvedValue(undefined);
});

describe('TimezoneBanner', () => {
  it('cliente: diz o fuso do aparelho e o da conta, e que vale para o resumo e os avisos', () => {
    render(wrap(<TimezoneBanner user={account()} detected="America/Manaus" />));
    const region = screen.getByRole('region', { name: 'Sugestão de fuso horário' });
    expect(region).toHaveTextContent(
      'Seu aparelho está no horário de Manaus, e sua conta no de Brasília. Usar o horário de Manaus no resumo por e-mail e nos avisos?',
    );
    expect(region).not.toHaveTextContent('agenda de atendimento');
    expect(screen.getByRole('button', { name: 'Usar horário de Manaus' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Manter Brasília' })).toBeEnabled();
  });

  it('freelancer: a pergunta inclui a agenda de atendimento', () => {
    render(
      wrap(
        <TimezoneBanner
          user={account({ role: 'freelancer', timezone: 'America/Cuiaba' })}
          detected="America/Rio_Branco"
        />,
      ),
    );
    expect(screen.getByRole('region', { name: 'Sugestão de fuso horário' })).toHaveTextContent(
      'Seu aparelho está no horário de Rio Branco, e sua conta no de Cuiabá e Campo Grande. Usar o horário de Rio Branco no resumo por e-mail, nos avisos e na sua agenda de atendimento?',
    );
    expect(screen.getByRole('button', { name: 'Manter Cuiabá e Campo Grande' })).toBeEnabled();
  });

  it('"Usar horário de…" grava o fuso do aparelho, recarrega a sessão e confirma', async () => {
    const user = userEvent.setup();
    render(wrap(<TimezoneBanner user={account()} detected="America/Manaus" />));
    await user.click(screen.getByRole('button', { name: 'Usar horário de Manaus' }));

    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ timezone: 'America/Manaus' });
    expect(
      await screen.findByText('Pronto: sua conta agora usa o horário de Manaus.'),
    ).toBeInTheDocument();
    expect(refreshUser).toHaveBeenCalledTimes(1);
    expect(refreshUser).toHaveBeenCalledWith();
    expect(screen.queryByText(/sua conta continua no horário/)).not.toBeInTheDocument();
  });

  it('"Manter…" também grava (o fuso atual), para a pergunta não voltar em nenhum aparelho', async () => {
    const user = userEvent.setup();
    render(wrap(<TimezoneBanner user={account()} detected="America/Manaus" />));
    await user.click(screen.getByRole('button', { name: 'Manter Brasília' }));

    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ timezone: 'America/Sao_Paulo' });
    expect(
      await screen.findByText('Pronto: sua conta continua no horário de Brasília.'),
    ).toBeInTheDocument();
    expect(refreshUser).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/sua conta agora usa o horário/)).not.toBeInTheDocument();
  });

  it('"Manter…" numa conta fora de Brasília grava e confirma o fuso da conta, não o padrão', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <TimezoneBanner
          user={account({ timezone: 'America/Cuiaba' })}
          detected="America/Rio_Branco"
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Manter Cuiabá e Campo Grande' }));

    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ timezone: 'America/Cuiaba' });
    expect(
      await screen.findByText('Pronto: sua conta continua no horário de Cuiabá e Campo Grande.'),
    ).toBeInTheDocument();
  });

  it('a confirmação só aparece depois de a sessão recarregar (a faixa some junto, sem aviso antes da hora)', async () => {
    const user = userEvent.setup();
    let reloaded!: () => void;
    refreshUser.mockImplementation(() => new Promise<void>((r) => (reloaded = r)));
    render(wrap(<TimezoneBanner user={account()} detected="America/Manaus" />));
    await user.click(screen.getByRole('button', { name: 'Usar horário de Manaus' }));

    await waitFor(() => expect(refreshUser).toHaveBeenCalledTimes(1));
    expect(refreshUser).toHaveBeenCalledWith();
    expect(screen.queryByText(/^Pronto: sua conta/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Usar horário de Manaus' })).toBeDisabled();

    reloaded();
    expect(
      await screen.findByText('Pronto: sua conta agora usa o horário de Manaus.'),
    ).toBeInTheDocument();
  });

  it('enquanto grava, as duas respostas ficam desabilitadas e a sessão só recarrega depois da API', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    updateEmailPreference.mockImplementation(() => new Promise<void>((r) => (release = r)));
    render(wrap(<TimezoneBanner user={account()} detected="America/Manaus" />));
    const use = screen.getByRole('button', { name: 'Usar horário de Manaus' });
    const keep = screen.getByRole('button', { name: 'Manter Brasília' });
    await user.click(use);

    expect(use).toBeDisabled();
    expect(keep).toBeDisabled();
    await user.click(keep);
    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(refreshUser).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(refreshUser).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText('Pronto: sua conta agora usa o horário de Manaus.'),
    ).toBeInTheDocument();
    // Gravado: a faixa não aceita outra resposta (ela some quando a sessão recarregada chega).
    expect(use).toBeDisabled();
    expect(keep).toBeDisabled();
  });

  it('API recusa: mostra a mensagem dela, não recarrega a sessão e libera para tentar de novo', async () => {
    const user = userEvent.setup();
    updateEmailPreference.mockRejectedValueOnce(new Error('Fuso fora da lista do Brasil'));
    render(wrap(<TimezoneBanner user={account()} detected="America/Manaus" />));
    const use = screen.getByRole('button', { name: 'Usar horário de Manaus' });
    await user.click(use);

    expect(await screen.findByText('Fuso fora da lista do Brasil')).toBeInTheDocument();
    expect(refreshUser).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Pronto: sua conta/)).not.toBeInTheDocument();
    await waitFor(() => expect(use).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Manter Brasília' })).toBeEnabled();

    await user.click(use);
    expect(updateEmailPreference).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByText('Pronto: sua conta agora usa o horário de Manaus.'),
    ).toBeInTheDocument();
  });

  it('falha sem mensagem (não é um Error) cai no texto padrão', async () => {
    const user = userEvent.setup();
    updateEmailPreference.mockRejectedValue('offline');
    render(wrap(<TimezoneBanner user={account()} detected="America/Manaus" />));
    await user.click(screen.getByRole('button', { name: 'Manter Brasília' }));
    expect(await screen.findByText('Não foi possível salvar o fuso')).toBeInTheDocument();
  });
});
