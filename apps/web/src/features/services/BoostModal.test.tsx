import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BoostPlan, Service } from '@escambo/types';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { BoostModal } from './BoostModal';

const boostPlans = vi.fn();
const wallet = vi.fn();
const createBoost = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    boostPlans: () => boostPlans(),
    wallet: () => wallet(),
    createBoost: (body: unknown) => createBoost(body),
  },
}));

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

const service = { id: 7, title: 'Logo profissional' } as unknown as Service;

const plan = (o: Partial<BoostPlan>): BoostPlan => ({
  id: 1,
  name: 'Básico',
  description: null,
  durationDays: 7,
  price: 20,
  costCredits: 20,
  features: null,
  ...o,
});

const PLANS = [
  plan({ id: 1, name: 'Básico', durationDays: 7, costCredits: 20 }),
  plan({
    id: 2,
    name: 'Turbo',
    durationDays: 15,
    costCredits: 40,
    description: 'Selo de destaque no card',
  }),
  plan({ id: 3, name: 'Premium', durationDays: 30, costCredits: 90 }),
];

const walletWith = (credits: number) => ({
  balance: 0,
  balancePending: 0,
  currency: 'BRL',
  credits,
  creditsPending: 0,
});

beforeEach(() => {
  boostPlans.mockReset();
  boostPlans.mockResolvedValue(PLANS);
  wallet.mockReset();
  wallet.mockResolvedValue(walletWith(50));
  createBoost.mockReset();
  createBoost.mockResolvedValue({ id: 99 });
});

/** Espera os planos e a carteira: a frase do topo diz quantos créditos a pessoa tem. */
async function ready(credits: number): Promise<void> {
  await screen.findByRole('radiogroup', { name: 'Plano de impulsionamento' });
  await waitFor(() =>
    expect(screen.getByText(/Você paga com créditos Escambo/)).toHaveTextContent(
      `Você paga com créditos Escambo — tem ${credits} disponíveis.`,
    ),
  );
}

