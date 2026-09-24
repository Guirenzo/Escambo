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

const consent = (version: string): Consent => ({
  type: 'privacy_policy',
  version,
  accepted: true,
  at: '2026-09-09T12:00:00.000Z',
});

beforeEach(() => {
  recordConsent.mockReset();
  recordConsent.mockResolvedValue(undefined);
});

/** A faixa da Política 1.3 (ADR 54): resume, aponta o texto e registra a resposta. */
describe('LegalUpdateBanner', () => {
  it('resume o que mudou desde a versão respondida e leva ao histórico', () => {
    render(wrap(<LegalUpdateBanner consents={[consent('1.2')]} />));
    const region = screen.getByRole('region', { name: 'Atualização da Política de Privacidade' });
    expect(region).toHaveTextContent('versão 1.3');
    expect(region).toHaveTextContent('avisos no navegador');
    expect(region).not.toHaveTextContent('Cópia de dados baixável'); // isso é da 1.2, já respondida
    const link = screen.getByRole('link', { name: 'Ler a política' });
    expect(link).toHaveAttribute('href', '/privacidade#historico');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('quem está na 1.1 ouve também o resumo da 1.2', () => {
    render(wrap(<LegalUpdateBanner consents={[consent('1.1')]} />));
    expect(screen.getByRole('region')).toHaveTextContent('Cópia de dados baixável');
  });

  it('"Li e aceito" registra a versão nova como aceita', async () => {
    const user = userEvent.setup();
    render(wrap(<LegalUpdateBanner consents={[consent('1.2')]} />));
    await user.click(screen.getByRole('button', { name: 'Li e aceito' }));
    expect(recordConsent).toHaveBeenCalledWith({
      type: 'privacy_policy',
      version: '1.3',
      accepted: true,
    });
    expect(await screen.findByText(/fica registrada nos seus consentimentos/)).toBeInTheDocument();
  });

  it('"Não aceito" também registra, com accepted false, e diz o que dá para fazer', async () => {
    const user = userEvent.setup();
    render(wrap(<LegalUpdateBanner consents={[]} />));
    await user.click(screen.getByRole('button', { name: 'Não aceito' }));
    expect(recordConsent).toHaveBeenCalledWith({
      type: 'privacy_policy',
      version: '1.3',
      accepted: false,
    });
    expect(await screen.findByText(/desligar os avisos no navegador/)).toBeInTheDocument();
  });

  it('erro ao registrar: avisa e a faixa continua', async () => {
    const user = userEvent.setup();
    recordConsent.mockRejectedValue(new Error('rede'));
    render(wrap(<LegalUpdateBanner consents={[consent('1.2')]} />));
    await user.click(screen.getByRole('button', { name: 'Li e aceito' }));
    expect(await screen.findByText(/a faixa volta na próxima vez/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Li e aceito' })).not.toBeDisabled(),
    );
  });
});
