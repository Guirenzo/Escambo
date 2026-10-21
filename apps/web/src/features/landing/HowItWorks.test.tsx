import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { HowItWorks } from './HowItWorks';

/**
 * "Como funciona" em abas (padrão de abas do ARIA): uma aba por lado, setas e Home/End mudam a aba,
 * só a escolhida fica no Tab, cada painel tem os passos e uma tela do app (decorativa). As chamadas
 * de cadastro ficam fora das abas, sempre à vista.
 */

const renderHow = (barter = true, fee: number | null = 15) =>
  render(
    <MemoryRouter>
      <HowItWorks barter={barter} fee={fee} />
    </MemoryRouter>,
  );

describe('HowItWorks', () => {
  it('três abas, a primeira escolhida, e só ela no Tab', () => {
    renderHow();
    const list = screen.getByRole('tablist', { name: 'Escolha o seu lado' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Contratar', 'Oferecer', 'Trocar']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAccessibleName('Contratar');
    expect(tabs[0]).toHaveAttribute('aria-controls', panel.id);
    expect(within(panel).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Para quem contrata',
    );
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
    // A tela do app é ilustração.
    expect(panel.querySelector('.lp-screen-fig')).toHaveAttribute('aria-hidden', 'true');
    expect(within(panel).getByRole('link', { name: 'Ver as garantias' })).toHaveAttribute(
      'href',
      '#garantia',
    );
  });

  it('setas, Home e End trocam de aba e levam o foco junto', async () => {
    const user = userEvent.setup();
    renderHow();
    await user.click(screen.getByRole('tab', { name: 'Contratar' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Oferecer' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Oferecer');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Carteira');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Trocar' })).toHaveAttribute('aria-selected', 'true');
    const trade = screen.getByRole('tabpanel');
    expect(trade).toHaveTextContent('com 15% de taxa só sobre ela');
    expect(within(trade).getByRole('link', { name: 'Simular a torna' })).toHaveAttribute(
      'href',
      '#troca',
    );
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Contratar' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Contratar' })).toHaveAttribute('aria-selected', 'true');
  });

  it('os outros painéis ficam escondidos (fora da leitura e do Tab)', () => {
    renderHow();
    const hidden = document.querySelectorAll('[role="tabpanel"][hidden]');
    expect(hidden).toHaveLength(2);
  });

  it('sem a troca no painel: duas abas e o "Oferecer" sem a troca', async () => {
    const user = userEvent.setup();
    renderHow(false, null);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Contratar', 'Oferecer']);
    await user.click(screen.getByRole('tab', { name: 'Oferecer' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Em dinheiro ou em créditos Escambo.');
  });

  it('sem a taxa, a aba da troca não cita número', async () => {
    const user = userEvent.setup();
    renderHow(true, null);
    await user.click(screen.getByRole('tab', { name: 'Trocar' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('com a taxa da plataforma só sobre ela');
  });

  it('as chamadas de cadastro ficam fora das abas, cada uma com o seu lado', () => {
    renderHow();
    expect(screen.getByRole('link', { name: /Criar conta de cliente/ })).toHaveAttribute(
      'href',
      '/cadastro?perfil=cliente',
    );
    expect(screen.getByRole('link', { name: /Criar conta de freelancer/ })).toHaveAttribute(
      'href',
      '/cadastro?perfil=freelancer',
    );
    expect(
      screen.getByRole('link', { name: /Criar conta de cliente/ }).closest('[role="tabpanel"]'),
    ).toBeNull();
  });
});