/** Impulsionar um serviço: escolhe um plano que os créditos pagam e confirma. */
describe('BoostModal', () => {
  it('mostra o serviço, os créditos disponíveis e cada plano com duração e custo', async () => {
    render(wrap(<BoostModal service={service} onClose={vi.fn()} />));

    expect(screen.getByRole('dialog', { name: 'Impulsionar: Logo profissional' })).toBeVisible();
    // Enquanto os planos não chegam, o esqueleto de carregamento ocupa o lugar deles.
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();

    const group = await screen.findByRole('radiogroup', { name: 'Plano de impulsionamento' });
    expect(screen.queryByRole('status', { name: 'Carregando' })).not.toBeInTheDocument();
    expect(group).toHaveTextContent('Básico7 dias · 20 créditos');
    expect(group).toHaveTextContent('Turbo15 dias · 40 créditosSelo de destaque no card');
    await ready(50);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('sem plano escolhido não dá para confirmar', async () => {
    const user = userEvent.setup();
    render(wrap(<BoostModal service={service} onClose={vi.fn()} />));
    await screen.findByRole('radio', { name: /Básico/ });

    const confirm = screen.getByRole('button', { name: 'Confirmar impulsionamento' });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(createBoost).not.toHaveBeenCalled();
  });

  it('plano mais caro que o saldo de créditos fica desabilitado e diz por quê', async () => {
    const user = userEvent.setup();
    render(wrap(<BoostModal service={service} onClose={vi.fn()} />));
    await ready(50);

    const premium = screen.getByRole('radio', { name: /Premium/ });
    expect(premium).toBeDisabled();
    expect(premium).toHaveAccessibleName(/30 dias · 90 créditos · créditos insuficientes/);
    expect(screen.getByRole('radio', { name: /Turbo/ })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /Turbo/ })).not.toHaveAccessibleName(
      /créditos insuficientes/,
    );

    await user.click(premium);
    expect(premium).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Confirmar impulsionamento' })).toBeDisabled();
  });

  it('créditos iguais ao custo do plano bastam para escolhê-lo', async () => {
    const user = userEvent.setup();
    wallet.mockResolvedValue(walletWith(40));
    render(wrap(<BoostModal service={service} onClose={vi.fn()} />));
    await ready(40);

    const turbo = screen.getByRole('radio', { name: /Turbo/ });
    expect(turbo).toBeEnabled();
    expect(turbo).not.toHaveAccessibleName(/créditos insuficientes/);
    await user.click(turbo);
    expect(turbo).toBeChecked();
    expect(screen.getByRole('button', { name: 'Confirmar impulsionamento' })).toBeEnabled();
  });

  it('sem planos cadastrados não há o que escolher e o botão fica travado', async () => {
    boostPlans.mockResolvedValue([]);
    render(wrap(<BoostModal service={service} onClose={vi.fn()} />));

    await ready(50);
    expect(
      screen.getByRole('radiogroup', { name: 'Plano de impulsionamento' }),
    ).toBeEmptyDOMElement();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmar impulsionamento' })).toBeDisabled();
  });

  it('sem a carteira carregada vale zero crédito: nenhum plano pode ser escolhido', async () => {
    wallet.mockRejectedValue(new Error('fora do ar'));
    render(wrap(<BoostModal service={service} onClose={vi.fn()} />));
    await screen.findByRole('radiogroup', { name: 'Plano de impulsionamento' });

    await ready(0);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('escolher e confirmar manda o serviço e o plano, avisa, fecha e recarrega os créditos', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    // Depois de pagar o Turbo (40), sobram 10 créditos.
    wallet.mockResolvedValueOnce(walletWith(50)).mockResolvedValue(walletWith(10));
    render(wrap(<BoostModal service={service} onClose={onClose} />));
    await ready(50);

    await user.click(screen.getByRole('radio', { name: /Básico/ }));
    await user.click(screen.getByRole('radio', { name: /Turbo/ }));
    expect(screen.getByRole('radio', { name: /Turbo/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Básico/ })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Confirmar impulsionamento' }));

    expect(createBoost).toHaveBeenCalledTimes(1);
    expect(createBoost).toHaveBeenCalledWith({ serviceId: 7, planId: 2 });
    expect(
      await screen.findByText('Serviço impulsionado! Ele já aparece no topo da busca.'),
    ).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
    // A carteira é consultada de novo: o saldo de créditos mostrado já desconta o plano.
    await ready(10);
    expect(wallet).toHaveBeenCalledTimes(2);
  });

  it('enquanto a API não responde o botão fica travado em "Impulsionando…"', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let release!: (v: unknown) => void;
    createBoost.mockImplementation(() => new Promise((r) => (release = r)));
    render(wrap(<BoostModal service={service} onClose={onClose} />));
    await ready(50);

    await user.click(screen.getByRole('radio', { name: /Básico/ }));
    await user.click(screen.getByRole('button', { name: 'Confirmar impulsionamento' }));

    const busy = await screen.findByRole('button', { name: 'Impulsionando…' });
    expect(busy).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();

    release({ id: 99 });
    await screen.findByText('Serviço impulsionado! Ele já aparece no topo da busca.');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('API recusa: mostra a mensagem dela e o modal continua aberto', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    createBoost.mockRejectedValue(new Error('Este serviço já está impulsionado.'));
    render(wrap(<BoostModal service={service} onClose={onClose} />));
    await ready(50);

    await user.click(screen.getByRole('radio', { name: /Básico/ }));
    await user.click(screen.getByRole('button', { name: 'Confirmar impulsionamento' }));

    expect(await screen.findByText('Este serviço já está impulsionado.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // Dá para tentar de novo: o botão volta ao estado normal.
    expect(screen.getByRole('button', { name: 'Confirmar impulsionamento' })).toBeEnabled();
  });

  it('falha sem mensagem vira "Erro ao impulsionar"', async () => {
    const user = userEvent.setup();
    createBoost.mockRejectedValue('timeout');
    render(wrap(<BoostModal service={service} onClose={vi.fn()} />));
    await ready(50);

    await user.click(screen.getByRole('radio', { name: /Básico/ }));
    await user.click(screen.getByRole('button', { name: 'Confirmar impulsionamento' }));

    expect(await screen.findByText('Erro ao impulsionar')).toBeInTheDocument();
  });

  it('planos que não carregam: mostra o erro e "Tentar de novo" busca outra vez', async () => {
    const user = userEvent.setup();
    boostPlans.mockRejectedValueOnce(new Error('Não deu para carregar os planos.'));
    render(wrap(<BoostModal service={service} onClose={vi.fn()} />));

    expect(await screen.findByRole('alert')).toHaveTextContent('Não deu para carregar os planos.');
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(boostPlans).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('radio', { name: /Turbo/ })).toBeInTheDocument();
    expect(boostPlans).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('o ✕ fecha sem impulsionar nada', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(wrap(<BoostModal service={service} onClose={onClose} />));
    await screen.findByRole('radiogroup', { name: 'Plano de impulsionamento' });

    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createBoost).not.toHaveBeenCalled();
  });
});
