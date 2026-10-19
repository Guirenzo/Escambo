import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Consent } from '@escambo/types';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LegalUpdateBanner } from './LegalUpdateBanner';
import { ToastProvider } from '../../lib/toast';

const recordConsent = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { recordConsent: (body: unknown) => recordConsent(body) },
}));

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

const consent = (version: string, type: Consent['type'] = 'privacy_policy'): Consent => ({
  type,
  version,
  accepted: true,
  at: '2026-09-09T12:00:00.000Z',
});

beforeEach(() => {
  recordConsent.mockReset();
  recordConsent.mockResolvedValue(undefined);
});

/** A faixa da Política vigente (ADR 54 e 56): resume, aponta o texto e registra a resposta. */
describe('LegalUpdateBanner', () => {
  it('quem respondeu a 1.5 recebe só a mudança de suporte da 1.6', () => {
    render(wrap(<LegalUpdateBanner kind="privacidade" consents={[consent('1.5')]} />));
    const region = screen.getByRole('region');
    expect(region).toHaveTextContent('Suporte privado na plataforma');
    expect(region).toHaveTextContent('sem notas internas (formato 1.9)');
    expect(region).not.toHaveTextContent('últimos 60 dias');
    expect(region).not.toHaveTextContent('o que sai mesmo durante o silêncio');
  });
  it('resume o que mudou desde a versão respondida e leva ao histórico', () => {
    render(wrap(<LegalUpdateBanner kind="privacidade" consents={[consent('1.4')]} />));
    const region = screen.getByRole('region', { name: 'Atualização da Política de Privacidade' });
    expect(region).toHaveTextContent('versão 1.6, 15/10/2026');
    expect(region).toHaveTextContent('Suporte privado na plataforma');
    expect(region).toHaveTextContent('últimos 60 dias');
    expect(region).toHaveTextContent('sem dizer qual contratação, com quem nem quando');
    expect(region).toHaveTextContent('não depende do seu aceite');
    expect(region).not.toHaveTextContent('o que sai mesmo durante o silêncio');
    expect(region).not.toHaveTextContent('Seção nova sobre alterações'); // isso é da 1.3, já respondida
    const link = screen.getByRole('link', { name: 'Ler a política' });
    expect(link).toHaveAttribute('href', '/privacidade#historico');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('quem está na 1.1 ouve também o resumo da 1.2 e da 1.3', () => {
    render(wrap(<LegalUpdateBanner kind="privacidade" consents={[consent('1.1')]} />));
    expect(screen.getByRole('region')).toHaveTextContent('Cópia de dados baixável');
    expect(screen.getByRole('region')).toHaveTextContent('Seção nova sobre alterações');
  });

  it('"Li e aceito" registra a versão nova como aceita', async () => {
    const user = userEvent.setup();
    render(wrap(<LegalUpdateBanner kind="privacidade" consents={[consent('1.2')]} />));
    await user.click(screen.getByRole('button', { name: 'Li e aceito' }));
    expect(recordConsent).toHaveBeenCalledWith({
      type: 'privacy_policy',
      version: '1.6',
      accepted: true,
    });
    expect(await screen.findByText(/fica registrada nos seus consentimentos/)).toBeInTheDocument();
  });

  it('"Não aceito" também registra, com accepted false, e diz o que dá para fazer', async () => {
    const user = userEvent.setup();
    render(wrap(<LegalUpdateBanner kind="privacidade" consents={[]} />));
    await user.click(screen.getByRole('button', { name: 'Não aceito' }));
    expect(recordConsent).toHaveBeenCalledWith({
      type: 'privacy_policy',
      version: '1.6',
      accepted: false,
    });
    expect(await screen.findByText(/escolher o que sai no silêncio/)).toBeInTheDocument();
    expect(screen.getByText(/As desistências continuam na contagem/)).toBeInTheDocument();
    expect(screen.getByText(/você pode contestá-las no Perfil/)).toBeInTheDocument();
  });

  it('Termos 1.6: faixa informativa, sem "Não aceito"; "Li e aceito" registra a 1.6', async () => {
    const user = userEvent.setup();
    render(wrap(<LegalUpdateBanner kind="termos" consents={[consent('1.4', 'terms_of_use')]} />));
    const region = screen.getByRole('region', { name: 'Atualização dos Termos de Uso' });
    expect(region).toHaveTextContent(
      'Os Termos de Uso mudaram (versão 1.6, 15/10/2026): Atendimento pelo menu Suporte',
    );
    expect(region).toHaveTextContent('até 5 ofertas em 3 rodadas');
    expect(region).toHaveTextContent('até 2 sem custo por entrega');
    expect(region).toHaveTextContent('sempre pelo menos 24 horas antes da aprovação automática');
    // O que mudou nas versões 1.4 e anteriores a pessoa já respondeu: não volta.
    expect(region).not.toHaveTextContent('O lembrete é um aviso a mais e não muda nenhuma hora.');
    expect(region).not.toHaveTextContent(
      'a disputa automática só vale enquanto há trabalho nunca entregue',
    );
    expect(region).toHaveTextContent('Continuar usando o Escambo vale como aceite (seção 7)');
    expect(screen.getByRole('link', { name: 'Ler os termos' })).toHaveAttribute(
      'href',
      '/termos#historico',
    );
    expect(screen.queryByRole('button', { name: 'Não aceito' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Li e aceito' }));
    expect(recordConsent).toHaveBeenCalledTimes(1);
    expect(recordConsent).toHaveBeenCalledWith({
      type: 'terms_of_use',
      version: '1.6',
      accepted: true,
    });
    expect(
      await screen.findByText(
        'Pronto: a versão 1.6 dos Termos fica registrada nos seus consentimentos, no Perfil.',
      ),
    ).toBeInTheDocument();
  });

  it('quem ainda está nos Termos 1.2 ouve a 1.6, a 1.5 e depois a 1.4 e a 1.3', () => {
    render(wrap(<LegalUpdateBanner kind="termos" consents={[consent('1.2', 'terms_of_use')]} />));
    const region = screen.getByRole('region', { name: 'Atualização dos Termos de Uso' });
    expect(region).toHaveTextContent('até 5 ofertas em 3 rodadas');
    expect(region).toHaveTextContent('inclusive durante a suspensão');
    expect(region).toHaveTextContent(
      'O lembrete é um aviso a mais e não muda nenhuma hora. A aprovação automática passa a avisar as duas partes, e a revisão parada há 7 dias também. Antes disso, na versão anterior: Prazos: nada automático acontece de madrugada',
    );
  });

  it('erro ao registrar: avisa e a faixa continua', async () => {
    const user = userEvent.setup();
    recordConsent.mockRejectedValue(new Error('rede'));
    render(wrap(<LegalUpdateBanner kind="privacidade" consents={[consent('1.2')]} />));
    await user.click(screen.getByRole('button', { name: 'Li e aceito' }));
    expect(await screen.findByText(/a faixa volta na próxima vez/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Li e aceito' })).not.toBeDisabled(),
    );
  });
});
