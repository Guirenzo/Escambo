import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailPreferencesCard } from './EmailPreferencesCard';
import { ToastProvider } from '../../lib/toast';

/**
 * E-mails do Escambo (ADR 27, 42 e 46): a frequência, a hora do resumo do dia e o fuso. Cada
 * escolha grava só o que mudou, relê a sessão e confirma com a frase do que passa a valer.
 */

const updateEmailPreference = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { updateEmailPreference: (body: unknown) => updateEmailPreference(body) },
}));

interface FakeUser {
  role: 'client' | 'freelancer';
  emailFrequency?: 'instant' | 'daily' | 'off';
  digestHour?: number;
  timezone?: string;
}
const auth = {
  user: null as FakeUser | null,
  refreshUser: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

const wrap = (ui: ReactNode) => <ToastProvider>{ui}</ToastProvider>;

const radio = (name: RegExp): HTMLElement => screen.getByRole('radio', { name });
const hourField = (): HTMLElement => screen.getByLabelText('Horário do resumo do dia');
const zoneField = (): HTMLElement => screen.getByLabelText('Fuso horário');

beforeEach(() => {
  updateEmailPreference.mockReset();
  updateEmailPreference.mockResolvedValue(undefined);
  auth.refreshUser.mockClear();
  auth.user = {
    role: 'client',
    emailFrequency: 'instant',
    digestHour: 8,
    timezone: 'America/Sao_Paulo',
  };
});

describe('cartão de e-mails: o que a tela mostra', () => {
  it('marca a frequência gravada e mostra a hora e o fuso da conta', () => {
    auth.user = {
      role: 'client',
      emailFrequency: 'daily',
      digestHour: 18,
      timezone: 'America/Manaus',
    };
    render(wrap(<EmailPreferencesCard />));

    expect(screen.getByRole('region', { name: 'E-mails do Escambo' })).toHaveTextContent(
      'as notificações no app continuam iguais',
    );
    const grupo = screen.getByRole('group', { name: 'Frequência dos e-mails de notificação' });
    expect(
      within(grupo).getByText(
        'um e-mail na hora para proposta, aceite, entrega, pagamento, prazo, troca e disputa',
      ),
    ).toBeInTheDocument();
    expect(
      within(grupo).getByText(
        'apenas confirmação de e-mail e redefinição de senha; o resto fica em Notificações',
      ),
    ).toBeInTheDocument();
    expect(
      within(grupo)
        .getAllByRole('radio')
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual(['instant', 'daily', 'off']);
    expect(radio(/^Resumo diário/)).toBeChecked();
    expect(radio(/^A cada evento/)).not.toBeChecked();
    expect(radio(/^Só o essencial/)).not.toBeChecked();
    // A dica do resumo diário diz a hora que está gravada, não uma hora fixa.
    expect(
      screen.getByText(
        'um e-mail por dia, às 18:00, com tudo o que aconteceu desde o resumo anterior',
      ),
    ).toBeInTheDocument();
    expect(hourField()).toHaveValue('18');
    expect(zoneField()).toHaveValue('America/Manaus');
    expect(within(zoneField()).getByRole('option', { name: 'Manaus (UTC−4)' })).toBeInTheDocument();
    expect(hourField()).toHaveAccessibleDescription(
      'Horário de Manaus. Vale para o resumo por e-mail, para as buscas salvas com alerta diário, para o silêncio dos avisos no navegador e para as datas nos avisos.',
    );
  });

  it('sem escolha gravada vale o padrão: a cada evento, 08:00, Brasília', () => {
    auth.user = null;
    render(wrap(<EmailPreferencesCard />));

    expect(radio(/^A cada evento/)).toBeChecked();
    expect(hourField()).toHaveValue('8');
    expect(zoneField()).toHaveValue('America/Sao_Paulo');
    expect(hourField()).toHaveAccessibleDescription(/^Horário de Brasília\./);
  });

  it('oferece as 24 horas cheias e os cinco fusos do Brasil', () => {
    render(wrap(<EmailPreferencesCard />));

    const horas = within(hourField())
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(horas).toHaveLength(24);
    expect(horas[0]).toBe('00:00');
    expect(horas[23]).toBe('23:00');
    expect(
      within(zoneField())
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Fernando de Noronha (UTC−2)',
      'Brasília (UTC−3)',
      'Cuiabá e Campo Grande (UTC−4)',
      'Manaus (UTC−4)',
      'Rio Branco (UTC−5)',
    ]);
  });

  it('para freelancer, a dica do fuso avisa que ele vale também para a agenda de atendimento', () => {
    auth.user = { ...auth.user!, role: 'freelancer' };
    render(wrap(<EmailPreferencesCard />));

    expect(zoneField()).toHaveAccessibleDescription(
      'Horário de Brasília. Vale para o resumo por e-mail, para as buscas salvas com alerta diário, para o silêncio dos avisos no navegador, para as datas nos avisos e para os dias e períodos em que você atende.',
    );
  });
});

describe('cartão de e-mails: gravar a frequência', () => {
  it('resumo diário grava só a frequência, relê a sessão e confirma com a hora do resumo', async () => {
    const user = userEvent.setup();
    auth.user = { ...auth.user!, digestHour: 7 };
    render(wrap(<EmailPreferencesCard />));

    await user.click(radio(/^Resumo diário/));

    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ emailFrequency: 'daily' });
    expect(await screen.findByText('Pronto: um resumo por dia, às 07:00.')).toBeInTheDocument();
    expect(auth.refreshUser).toHaveBeenCalledTimes(1);
  });

  it('só o essencial avisa que as novidades ficam em Notificações', async () => {
    const user = userEvent.setup();
    render(wrap(<EmailPreferencesCard />));

    await user.click(radio(/^Só o essencial/));

    expect(updateEmailPreference).toHaveBeenCalledWith({ emailFrequency: 'off' });
    expect(
      await screen.findByText('Pronto: só e-mails essenciais. As novidades ficam em Notificações.'),
    ).toBeInTheDocument();
  });

  it('voltar para um e-mail a cada evento grava e confirma', async () => {
    const user = userEvent.setup();
    auth.user = { ...auth.user!, emailFrequency: 'off' };
    render(wrap(<EmailPreferencesCard />));

    await user.click(radio(/^A cada evento/));

    expect(updateEmailPreference).toHaveBeenCalledWith({ emailFrequency: 'instant' });
    expect(await screen.findByText('Pronto: um e-mail a cada evento.')).toBeInTheDocument();
  });

  it('clicar na frequência que já vale não grava nada', async () => {
    const user = userEvent.setup();
    render(wrap(<EmailPreferencesCard />));

    await user.click(radio(/^A cada evento/));

    expect(updateEmailPreference).not.toHaveBeenCalled();
    expect(auth.refreshUser).not.toHaveBeenCalled();
  });
});

