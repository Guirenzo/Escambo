import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PushCard } from './PushCard';
import { ToastProvider } from '../../lib/toast';

/**
 * Avisos no navegador (ADR 52): o que o cartão afirma sobre o servidor. Canal desligado e consulta
 * que falhou parecem iguais na resposta (sem chave pública), e afirmar "desligado" numa falha
 * seria mentir sobre a configuração de quem está do outro lado.
 */

const pushStatus = vi.fn();

vi.mock('../../lib/api', () => ({
  api: {
    pushStatus: (endpoint?: string) => pushStatus(endpoint),
    pushSubscribe: vi.fn(),
    pushUnsubscribe: vi.fn(),
    pushTest: vi.fn(),
  },
}));

const wrap = (ui: ReactNode) => <ToastProvider>{ui}</ToastProvider>;

beforeEach(() => {
  pushStatus.mockReset();
});

describe('cartão de avisos no navegador', () => {
  it('canal desligado no servidor: explica e não conta aparelhos', async () => {
    pushStatus.mockResolvedValue({ publicKey: '', devices: 0, subscribed: false });
    render(wrap(<PushCard />));

    expect(await screen.findByText(/desligados neste servidor/)).toBeInTheDocument();
    expect(screen.queryByTestId('push-devices')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ligar avisos/ })).not.toBeInTheDocument();
  });

  it('consulta que falha não vira "desligado no servidor": o botão continua lá', async () => {
    pushStatus.mockRejectedValue(new Error('rede fora do ar'));
    render(wrap(<PushCard />));

    // Sem suporte a push no jsdom, o cartão cai no texto de "este navegador não recebe avisos" —
    // o que importa é não afirmar que o servidor está com o canal desligado.
    expect(await screen.findByTestId('push-card')).toBeInTheDocument();
    expect(screen.queryByText(/desligados neste servidor/)).not.toBeInTheDocument();
  });
});