describe('cartão de e-mails: gravar a hora e o fuso', () => {
  it('trocar a hora grava só a hora e confirma com o fuso da conta', async () => {
    const user = userEvent.setup();
    auth.user = { ...auth.user!, timezone: 'America/Rio_Branco' };
    render(wrap(<EmailPreferencesCard />));

    await user.selectOptions(hourField(), '18');

    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ digestHour: 18 });
    expect(
      await screen.findByText('Pronto: seu resumo do dia sai às 18:00, horário de Rio Branco.'),
    ).toBeInTheDocument();
    expect(auth.refreshUser).toHaveBeenCalledTimes(1);
  });

  it('escolher de novo a mesma hora não grava', async () => {
    const user = userEvent.setup();
    render(wrap(<EmailPreferencesCard />));

    await user.selectOptions(hourField(), '8');

    expect(updateEmailPreference).not.toHaveBeenCalled();
  });

  it('trocar o fuso, para cliente, vale no resumo e nos avisos', async () => {
    const user = userEvent.setup();
    render(wrap(<EmailPreferencesCard />));

    await user.selectOptions(zoneField(), 'America/Manaus');

    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ timezone: 'America/Manaus' });
    expect(
      await screen.findByText('Pronto: horário de Manaus no resumo do dia e nos avisos.'),
    ).toBeInTheDocument();
  });

  it('trocar o fuso, para freelancer, avisa que a agenda muda junto', async () => {
    const user = userEvent.setup();
    auth.user = { ...auth.user!, role: 'freelancer' };
    render(wrap(<EmailPreferencesCard />));

    await user.selectOptions(zoneField(), 'America/Noronha');

    expect(updateEmailPreference).toHaveBeenCalledWith({ timezone: 'America/Noronha' });
    expect(
      await screen.findByText(
        'Pronto: horário de Fernando de Noronha no resumo do dia, nos avisos e na sua agenda.',
      ),
    ).toBeInTheDocument();
  });

  it('escolher de novo o mesmo fuso não grava', async () => {
    const user = userEvent.setup();
    render(wrap(<EmailPreferencesCard />));

    await user.selectOptions(zoneField(), 'America/Sao_Paulo');

    expect(updateEmailPreference).not.toHaveBeenCalled();
  });
});

describe('cartão de e-mails: enquanto grava e quando a API recusa', () => {
  it('durante a gravação tudo fica desabilitado e volta ao terminar', async () => {
    const user = userEvent.setup();
    let solta!: () => void;
    updateEmailPreference.mockImplementation(() => new Promise<void>((r) => (solta = r)));
    render(wrap(<EmailPreferencesCard />));

    await user.click(radio(/^Resumo diário/));

    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
    expect(hourField()).toBeDisabled();
    expect(zoneField()).toBeDisabled();
    // Nada foi confirmado antes de a API responder.
    expect(screen.queryByText(/^Pronto:/)).not.toBeInTheDocument();
    expect(auth.refreshUser).not.toHaveBeenCalled();

    solta();
    await waitFor(() => expect(hourField()).not.toBeDisabled());
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeDisabled();
    expect(zoneField()).not.toBeDisabled();
  });

  it('recusa da API: mostra a mensagem dela, não relê a sessão e libera para tentar de novo', async () => {
    const user = userEvent.setup();
    updateEmailPreference.mockRejectedValue(new Error('Hora do resumo inválida'));
    render(wrap(<EmailPreferencesCard />));

    await user.selectOptions(hourField(), '9');

    expect(await screen.findByText('Hora do resumo inválida')).toBeInTheDocument();
    expect(screen.queryByText(/^Pronto:/)).not.toBeInTheDocument();
    expect(auth.refreshUser).not.toHaveBeenCalled();
    expect(hourField()).not.toBeDisabled();
  });

  it('falha sem mensagem cai no texto padrão', async () => {
    const user = userEvent.setup();
    updateEmailPreference.mockRejectedValue('sem rede');
    render(wrap(<EmailPreferencesCard />));

    await user.click(radio(/^Só o essencial/));

    expect(await screen.findByText('Não foi possível salvar')).toBeInTheDocument();
  });
});
